#!/usr/bin/env python3
"""
pipeline.py — robust production ingestion pipeline

Features:
- Reads source URLs from a Google Sheet (first column)
- Detects URL type: PDF, Google Doc, or webpage
- For PDFs: checks content-length via HEAD. If >= 100 MB, records in documents_large and skips embedding.
- Extracts text with PyMuPDF (fitz) -> fallback PyPDF2
- Scrapes HTML using requests + BeautifulSoup
- Reads Google Docs via Google Docs API
- Chunks text, creates embeddings (OpenAI), writes to `documents` table with embedding::vector
- Defensive handling so no undefined variables are used
- Retries and logging
"""

import os
import json
import time
import hashlib
import math
from io import BytesIO
from urllib.parse import urlparse
from typing import List, Dict, Optional

import requests
from requests.adapters import HTTPAdapter, Retry
from bs4 import BeautifulSoup
import gspread
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

import openai
import psycopg2

# PDF libs
import fitz  # pymupdf
from PyPDF2 import PdfReader

# ---- Config - environment variables ----
POSTGRES_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_APPLICATION_CREDENTIALS_JSON = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

if not all([POSTGRES_URL, GOOGLE_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS_JSON, OPENAI_API_KEY]):
    raise SystemExit("Missing env var: POSTGRES_URL, GOOGLE_SHEET_ID, GOOGLE_APPLICATION_CREDENTIALS_JSON, or OPENAI_API_KEY")

openai.api_key = OPENAI_API_KEY

EMBEDDING_MODEL = "text-embedding-3-small"
VECTOR_DIMENSION = 1536
CHUNK_SIZE_WORDS = 300
CHUNK_OVERLAP = 50
BATCH_SIZE = 100
MAX_PDF_STORE_MB = 100  # If PDF size >= this, store metadata in documents_large and skip embedding
MIN_TEXT_WORDS = 20  # skip very small extractions
REQUEST_TIMEOUT = 20
HEAD_TIMEOUT = 8

# ---- Requests session with retries ----
session = requests.Session()
retries = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504])
adapter = HTTPAdapter(max_retries=retries)
session.mount("https://", adapter)
session.mount("http://", adapter)
DEFAULT_HEADERS = {"User-Agent": "ImmigrationRAGBot/1.0 (+https://yourdomain.example)"}

# ---- Helpers ----
def get_google_creds():
    info = json.loads(GOOGLE_APPLICATION_CREDENTIALS_JSON)
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/documents.readonly",
    ]
    return Credentials.from_service_account_info(info, scopes=scopes)

def sheet_urls_from_sheet():
    creds = get_google_creds()
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(GOOGLE_SHEET_ID)
    ws = sh.sheet1
    vals = ws.col_values(1)
    # skip header if present
    if vals and vals[0].lower().strip().startswith("url"):
        vals = vals[1:]
    return [v.strip() for v in vals if v and v.strip()]

def safe_head(url: str, timeout=HEAD_TIMEOUT) -> Optional[requests.Response]:
    try:
        return session.head(url, headers=DEFAULT_HEADERS, allow_redirects=True, timeout=timeout)
    except Exception:
        return None

def safe_get(url: str, timeout=REQUEST_TIMEOUT) -> Optional[requests.Response]:
    try:
        return session.get(url, headers=DEFAULT_HEADERS, allow_redirects=True, timeout=timeout)
    except Exception:
        return None

def get_content_length(url: str) -> Optional[int]:
    h = safe_head(url)
    if not h:
        return None
    cl = h.headers.get("Content-Length") or h.headers.get("content-length")
    if cl:
        try:
            return int(cl)
        except Exception:
            return None
    return None

def chunk_text(text: str, chunk_size=CHUNK_SIZE_WORDS, overlap=CHUNK_OVERLAP) -> List[str]:
    words = text.split()
    if not words:
        return []
    step = max(1, chunk_size - overlap)
    out = []
    for i in range(0, len(words), step):
        chunk = " ".join(words[i:i+chunk_size])
        if chunk.strip():
            out.append(chunk)
    return out

def create_embeddings_with_retry(batch: List[str], retries=3):
    for attempt in range(retries):
        try:
            resp = openai.embeddings.create(model=EMBEDDING_MODEL, input=batch)
            # validate dimension
            emb = resp.data[0].embedding
            if len(emb) != VECTOR_DIMENSION:
                raise RuntimeError("embedding dim mismatch")
            return resp
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise

# ---- Content extraction routines ----
def read_google_doc(service, doc_id: str) -> Dict:
    try:
        doc = service.documents().get(documentId=doc_id, fields="title,body").execute()
        title = doc.get("title", "Untitled Google Doc")
        content = []
        for el in doc.get("body", {}).get("content", []):
            if "paragraph" in el:
                for e in el["paragraph"].get("elements", []):
                    tr = e.get("textRun", {}).get("content")
                    if tr:
                        content.append(tr)
        full = "".join(content).strip()
        return {"title": title, "text": full}
    except Exception as e:
        return {"title": None, "text": "", "note": f"google-doc-read-failed: {e}"}

def scrape_url_html(url: str) -> Dict:
    resp = safe_get(url)
    if not resp or resp.status_code >= 400:
        return {"title": None, "text": "", "note": f"http-status-{resp.status_code if resp else 'no-response'}"}
    ctype = resp.headers.get("Content-Type", "").lower()
    if "text/html" not in ctype:
        return {"title": None, "text": "", "note": f"not-html:{ctype}"}
    soup = BeautifulSoup(resp.text, "html.parser")
    title = (soup.title.string.strip() if soup.title and soup.title.string else urlparse(url).netloc)
    # try to find main content containers
    main = soup.select_one("article, div.main-content, div.content, div#main, div[role='main']")
    if main:
        for bad in main.select("nav, header, footer, script, style, .sidebar, .nav, .cookie-consent, .cookie-banner"):
            bad.decompose()
        text = main.get_text(separator="\n", strip=True)
        if not text or len(text.split()) < MIN_TEXT_WORDS:
            # fallback to all text
            text = soup.get_text(separator="\n", strip=True)
    else:
        text = soup.get_text(separator="\n", strip=True)
    if not text or len(text.split()) < MIN_TEXT_WORDS:
        return {"title": title, "text": "", "note": "extracted text too small"}
    return {"title": title, "text": text}

def read_pdf_from_url(url: str, max_mb_store_in_db: int = MAX_PDF_STORE_MB) -> Dict:
    # Check server-provided size first
    size = get_content_length(url)
    if size and size >= max_mb_store_in_db * 1024 * 1024:
        return {"too_large": True, "file_size_bytes": size}
    resp = safe_get(url, timeout=60)
    if not resp or resp.status_code >= 400:
        return {"title": None, "text": "", "note": f"pdf-download-failed: status {resp.status_code if resp else 'no-response'}"}
    content_bytes = resp.content
    size = size or len(content_bytes)
    if size >= max_mb_store_in_db * 1024 * 1024:
        return {"too_large": True, "file_size_bytes": size}

    # Try PyMuPDF (fitz)
    try:
        doc = fitz.open(stream=content_bytes, filetype="pdf")
        pages = []
        for p in doc:
            t = p.get_text("text")
            if t:
                pages.append(t)
        full = "\n".join(pages).strip()
        title = os.path.basename(urlparse(url).path) or "pdf"
        if not full or len(full.split()) < MIN_TEXT_WORDS:
            return {"title": title, "text": "", "note": "extracted text too small (fitz)"}
        return {"title": title, "text": full}
    except Exception as e_fitz:
        # fallback to PyPDF2
        try:
            pdf_file = BytesIO(content_bytes)
            reader = PdfReader(pdf_file)
            pages = []
            for p in reader.pages:
                try:
                    t = p.extract_text() or ""
                    pages.append(t)
                except Exception:
                    continue
            full = "\n".join(pages).strip()
            title = os.path.basename(urlparse(url).path) or "pdf"
            if not full or len(full.split()) < MIN_TEXT_WORDS:
                return {"title": title, "text": "", "note": "extracted text too small (pypdf2)"}
            return {"title": title, "text": full}
        except Exception as e_pypdf2:
            return {"title": None, "text": "", "note": f"pdf-parse-failed: {e_fitz} / {e_pypdf2}"}

# ---- DB helpers ----
def get_conn():
    return psycopg2.connect(POSTGRES_URL)

def insert_large_document(conn, url, title, source_type, file_size_bytes, note=None):
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO documents_large (source_url, source_title, source_type, file_size_bytes, note)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (url, title, source_type, file_size_bytes, note)
        )
    conn.commit()

def insert_chunks_into_db(conn, title, url, source_type, chunks: List[str], domain: str):
    # batches and inserts embeddings
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i:i+BATCH_SIZE]
        resp = create_embeddings_with_retry(batch)
        embeddings = [d.embedding for d in resp.data]
        with conn.cursor() as cur:
            for j, chunk in enumerate(batch):
                if not chunk or len(chunk.strip()) == 0:
                    continue
                try:
                    embedding = embeddings[j]
                except Exception:
                    print("  - missing embedding for chunk, skipping")
                    continue
                chunk_hash = hashlib.sha1(chunk.encode("utf-8")).hexdigest()
                vector_literal = "[" + ",".join(map(str, embedding)) + "]"
                cur.execute(
                    """
                    INSERT INTO documents
                      (source_title, source_url, source_type, content, chunk_hash, embedding, scraped_at, source_domain)
                    VALUES (%s, %s, %s, %s, %s, %s::vector, now(), %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (title, url, source_type, chunk, chunk_hash, vector_literal, domain)
                )
        conn.commit()

# ---- Main pipeline ----
def main():
    print("--- Starting safe ingestion pipeline ---")
    urls = sheet_urls_from_sheet()
    print(f"Found {len(urls)} URLs in sheet.")

    # build docs service for google docs reading
    creds = get_google_creds()
    docs_service = build("docs", "v1", credentials=creds)

    conn = get_conn()
    try:
        for url in urls:
            if not url:
                continue
            print(f"\nProcessing: {url}")
            parsed = urlparse(url)
            domain = parsed.netloc.lower() if parsed.netloc else None
            lower = url.lower()

            extracted = None
            source_type = "WEBPAGE"

            try:
                if lower.endswith(".pdf") or "application/pdf" in (safe_head(url).headers.get("Content-Type", "") if safe_head(url) else ""):
                    source_type = "PDF"
                    extracted = read_pdf_from_url(url)
                    if extracted.get("too_large"):
                        print(f"  - PDF too large ({extracted.get('file_size_bytes')}). Storing metadata and skipping.")
                        insert_large_document(conn, url, os.path.basename(parsed.path) or url, source_type, extracted.get("file_size_bytes"), note="auto-stored-large")
                        continue
                    if not extracted.get("text"):
                        print(f"  - No usable PDF text, note={extracted.get('note')}")
                        continue
                elif "/document/d/" in lower or lower.startswith("https://docs.google.com"):
                    source_type = "GOOGLE_DOC"
                    # extract doc id
                    import re
                    m = re.search(r"/document/d/([a-zA-Z0-9\-_]+)", url)
                    if m:
                        docid = m.group(1)
                        extracted = read_google_doc(docs_service, docid)
                        if not extracted.get("text"):
                            print(f"  - No usable google doc text, note={extracted.get('note')}")
                            continue
                    else:
                        print("  - Google doc URL didn't match expected pattern, skipping.")
                        continue
                else:
                    # HTML scrape
                    source_type = "WEBPAGE"
                    extracted = scrape_url_html(url)
                    if not extracted.get("text"):
                        print(f"  - No usable HTML text, note={extracted.get('note')}")
                        continue

                content = extracted.get("text", "")
                title = extracted.get("title") or (os.path.basename(parsed.path) or domain)
                if not content or len(content.split()) < MIN_TEXT_WORDS:
                    print("  - Extracted text too small, skipping.")
                    continue

                chunks = chunk_text(content)
                if not chunks:
                    print("  - chunking produced no chunks, skipping.")
                    continue

                print(f"  - chunks: {len(chunks)}  (title: {title})")
                insert_chunks_into_db(conn, title, url, source_type, chunks, domain)
                print(f"  - Successfully inserted chunks for {url}")

            except Exception as e:
                print(f"  - ERROR processing {url}: {e}")
                # continue to next URL
                continue

    finally:
        conn.close()
        print("Pipeline finished:", time.strftime("%Y-%m-%dT%H:%M:%S"))

if __name__ == "__main__":
    main()
