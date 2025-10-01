# pipeline.py
# Simple ingestion + link discovery pipeline
# Requirements: requests, beautifulsoup4, gspread, google-auth, google-api-python-client, PyPDF2, psycopg2-binary, openai, python-dotenv
#
# Env vars required:
#   POSTGRES_URL
#   OPENAI_API_KEY
#   GOOGLE_SHEET_ID
#   GOOGLE_APPLICATION_CREDENTIALS_JSON   (full JSON string)
# Optional tunables:
#   EMBEDDING_MODEL (default text-embedding-3-small)
#   EMBED_BATCH (default 32)
#   CHUNK_CHARS (default 1200)
#   CHUNK_OVERLAP (default 200)
#   MAX_SIZE_BYTES (default 100*1024*1024)
#   LINK_DISCOVER_MAX (default 50)
# Usage: python pipeline.py

import os, sys, time, json, hashlib, re
from io import BytesIO
from urllib.parse import urlparse, urljoin
from datetime import datetime
import requests
from bs4 import BeautifulSoup
from PyPDF2 import PdfReader
import psycopg2
from psycopg2.extras import execute_values
import openai
import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from dotenv import load_dotenv

load_dotenv()

# Required env
POSTGRES_URL = os.getenv("POSTGRES_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_SA_JSON = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")

if not all([POSTGRES_URL, OPENAI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SA_JSON]):
    print("Missing one of POSTGRES_URL, OPENAI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS_JSON")
    sys.exit(1)

openai.api_key = OPENAI_API_KEY

# Tunables
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBED_BATCH = int(os.getenv("EMBED_BATCH", "32"))
CHUNK_CHARS = int(os.getenv("CHUNK_CHARS", "1200"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "200"))
MAX_SIZE_BYTES = int(os.getenv("MAX_SIZE_BYTES", str(100 * 1024 * 1024)))  # 100 MB
MIN_TEXT_LEN = int(os.getenv("MIN_TEXT_LEN", "200"))
LINK_DISCOVER_MAX = int(os.getenv("LINK_DISCOVER_MAX", "50"))
HEAD_TIMEOUT = float(os.getenv("HEAD_TIMEOUT", "8"))
DOWNLOAD_TIMEOUT = int(os.getenv("DOWNLOAD_TIMEOUT", "60"))

USER_AGENT = "Mozilla/5.0 (compatible; RAG-Pipeline/1.0)"

# Helpers
def sha1(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()

def domain_of(u):
    try:
        return urlparse(u).netloc.lower()
    except:
        return None

def is_root_like(u):
    # heuristic: homepage or shallow path
    parsed = urlparse(u)
    path = parsed.path or "/"
    if path == "/" or path.strip() == "":
        return True
    # short paths with few segments considered root-like
    return path.count("/") <= 2

def get_google_creds():
    info = json.loads(GOOGLE_SA_JSON)
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/documents.readonly",
    ]
    return Credentials.from_service_account_info(info, scopes=scopes)

# Link discovery: fetch root page and return same-domain candidate links
def extract_links_from_root(root_url, max_links=LINK_DISCOVER_MAX):
    try:
        headers = {"User-Agent": USER_AGENT}
        r = requests.get(root_url, headers=headers, timeout=20)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        domain = domain_of(root_url)
        found = set()
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if href.lower().startswith("javascript:") or href.lower().startswith("mailto:"):
                continue
            full = urljoin(root_url, href)
            pd = urlparse(full)
            if not pd.scheme.startswith("http"):
                continue
            if domain_of(full) != domain:
                continue
            # skip fragments and obvious junk
            if '#' in full and full.strip().endswith('#'):
                continue
            if re.search(r'(\.jpg|\.jpeg|\.png|\.gif|\.svg|/login|/signup|/search|/subscribe)', full.lower()):
                continue
            found.add(full.split('?')[0].rstrip('/'))
        arr = sorted(found)
        return arr[:max_links]
    except Exception as e:
        print("extract_links_from_root error:", e)
        return []

# HEAD check to quickly detect big files
def fetch_head_size(url):
    try:
        r = requests.head(url, headers={"User-Agent": USER_AGENT}, allow_redirects=True, timeout=HEAD_TIMEOUT)
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

# Stream download but abort if > max_bytes
def download_if_small(url, max_bytes=MAX_SIZE_BYTES, timeout=DOWNLOAD_TIMEOUT):
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, stream=True, timeout=timeout)
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

def extract_text_from_html(html_str):
    try:
        soup = BeautifulSoup(html_str, "html.parser")
        main = soup.select_one("article, div.main-content, div#content, div.content, div[role='main']")
        if main:
            for el in main.select("nav, header, footer, script, style, .sidebar, .footer, .usa-alert"):
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
        pages = []
        for p in reader.pages:
            t = p.extract_text()
            if t:
                pages.append(t)
        return None, "\n".join(pages)
    except Exception:
        return None, ""

def chunk_text(text, chunk_chars=CHUNK_CHARS, overlap=CHUNK_OVERLAP):
    if not text:
        return []
    parts = []
    step = max(1, chunk_chars - overlap)
    i = 0
    L = len(text)
    while i < L:
        parts.append(text[i:i+chunk_chars].strip())
        i += step
    return parts

# DB helpers
def connect_db():
    return psycopg2.connect(POSTGRES_URL)

def already_have_source(conn, url):
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM documents WHERE source_url = %s LIMIT 1", (url,))
        return cur.fetchone() is not None

def insert_large_file(conn, url, domain, title=None):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO large_files (source_url, source_domain, source_title, created_at)
            VALUES (%s,%s,%s, now())
            ON CONFLICT (source_url) DO UPDATE SET created_at = EXCLUDED.created_at
        """, (url, domain, title))
    conn.commit()

def insert_chunks_bulk(conn, rows):
    # rows: list of dicts with keys matching documents table columns:
    # source_title, source_url, source_domain, content, chunk_hash, scraped_at (timestamp), embedding (string literal '[...]')
    if not rows:
        return
    cols = ["source_title", "source_url", "source_domain", "content", "chunk_hash", "scraped_at", "embedding"]
    values = [[r.get(c) for c in cols] for r in rows]
    # Use execute_values for speed; embedding expected to be text like '[0.1,0.2,..]' and cast in SQL to vector
    sql = f"INSERT INTO documents ({','.join(cols)}) VALUES %s ON CONFLICT DO NOTHING"
    with conn.cursor() as cur:
        execute_values(cur, sql, values)
    conn.commit()

# Embedding wrapper
def embed_texts(texts):
    if not texts:
        return []
    resp = openai.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [d.embedding for d in resp.data]

# Google helpers
def get_sheet_urls():
    creds = get_google_creds()
    gc = gspread.authorize(creds)
    sheet = gc.open_by_key(GOOGLE_SHEET_ID).sheet1
    vals = sheet.col_values(1)
    # drop header if header-like
    if len(vals) > 0 and ("url" in vals[0].lower() or "link" in vals[0].lower()):
        vals = vals[1:]
    return [v.strip() for v in vals if v and v.strip()]

# Main processing of a single target URL
def process_target(conn, target_url):
    domain = domain_of(target_url)
    # skip if already in documents
    if already_have_source(conn, target_url):
        print("  - already in DB, skipping:", target_url)
        return

    # HEAD size quick check
    head_size = fetch_head_size(target_url)
    if head_size is not None and head_size > MAX_SIZE_BYTES:
        print("  - HEAD size > MAX, saving to large_files", head_size)
        insert_large_file(conn, target_url, domain, None)
        return

    # Download (streamed)
    dl = download_if_small(target_url, max_bytes=MAX_SIZE_BYTES)
    if not dl["ok"]:
        if dl.get("reason") == "too_large":
            print("  - download too large, saving url")
            insert_large_file(conn, target_url, domain, None)
            return
        else:
            print("  - download error:", dl.get("error"))
            return

    bts = dl["content"]
    ct = dl.get("content_type","")
    title = None
    text = ""

    # PDF?
    if "application/pdf" in ct or target_url.lower().endswith(".pdf"):
        title, text = extract_text_from_pdf_bytes(bts)
    else:
        try:
            s = bts.decode("utf-8", errors="replace")
        except:
            s = bts.decode("latin1", errors="replace")
        title, text = extract_text_from_html(s)

    if not text or len(text) < MIN_TEXT_LEN:
        print("  - extracted text too small, skipping")
        return

    title = title or target_url
    chunks = chunk_text(text)
    print(f"  - {len(chunks)} chunks extracted")

    # embed in batches
    rows_to_insert = []
    for i in range(0, len(chunks), EMBED_BATCH):
        batch = chunks[i:i+EMBED_BATCH]
        try:
            embeddings = embed_texts(batch)
        except Exception as e:
            print("  - embedding API error:", e)
            time.sleep(2)
            # skip this batch (could retry)
            continue

        for chunk_text, emb in zip(batch, embeddings):
            chash = sha1(chunk_text[:2000])
            emb_literal = "[" + ",".join(map(str, emb)) + "]"
            rows_to_insert.append({
                "source_title": title,
                "source_url": target_url,
                "source_domain": domain,
                "content": chunk_text,
                "chunk_hash": chash,
                "scraped_at": datetime.utcnow(),
                "embedding": emb_literal
            })
        # insert in smaller chunks to avoid massive transaction
        try:
            insert_chunks_bulk(conn, rows_to_insert)
            rows_to_insert = []
        except Exception as e:
            print("  - DB insert error:", e)
            # if insert fails, stop further inserts for this target
            return

    # any leftover
    if rows_to_insert:
        try:
            insert_chunks_bulk(conn, rows_to_insert)
        except Exception as e:
            print("  - DB insert error final:", e)

def main():
    print("Starting pipeline:", datetime.utcnow().isoformat())
    sheet_urls = get_sheet_urls()
    print("Found URLs in sheet:", len(sheet_urls))
    conn = connect_db()
    try:
        seen = set()
        for src in sheet_urls:
            if not src: continue
            src = src.strip()
            if src in seen:
                continue
            seen.add(src)
            print("Seed URL:", src)

            # if root-like, discover child links
            targets = [src]
            try:
                if is_root_like(src):
                    discovered = extract_links_from_root(src, max_links=LINK_DISCOVER_MAX)
                    # merge and dedupe
                    for d in discovered:
                        if d not in seen:
                            targets.append(d)
                            seen.add(d)
            except Exception as e:
                print("  - discovery failed:", e)

            # process each target
            for t in targets:
                try:
                    process_target(conn, t)
                except Exception as e:
                    print("  - processing failed:", e)
                    # continue with next target
                    continue

    finally:
        conn.close()
    print("Pipeline finished:", datetime.utcnow().isoformat())

if __name__ == "__main__":
    main()
