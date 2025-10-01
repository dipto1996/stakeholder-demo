# pipeline.py — faster, direct ingestion to documents_pending and autopublish small items
import os
import re
import json
import time
import gspread
import requests
import psycopg2
import openai
import hashlib
import tempfile
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from io import BytesIO
from PyPDF2 import PdfReader
from urllib.parse import urlparse

load_dotenv()

DATABASE_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBED_BATCH_SIZE = int(os.getenv("EMBED_BATCH_SIZE", "16"))
PDF_SIZE_AUTO_APPROVE_LIMIT = int(os.getenv("PDF_SIZE_AUTO_APPROVE_LIMIT_BYTES", str(20 * 1024 * 1024)))
MAX_PDF_DOWNLOAD = int(os.getenv("MAX_PDF_DOWNLOAD_BYTES", str(50 * 1024 * 1024)))

if not all([DATABASE_URL, GOOGLE_SHEET_ID, OPENAI_API_KEY]):
    raise SystemExit("Missing required env vars: POSTGRES_URL, GOOGLE_SHEET_ID, OPENAI_API_KEY")

openai.api_key = OPENAI_API_KEY

def canonicalize_url(u):
    try:
        p = urlparse(u)
        if not p.scheme:
            u = "https://" + u
        return u.split('?')[0].rstrip('/')
    except:
        return u

def domain_of_url(u):
    try:
        return urlparse(u).netloc.lower()
    except:
        return ""

def safe_sha1(s):
    return hashlib.sha1(s.encode('utf-8')).hexdigest()

def get_google_creds():
    creds_json_str = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not creds_json_str:
        raise ValueError("GOOGLE_APPLICATION_CREDENTIALS_JSON secret not found in environment.")
    creds_info = json.loads(creds_json_str)
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents.readonly"
    ]
    return Credentials.from_service_account_info(creds_info, scopes=scopes)

def download_pdf_to_temp(url, max_bytes=MAX_PDF_DOWNLOAD):
    headers = {'User-Agent': 'Mozilla/5.0'}
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
            print("PDF download error:", e)
            return {"status": "error", "error": str(e)}

def extract_text_from_pdf_path(path):
    try:
        reader = PdfReader(path)
        text_parts = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                text_parts.append(t)
        return "\n".join(text_parts)
    except Exception as e:
        print("PDF parse error:", e)
        return ""

def scrape_url(url):
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        content_type = r.headers.get('Content-Type','')
        if 'text/html' not in content_type:
            return None
        soup = BeautifulSoup(r.text, 'html.parser')
        title = soup.title.string.strip() if soup.title else "Untitled"
        main_content = soup.select_one('article, div.main-content, div.content, div[role="main"]')
        if main_content:
            for element in main_content.select('nav, header, footer, script, style, .usa-alert, .footer'):
                element.decompose()
            text = main_content.get_text(separator='\n', strip=True)
        else:
            text = soup.get_text(separator='\n', strip=True)
        return {"title": title, "text": text, "size": len(r.content)}
    except Exception as e:
        print("scrape_url failed:", e)
        return None

def read_google_doc(service, doc_id):
    try:
        doc = service.documents().get(documentId=doc_id, fields='title,body').execute()
        title = doc.get('title', 'Untitled Google Doc')
        content = ""
        for element in doc.get('body', {}).get('content', []):
            if 'paragraph' in element:
                for sub_element in element.get('paragraph').get('elements', []):
                    if 'textRun' in sub_element:
                        content += sub_element.get('textRun').get('content','')
        return {"title": title, "text": content}
    except Exception as e:
        print("read_google_doc failed:", e)
        return None

def chunk_text_chars(text, chunk_chars=1200, overlap=200):
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

def create_embeddings_with_retry(batch, retries=3):
    for attempt in range(retries):
        try:
            response = openai.embeddings.create(model=EMBEDDING_MODEL, input=batch)
            return response
        except Exception as e:
            print("Embedding attempt failed:", e)
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise

def insert_pending(conn, rows):
    with conn.cursor() as cur:
        for r in rows:
            try:
                cur.execute("""
                    INSERT INTO documents_pending
                      (source_title, source_url, source_domain, source_type, chunk_text, chunk_hash, file_size_bytes, seed_origin, source_hash, status)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (source_url, chunk_hash) DO NOTHING
                """, (
                    r.get("source_title"), r.get("source_url"), r.get("source_domain"), r.get("source_type"),
                    r.get("chunk"), r.get("chunk_hash"), r.get("file_size_bytes") or 0, r.get("seed_origin"), r.get("source_hash"), "pending"
                ))
            except Exception as e:
                print("insert_pending error:", e)
        conn.commit()

def autopublish_small(conn, rows):
    # For speed: create embeddings per-chunk and insert into documents
    with conn.cursor() as cur:
        for r in rows:
            try:
                text = r.get("chunk")
                emb_resp = create_embeddings_with_retry([text])
                embedding = emb_resp.data[0].embedding
                vector_literal = '[' + ','.join(map(str, embedding)) + ']'
                cur.execute("""
                  INSERT INTO documents (source_title, source_url, source_type, content, chunk_hash, embedding, scraped_at, source_domain, source_hash, source_priority, status)
                  VALUES (%s,%s,%s,%s,%s,%s::vector, now(), %s, %s, %s, 'approved')
                  ON CONFLICT DO NOTHING
                """, (
                  r.get("source_title"), r.get("source_url"), r.get("source_type"), r.get("chunk"),
                  r.get("chunk_hash"), vector_literal, r.get("source_domain"), r.get("source_hash"),
                  r.get("source_priority") or 5
                ))
            except Exception as e:
                print("autopublish error:", e)
        conn.commit()

def main():
    print("=== Starting ingestion (fast mode) ===")
    creds = get_google_creds()
    gc = gspread.authorize(creds)
    docs_service = build('docs','v1',credentials=creds)

    sheet = gc.open_by_key(GOOGLE_SHEET_ID).sheet1
    source_urls = sheet.col_values(1)[1:]
    print("Found", len(source_urls), "rows.")

    conn = psycopg2.connect(DATABASE_URL)
    try:
        for url in source_urls:
            if not url or url.strip()=="":
                continue
            url = canonicalize_url(url)
            domain = domain_of_url(url)
            print("\nProcessing:", url, "domain:", domain)

            content_data = None
            source_type = "UNKNOWN"
            file_size = 0
            source_hash = None

            doc_match = re.search(r'/document/d/([a-zA-Z0-9-_]+)', url)
            try:
                if url.lower().endswith('.pdf'):
                    source_type = "PDF"
                    dl = download_pdf_to_temp(url, max_bytes=MAX_PDF_DOWNLOAD)
                    if dl["status"] == "ok":
                        file_size = dl["size"]
                        text = extract_text_from_pdf_path(dl["path"])
                        source_hash = safe_sha1(text[:100000]) if text else None
                        content_data = {"title": url.split('/')[-1], "text": text}
                        try:
                            os.unlink(dl["path"])
                        except:
                            pass
                    else:
                        # If PDF too large or error: still create pending marker row and continue
                        print("PDF large or error; creating single pending row for manual processing.")
                        with conn.cursor() as cur:
                            cur.execute("""
                              INSERT INTO documents_pending (source_title, source_url, source_domain, source_type, file_size_bytes, status, notes)
                              VALUES (%s,%s,%s,%s,%s,%s,%s)
                              ON CONFLICT (source_url, chunk_hash) DO NOTHING
                            """, (url.split('/')[-1], url, domain, "PDF", dl.get("size",0), "manual_review", "queued_large"))
                            conn.commit()
                        continue

                elif doc_match:
                    source_type = "GOOGLE_DOC"
                    doc_id = doc_match.group(1)
                    content_data = read_google_doc(docs_service, doc_id)
                    file_size = len(content_data.get("text","")) if content_data else 0
                    source_hash = safe_sha1(content_data.get("text","")[:100000]) if content_data and content_data.get("text") else None

                else:
                    source_type = "WEBPAGE"
                    scraped = scrape_url(url)
                    if not scraped or not scraped.get("text"):
                        print("No text extracted, skipping.")
                        continue
                    content_data = scraped
                    file_size = scraped.get("size",0)
                    source_hash = safe_sha1(scraped.get("text","")[:100000])
            except Exception as e:
                print("extract error:", e)
                continue

            if not content_data or not content_data.get("text"):
                print("no content, skip")
                continue

            title = content_data.get("title") or "Untitled"
            text = content_data.get("text")
            text = re.sub(r'\s+\n', '\n', text).strip()
            if len(text) < 200:
                print("content too short, skipping")
                continue

            chunks = chunk_text_chars(text, chunk_chars=1200, overlap=200)
            print("chunks:", len(chunks))

            pending_rows = []
            small_rows_for_autopublish = []
            for c in chunks:
                chash = safe_sha1(c[:10000])
                row = {
                    "source_title": title,
                    "source_url": url,
                    "source_domain": domain,
                    "source_type": source_type,
                    "chunk": c,
                    "chunk_hash": chash,
                    "file_size_bytes": file_size,
                    "seed_origin": "sheet_import",
                    "source_hash": source_hash,
                    "source_priority": 5
                }
                pending_rows.append(row)
                # autopublish heuristic: small file under limit, prefer webpages
                if file_size <= PDF_SIZE_AUTO_APPROVE_LIMIT and source_type != "PDF":
                    small_rows_for_autopublish.append(row)

            # Insert all into pending table
            insert_pending(conn, pending_rows)

            # Autopublish small rows (fast path) — this will create embeddings and insert into documents
            if small_rows_for_autopublish:
                autopublish_small(conn, small_rows_for_autopublish)

        print("=== Ingestion run complete ===")

    finally:
        conn.close()

if __name__ == "__main__":
    main()
