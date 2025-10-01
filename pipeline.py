# pipeline_simple.py
# Simple ingestion: embed small resources (<100 MB) into `documents`,
# store large resources (>100 MB) into `large_files`.
#
# Requirements: python3.11+, pip install -r requirements.txt
# Required env vars:
#   POSTGRES_URL
#   OPENAI_API_KEY
#   GOOGLE_SHEET_ID
#   GOOGLE_APPLICATION_CREDENTIALS_JSON  (full JSON string, see note below)
#
# Usage: python pipeline_simple.py

import os
import json
import time
import hashlib
from urllib.parse import urlparse
from io import BytesIO
import requests
import psycopg2
from dotenv import load_dotenv
from bs4 import BeautifulSoup
from PyPDF2 import PdfReader
import openai
import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

load_dotenv()

POSTGRES_URL = os.getenv("POSTGRES_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_SA_JSON = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")

# Tunables
EMBED_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBED_BATCH = int(os.getenv("EMBED_BATCH", "32"))
CHUNK_CHARS = int(os.getenv("CHUNK_CHARS", "1200"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "200"))
MAX_SIZE_BYTES = int(os.getenv("MAX_SIZE_BYTES", str(100 * 1024 * 1024)))  # 100 MB
MIN_TEXT_LEN = 200  # ignore tiny pages

if not all([POSTGRES_URL, OPENAI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SA_JSON]):
    raise SystemExit("Missing one of POSTGRES_URL, OPENAI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS_JSON")

openai.api_key = OPENAI_API_KEY

def sha1(s): return hashlib.sha1(s.encode("utf-8")).hexdigest()

def url_domain(u):
    try:
        return urlparse(u).netloc.lower()
    except:
        return None

def get_google_creds():
    info = json.loads(GOOGLE_SA_JSON)
    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly",
              "https://www.googleapis.com/auth/documents.readonly",
              "https://www.googleapis.com/auth/drive.readonly"]
    return Credentials.from_service_account_info(info, scopes=scopes)

def fetch_head_size(url, timeout=10):
    try:
        r = requests.head(url, allow_redirects=True, timeout=timeout, headers={"User-Agent":"Mozilla/5.0"})
        if r.status_code >= 400:
            return None
        cl = r.headers.get("Content-Length")
        if cl:
            try:
                return int(cl)
            except:
                return None
        return None
    except Exception:
        return None

def download_if_small(url, max_bytes=MAX_SIZE_BYTES, timeout=60):
    """
    Streams download but aborts if > max_bytes.
    Returns: {"ok": True, "content": bytes, "size": n, "content_type": ct}
             or {"ok": False, "reason": "too_large"|"error", "size": n}
    """
    headers = {"User-Agent":"Mozilla/5.0"}
    try:
        r = requests.get(url, headers=headers, stream=True, timeout=timeout)
        r.raise_for_status()
        ct = r.headers.get("Content-Type","")
        total = 0
        buf = BytesIO()
        for chunk in r.iter_content(chunk_size=8192):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                return {"ok": False, "reason": "too_large", "size": total, "content_type": ct}
            buf.write(chunk)
        return {"ok": True, "content": buf.getvalue(), "size": total, "content_type": ct}
    except Exception as e:
        return {"ok": False, "reason": "error", "error": str(e)}

def extract_text_from_html_bytes(bts):
    try:
        soup = BeautifulSoup(bts, "html.parser")
        # try to get main article if present
        main = soup.select_one("article, div.main-content, div#content, div.content, div[role='main']")
        if main:
            for el in main.select("nav, header, footer, script, style, .sidebar, .footer"):
                el.decompose()
            text = main.get_text(separator="\n", strip=True)
        else:
            text = soup.get_text(separator="\n", strip=True)
        title = soup.title.string.strip() if soup.title and soup.title.string else None
        return title or None, text
    except Exception:
        return None, ""

def extract_text_from_pdf_bytes(bts):
    try:
        reader = PdfReader(BytesIO(bts))
        out = []
        for p in reader.pages:
            t = p.extract_text()
            if t:
                out.append(t)
        text = "\n".join(out)
        title = None
        return title, text
    except Exception:
        return None, ""

def chunk_text(text, chunk_chars=CHUNK_CHARS, overlap=CHUNK_OVERLAP):
    if not text: return []
    parts = []
    i = 0
    L = len(text)
    step = max(1, chunk_chars - overlap)
    while i < L:
        parts.append(text[i:i+chunk_chars].strip())
        i += step
    return parts

def embed_batch(texts):
    # returns list of embeddings
    resp = openai.embeddings.create(model=EMBED_MODEL, input=texts)
    return [d.embedding for d in resp.data]

def insert_chunk(conn, row):
    """
    row keys (recommended): source_title, source_url, source_domain, content, chunk_hash, scraped_at
    embedding must be string like '[0.1,0.2,...]' as we cast to ::vector in SQL
    """
    with conn.cursor() as cur:
        cols = []
        vals = []
        placeholders = []
        for k,v in row.items():
            cols.append(k)
            placeholders.append("%s")
            vals.append(v)
        sql = f"INSERT INTO documents ({','.join(cols)}) VALUES ({','.join(placeholders)}) ON CONFLICT DO NOTHING"
        cur.execute(sql, vals)
    conn.commit()

def insert_large_file(conn, url, domain, title=None):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO large_files (source_url, source_domain, source_title, created_at)
            VALUES (%s,%s,%s, now())
            ON CONFLICT (source_url) DO UPDATE SET created_at = EXCLUDED.created_at
        """, (url, domain, title))
    conn.commit()

def process_url(conn, url):
    print("Processing:", url)
    domain = url_domain(url)
    # 1) check HEAD for size
    head_size = fetch_head_size(url)
    if head_size is not None and head_size > MAX_SIZE_BYTES:
        print(" - head content-length too large:", head_size)
        insert_large_file(conn, url, domain, None)
        return

    # 2) try download streaming but abort if too large
    dl = download_if_small(url, max_bytes=MAX_SIZE_BYTES)
    if not dl["ok"]:
        if dl.get("reason") == "too_large":
            print(" - download too large:", dl.get("size"))
            insert_large_file(conn, url, domain, None)
            return
        else:
            print(" - download error, skipping:", dl.get("error"))
            return

    bts = dl["content"]
    ct = dl.get("content_type","")
    title = None
    text = ""
    if "application/pdf" in ct or url.lower().endswith(".pdf"):
        title, text = extract_text_from_pdf_bytes(bts)
    else:
        # treat as html/text
        try:
            # decode bytes (best effort)
            text_bytes = bts.decode("utf-8", errors="replace")
        except:
            text_bytes = bts.decode("latin1", errors="replace")
        title, text = extract_text_from_html_bytes(text_bytes)

    if not text or len(text) < MIN_TEXT_LEN:
        print(" - extracted text too small, skipping")
        return

    title = title or url
    chunks = chunk_text(text)
    print(f" - chunks: {len(chunks)}")
    # embed in batches and insert
    for i in range(0, len(chunks), EMBED_BATCH):
        batch = chunks[i:i+EMBED_BATCH]
        try:
            embs = embed_batch(batch)
        except Exception as e:
            print(" - embedding failed:", e)
            time.sleep(2)
            # mark these as error and continue
            continue
        for chunk_text, emb in zip(batch, embs):
            chash = sha1(chunk_text[:2000])
            emb_literal = "[" + ",".join(map(str, emb)) + "]"
            row = {
                "source_title": title,
                "source_url": url,
                "source_domain": domain,
                "content": chunk_text,
                "chunk_hash": chash,
                "scraped_at": "now()",
                "embedding": emb_literal
            }
            try:
                insert_chunk(conn, row)
            except Exception as e:
                print(" - insert failed:", e)

def main():
    creds = get_google_creds()
    gc = gspread.authorize(creds)
    sheet = gc.open_by_key(GOOGLE_SHEET_ID).sheet1
    urls = sheet.col_values(1)[1:]  # skip header
    if not urls:
        print("No URLs in sheet")
        return

    conn = psycopg2.connect(POSTGRES_URL)
    try:
        for u in urls:
            u = u.strip()
            if not u: continue
            try:
                process_url(conn, u)
            except Exception as e:
                print("Error processing url:", u, e)
    finally:
        conn.close()

if __name__ == "__main__":
    main()
