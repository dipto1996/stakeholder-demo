# pipeline_safe.py
# Safe ingestion pipeline: non-destructive, schema-aware, per-row error tolerant.
# Requirements: requests, beautifulsoup4, google-api-python-client, google-auth, gspread,
#               psycopg2-binary, openai, PyPDF2, python-dotenv
#
# Env vars required:
#   POSTGRES_URL
#   GOOGLE_SHEET_ID
#   OPENAI_API_KEY
#   GOOGLE_APPLICATION_CREDENTIALS_JSON (service account JSON)
# Optional:
#   EMBEDDING_MODEL (default: text-embedding-3-small)
#   MAX_PDF_DOWNLOAD_BYTES (default 50MB)
#   PDF_AUTO_APPROVE_LIMIT_BYTES (default 2MB) -> small PDFs get auto-embedded/inserted
#   CHUNK_CHARS (default 1200), CHUNK_OVERLAP (default 200)
# Run: python pipeline_safe.py

import os
import json
import time
import hashlib
import tempfile
from urllib.parse import urlparse
from io import BytesIO

import requests
from bs4 import BeautifulSoup
import psycopg2
from PyPDF2 import PdfReader
import openai
import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from dotenv import load_dotenv

load_dotenv()

# -------------------- Config --------------------
DATABASE_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_SA_JSON = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
MAX_PDF_DOWNLOAD_BYTES = int(os.getenv("MAX_PDF_DOWNLOAD_BYTES", str(50 * 1024 * 1024)))
PDF_AUTO_APPROVE_LIMIT_BYTES = int(os.getenv("PDF_AUTO_APPROVE_LIMIT_BYTES", str(2 * 1024 * 1024)))
CHUNK_CHARS = int(os.getenv("CHUNK_CHARS", "1200"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "200"))
EMBED_BATCH = int(os.getenv("EMBED_BATCH", "8"))

if not all([DATABASE_URL, GOOGLE_SHEET_ID, OPENAI_API_KEY, GOOGLE_SA_JSON]):
    raise SystemExit("Missing required env vars: POSTGRES_URL, GOOGLE_SHEET_ID, OPENAI_API_KEY, GOOGLE_APPLICATION_CREDENTIALS_JSON")

openai.api_key = OPENAI_API_KEY

# -------------------- Helpers --------------------
def sha1(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()

def canonicalize_url(u):
    try:
        p = urlparse(u)
        if not p.scheme:
            u = "https://" + u
        return u.split('?')[0].rstrip('/')
    except:
        return u

def domain_of(u):
    try:
        return urlparse(u).netloc.lower()
    except:
        return ""

def get_google_creds():
    creds_info = json.loads(GOOGLE_SA_JSON)
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents.readonly"
    ]
    return Credentials.from_service_account_info(creds_info, scopes=scopes)

def chunk_text_chars(text, chunk_chars=CHUNK_CHARS, overlap=CHUNK_OVERLAP):
    if not text:
        return []
    parts = []
    i = 0
    L = len(text)
    while i < L:
        part = text[i:i+chunk_chars].strip()
        if part:
            parts.append(part)
        i += (chunk_chars - overlap)
    return parts

def download_pdf_temp(url, max_bytes=MAX_PDF_DOWNLOAD_BYTES):
    headers = {"User-Agent": "Mozilla/5.0"}
    with requests.get(url, headers=headers, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = 0
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        try:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    total += len(chunk)
                    if total > max_bytes:
                        tmp.close()
                        os.unlink(tmp.name)
                        return {"status": "too_large", "size": total}
                    tmp.write(chunk)
            tmp.flush()
            tmp.close()
            return {"status": "ok", "path": tmp.name, "size": total}
        except Exception as e:
            try:
                tmp.close()
                os.unlink(tmp.name)
            except:
                pass
            return {"status": "error", "error": str(e)}

def extract_pdf_text(path):
    try:
        reader = PdfReader(path)
        text_chunks = []
        for p in reader.pages:
            t = p.extract_text()
            if t:
                text_chunks.append(t)
        return "\n".join(text_chunks)
    except Exception as e:
        print("pdf extract error:", e)
        return ""

def scrape_url(url):
    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        ct = r.headers.get("Content-Type","")
        if "text/html" not in ct:
            return None
        soup = BeautifulSoup(r.text, "html.parser")
        title = soup.title.string.strip() if soup.title and soup.title.string else url
        main = soup.select_one("article, div.main-content, div#content, div.content, div[role='main']")
        if main:
            for el in main.select("nav, header, footer, script, style, .sidebar, .footer, .usa-alert"):
                el.decompose()
            text = main.get_text(separator="\n", strip=True)
        else:
            text = soup.get_text(separator="\n", strip=True)
        size = len(r.content)
        return {"title": title, "text": text, "size": size}
    except Exception as e:
        print("scrape error:", e)
        return None

def read_google_doc(service, doc_id):
    try:
        doc = service.documents().get(documentId=doc_id, fields="title,body").execute()
        title = doc.get("title","Google Doc")
        text = ""
        for el in doc.get("body",{}).get("content",[]):
            if "paragraph" in el:
                for seg in el["paragraph"].get("elements",[]):
                    if "textRun" in seg:
                        text += seg["textRun"].get("content","")
        return {"title": title, "text": text}
    except Exception as e:
        print("google doc read error:", e)
        return None

# -------------------- DB helpers --------------------
def get_table_columns(conn, table_name):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = %s
        """, (table_name,))
        return [r[0] for r in cur.fetchall()]

def insert_row_table(conn, table_name, row):
    # Insert row dict into table by using only columns that exist.
    cols = get_table_columns(conn, table_name)
    use = [c for c in row.keys() if c in cols]
    if not use:
        return False
    placeholders = ", ".join(["%s"] * len(use))
    collist = ", ".join(use)
    vals = [row[c] for c in use]
    sql = f"INSERT INTO {table_name} ({collist}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"
    with conn.cursor() as cur:
        cur.execute(sql, vals)
    conn.commit()
    return True

def insert_documents_with_embedding(conn, row, embedding_vector):
    # Insert into documents if embedding column exists (vector)
    cols = get_table_columns(conn, "documents")
    # required columns we will attempt:
    wanted = {
        "source_title": row.get("source_title"),
        "source_url": row.get("source_url"),
        "source_type": row.get("source_type"),
        "content": row.get("chunk_text") or row.get("content"),
        "chunk_hash": row.get("chunk_hash"),
        # embedding: we will insert as text literal and cast to vector if possible
        "scraped_at": row.get("scraped_at") or "now()",
        "source_domain": row.get("source_domain")
    }

    # build insert column/list
    insert_cols = [c for c in ["source_title","source_url","source_type","content","chunk_hash","embedding","scraped_at","source_domain"] if c in cols]
    if "embedding" not in insert_cols:
        # can't insert embedding if column not present
        return False

    # build values and SQL (embedding as literal string to cast)
    collist = ", ".join(insert_cols)
    placeholders = []
    values = []
    for c in insert_cols:
        if c == "embedding":
            placeholders.append("%s::vector")
            values.append("[" + ",".join(map(str, embedding_vector)) + "]")
        elif c == "scraped_at":
            # prefer explicit timestamp if provided; else use now()
            if wanted.get("scraped_at") and wanted.get("scraped_at") != "now()":
                placeholders.append("%s")
                values.append(wanted.get("scraped_at"))
            else:
                placeholders.append("now()")
        else:
            placeholders.append("%s")
            values.append(wanted.get(c))
    sql = f"INSERT INTO documents ({collist}) VALUES ({', '.join(placeholders)}) ON CONFLICT DO NOTHING"
    with conn.cursor() as cur:
        cur.execute(sql, values)
    conn.commit()
    return True

# -------------------- Embedding helper --------------------
def create_embeddings_batch(texts):
    for attempt in range(3):
        try:
            resp = openai.embeddings.create(model=EMBEDDING_MODEL, input=texts)
            return [d.embedding for d in resp.data]
        except Exception as e:
            print("embeddings error:", e)
            time.sleep(2 ** attempt)
    raise RuntimeError("embedding failed after retries")

# -------------------- Main pipeline --------------------
def main():
    print("Starting safe ingestion pipeline...")
    creds = get_google_creds()
    gc = gspread.authorize(creds)
    docs_service = build("docs","v1",credentials=creds)

    sheet = gc.open_by_key(GOOGLE_SHEET_ID).sheet1
    rows = sheet.col_values(1)[1:]
    print("Found", len(rows), "URLs in sheet.")

    conn = psycopg2.connect(DATABASE_URL)
    try:
        for url in rows:
            if not url or not url.strip():
                continue
            url = canonicalize_url(url.strip())
            domain = domain_of(url)
            print("Processing:", url)

            # fetch/parse
            content = None
            source_type = "WEBPAGE"
            file_size = 0

            if url.lower().endswith(".pdf"):
                source_type = "PDF"
                dl = download_pdf_temp(url)
                if dl["status"] == "ok":
                    file_size = dl["size"]
                    text = extract_pdf_text(dl["path"])
                    title = url.split("/")[-1] or "PDF"
                    try:
                        os.unlink(dl["path"])
                    except:
                        pass
                    content = {"title": title, "text": text}
                else:
                    # create a pending marker with status manual_review
                    print("PDF too large or error; marking manual_review:", dl.get("status"))
                    row = {
                        "source_title": url.split("/")[-1] or url,
                        "source_url": url,
                        "source_domain": domain,
                        "source_type": "PDF",
                        "file_size_bytes": dl.get("size", 0),
                        "status": "manual_review",
                        "notes": "download_or_parse_issue"
                    }
                    try:
                        insert_row_table(conn, "documents_pending", row)
                    except Exception as e:
                        print("failed to insert manual_review marker:", e)
                    continue
            else:
                # google doc?
                import re
                m = re.search(r"/document/d/([a-zA-Z0-9-_]+)", url)
                if m:
                    source_type = "GOOGLE_DOC"
                    doc_id = m.group(1)
                    try:
                        gd = read_google_doc(docs_service, doc_id)
                        content = gd
                        file_size = len(gd.get("text","")) if gd else 0
                    except Exception as e:
                        print("google doc read failed:", e)
                        content = None
                else:
                    # webpage
                    sc = scrape_url(url)
                    if sc:
                        content = sc
                        file_size = sc.get("size", 0)
                    else:
                        content = None

            if not content or not content.get("text") or len(content.get("text")) < 200:
                print("No usable text (or too small), skipping.")
                continue

            title = content.get("title") or url
            text = content.get("text")
            chunks = chunk_text_chars(text)
            print("  chunks:", len(chunks))

            # Prepare pending rows
            pending_rows = []
            small_for_auto = []
            for c in chunks:
                chash = sha1(c[:2000])
                r = {
                    "source_title": title,
                    "source_url": url,
                    "source_domain": domain,
                    "source_type": source_type,
                    "chunk_text": c,
                    "chunk_hash": chash,
                    "file_size_bytes": file_size,
                    "status": "auto_approved" if (file_size > 0 and file_size <= PDF_AUTO_APPROVE_LIMIT_BYTES and source_type!="PDF") else "pending",
                    "seed_origin": "sheet_import"
                }
                pending_rows.append(r)
                if r["status"] == "auto_approved":
                    small_for_auto.append(r)

            # Insert pending rows defensively
            for pr in pending_rows:
                try:
                    insert_row_table(conn, "documents_pending", pr)
                except Exception as e:
                    print("insert pending row error:", e)

            # For small rows, create embedding and insert into documents if possible
            if small_for_auto:
                # batch embeddings
                texts = [r["chunk_text"] for r in small_for_auto]
                try:
                    embeddings = create_embeddings_batch(texts)
                    for r, emb in zip(small_for_auto, embeddings):
                        try:
                            inserted = insert_documents_with_embedding(conn, r, emb)
                            if not inserted:
                                # if we couldn't insert into documents (no embedding col), ensure pending marked auto_approved
                                try:
                                    insert_row_table(conn, "documents_pending", r)
                                except:
                                    pass
                        except Exception as ie:
                            print("insert doc with emb error:", ie)
                except Exception as ee:
                    print("batch embedding failed:", ee)
                    # ensure pending rows exist (they already were inserted)

    finally:
        conn.close()
    print("Pipeline run complete.")

if __name__ == "__main__":
    main()
