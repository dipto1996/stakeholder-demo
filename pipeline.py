# pipeline.py
import os
import re
import json
import time
import hashlib
import requests
import psycopg2
import openai
import gspread
from bs4 import BeautifulSoup
from io import BytesIO
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

load_dotenv()
DATABASE_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID")
openai.api_key = os.getenv("OPENAI_API_KEY")

EMBEDDING_MODEL = "text-embedding-3-small"
VECTOR_DIMENSION = 1536

def get_google_creds():
    creds_json_str = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not creds_json_str:
        raise ValueError("GOOGLE_APPLICATION_CREDENTIALS_JSON secret not found.")
    creds_info = json.loads(creds_json_str)
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive"
    ]
    return Credentials.from_service_account_info(creds_info, scopes=scopes)

def setup_database(conn):
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY,
                source_file TEXT,
                source_url TEXT,
                source_title TEXT,
                source_type TEXT,
                content TEXT,
                chunk_hash TEXT,
                embedding VECTOR({VECTOR_DIMENSION}),
                scraped_at TIMESTAMPTZ
            );
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS documents_source_chunk_hash_uq
            ON documents (COALESCE(source_url, source_file), chunk_hash);
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS files (
                source_file TEXT PRIMARY KEY,
                source_url TEXT,
                drive_file_id TEXT,
                source_title TEXT,
                processed_at TIMESTAMPTZ DEFAULT now()
            );
        """)
        conn.commit()

def canonicalize_url(u):
    # very small canonicalization: lower-case scheme/domain and remove utm params
    try:
        from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode
        p = urlparse(u)
        qs = dict(parse_qsl(p.query))
        # remove common tracking params
        for k in list(qs.keys()):
            if k.lower().startswith('utm_'):
                qs.pop(k)
        new_q = urlencode(sorted(qs.items()))
        netloc = p.netloc.lower()
        return urlunparse((p.scheme.lower(), netloc, p.path or '/', p.params, new_q, ''))
    except Exception:
        return u

def scrape_url(url):
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        resp = requests.get(url, headers=headers, timeout=20)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        # title
        title_tag = soup.title.string.strip() if soup.title and soup.title.string else None
        # main content fallback heuristic
        main = soup.select_one('article, div.main-content, div.content, div[role="main"], main')
        if not main:
            # fallback to body text
            main = soup.body
        if main:
            for junk in main.select('nav, header, footer, script, style, .usa-alert, .c-page-header'):
                junk.decompose()
            text = main.get_text(separator='\n', strip=True)
        else:
            text = soup.get_text(separator='\n', strip=True)
        return {
            "title": title_tag or "",
            "text": text
        }
    except Exception as e:
        print("scrape error", e)
        return None

def chunk_text(text, chunk_size=300, overlap=50):
    words = text.split()
    if not words: return []
    step = max(1, chunk_size - overlap)
    return [" ".join(words[i:i+chunk_size]) for i in range(0, len(words), step)]

def create_embeddings_with_retry(batch, retries=3):
    for attempt in range(retries):
        try:
            resp = openai.embeddings.create(model=EMBEDDING_MODEL, input=batch)
            return resp
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise

def main():
    creds = get_google_creds()
    drive_service = build('drive', 'v3', credentials=creds)
    gc = gspread.service_account_from_dict(json.loads(os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")))

    sheet = gc.open_by_key(GOOGLE_SHEET_ID).sheet1
    urls = sheet.col_values(1)[1:]  # skip header

    conn = psycopg2.connect(DATABASE_URL)
    setup_database(conn)
    with conn.cursor() as cur:
        cur.execute("SELECT source_file FROM files;")
        processed = {r[0] for r in cur.fetchall()}

    for url in urls:
        safe_name_part = re.sub(r'[^a-zA-Z0-9_.-]', '_', url.split("://")[-1])[:120]
        url_hash = hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]
        filename = f"{safe_name_part}_{url_hash}.txt"
        if filename in processed:
            print("Skipping", filename)
            continue

        can_url = canonicalize_url(url)
        scraped = scrape_url(url)
        if not scraped or not scraped.get("text"):
            print("No content for", url)
            continue

        source_title = scraped.get("title") or can_url
        content = scraped["text"]

        # upload to Drive only if drive folder present
        try:
            # check exists
            q = f"name = '{filename}' and '{GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed=false"
            results = drive_service.files().list(q=q, fields="files(id)").execute()
            if not results.get("files"):
                media = BytesIO(content.encode("utf-8"))
                media_body = MediaIoBaseUpload(media, mimetype='text/plain')
                file_metadata = {'name': filename, 'parents': [GOOGLE_DRIVE_FOLDER_ID]}
                f = drive_service.files().create(body=file_metadata, media_body=media_body, fields='id').execute()
                drive_file_id = f.get("id")
            else:
                drive_file_id = results['files'][0]['id']
        except Exception as e:
            print("Drive upload failed:", e)
            drive_file_id = None

        chunks = chunk_text(content)
        if not chunks:
            continue

        # create embeddings in batches
        batch_size = 100
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i+batch_size]
            emb_resp = create_embeddings_with_retry(batch)
            embeddings = [d.embedding for d in emb_resp.data]
            # insert each chunk
            with conn.cursor() as cur:
                for chunk, emb in zip(batch, embeddings):
                    chunk_hash = hashlib.sha1(chunk.encode("utf-8")).hexdigest()
                    vector_literal = '[' + ','.join(map(str, emb)) + ']'
                    cur.execute("""
                        INSERT INTO documents (source_file, source_url, source_title, content, chunk_hash, embedding, scraped_at)
                        VALUES (%s, %s, %s, %s, %s, %s::vector, now())
                        ON CONFLICT (COALESCE(source_url, source_file), chunk_hash) DO NOTHING
                    """, (filename, can_url, source_title, chunk, chunk_hash, vector_literal))
                conn.commit()
        # record file
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO files (source_file, source_url, drive_file_id, source_title, processed_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (source_file) DO UPDATE SET drive_file_id = EXCLUDED.drive_file_id, processed_at = now()
            """, (filename, can_url, drive_file_id, source_title))
            conn.commit()
        processed.add(filename)
        print("Processed", filename)

    conn.close()
    print("Done.")

if __name__ == "__main__":
    main()
