#pipeline 2

import os
import re
import json
import time
import gspread
import requests
import psycopg2
import openai
import hashlib
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from io import BytesIO

# --- Configuration & Validation ---
load_dotenv()
DATABASE_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID")
openai.api_key = os.getenv("OPENAI_API_KEY")

if not all([DATABASE_URL, GOOGLE_SHEET_ID, GOOGLE_DRIVE_FOLDER_ID, openai.api_key]):
    raise SystemExit("Missing required environment variables.")

EMBEDDING_MODEL = "text-embedding-3-small"
VECTOR_DIMENSION = 1536

# --- Helper Functions ---
def get_google_creds():
    creds_json_str = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not creds_json_str:
        raise ValueError("GOOGLE_APPLICATION_CREDENTIALS_JSON secret not found.")
    creds_info = json.loads(creds_json_str)
    # CORRECTED: Added Google Docs scope
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents.readonly"
    ]
    return Credentials.from_service_account_info(creds_info, scopes=scopes)

def setup_database(conn):
    with conn.cursor() as cursor:
        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        cursor.execute(f"""
            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY, source_file TEXT, content TEXT,
                chunk_hash TEXT, embedding VECTOR({VECTOR_DIMENSION})
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS documents_source_chunk_hash_uq
            ON documents (source_file, chunk_hash);
        """)
        conn.commit()
    print("Database setup is complete.")

def get_processed_files(conn):
    with conn.cursor() as cursor:
        cursor.execute("SELECT DISTINCT source_file FROM documents;")
        return {row[0] for row in cursor.fetchall() if row[0]}

def scrape_url(url):
    try:
        print(f"  - Scraping standard URL: {url}...")
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=20)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        main_content = soup.select_one('article, div.main-content, div.content, div[role="main"]')
        if main_content:
            for element in main_content.select('nav, header, footer, script, style'):
                element.decompose()
            return main_content.get_text(separator='\\n', strip=True)
    except Exception as e:
        print(f"  - Failed to scrape {url}: {e}")
    return None

def read_google_doc(service, doc_id):
    try:
        print(f"  - Reading Google Doc ID: {doc_id}...")
        doc = service.documents().get(documentId=doc_id).execute()
        content = ""
        for element in doc.get('body').get('content'):
            if 'paragraph' in element:
                for sub_element in element.get('paragraph').get('elements'):
                    if 'textRun' in sub_element:
                        content += sub_element.get('textRun').get('content')
        return content
    except Exception as e:
        print(f"  - Failed to read Google Doc: {e}")
    return None

def chunk_text(text, chunk_size=300, chunk_overlap=50):
    words = text.split()
    if not words: return []
    step = max(1, chunk_size - chunk_overlap)
    return [" ".join(words[i:i + chunk_size]) for i in range(0, len(words), step)]

def create_embeddings_with_retry(batch, retries=3):
    for attempt in range(retries):
        try:
            response = openai.embeddings.create(model=EMBEDDING_MODEL, input=batch)
            if len(response.data[0].embedding) != VECTOR_DIMENSION:
                raise RuntimeError("Embedding dimension mismatch")
            return response
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise

# --- Main Pipeline Logic ---
def main():
    print("--- Starting Multimodal Data Pipeline ---")

    creds = get_google_creds()
    sheets_service = gspread.authorize(creds)
    docs_service = build('docs', 'v1', credentials=creds)

    print(f"\n1. Reading sources from Google Sheet...")
    sheet = sheets_service.open_by_key(GOOGLE_SHEET_ID).sheet1
    source_urls = sheet.col_values(1)[1:] 
    print(f"  - Found {len(source_urls)} sources to process.")

    conn = psycopg2.connect(DATABASE_URL)
    try:
        setup_database(conn)
        processed_files = get_processed_files(conn)

        for url in source_urls:
            content = None
            filename = None

            # Check if it's a Google Doc
            doc_match = re.search(r'/document/d/([a-zA-Z0-9-_]+)', url)
            if doc_match:
                doc_id = doc_match.group(1)
                doc_title = docs_service.documents().get(documentId=doc_id, fields='title').execute().get('title', doc_id)
                filename = re.sub(r'[^a-zA-Z0-9_.-]', '_', doc_title)[:150] + ".txt"
                if filename not in processed_files:
                    content = read_google_doc(docs_service, doc_id)
            else: # Assume it's a standard webpage
                url_hash = hashlib.sha1(url.encode()).hexdigest()[:8]
                sanitized_path = re.sub(r'[^a-zA-Z0-9_.-]', '_', url.split("://")[1])[:120]
                filename = f"{sanitized_path}_{url_hash}.txt"
                if filename not in processed_files:
                    content = scrape_url(url)

            if filename in processed_files:
                print(f"  - Skipping '{filename}', already processed.")
                continue

            if not content:
                print(f"  - No content extracted from {url}, skipping.")
                continue

            try:
                chunks = chunk_text(content)
                if not chunks: continue

                print(f"  - Embedding {len(chunks)} chunks for {filename}...")
                batch_size = 100
                for i in range(0, len(chunks), batch_size):
                    batch = chunks[i:i+batch_size]
                    response = create_embeddings_with_retry(batch)
                    embeddings = [e.embedding for e in response.data]

                    with conn.cursor() as cursor:
                        for j, chunk in enumerate(batch):
                            embedding = embeddings[j]
                            chunk_hash = hashlib.sha1(chunk.encode('utf-8')).hexdigest()
                            vector_literal = '[' + ','.join(map(str, embedding)) + ']'
                            cursor.execute(
                                "INSERT INTO documents (source_file, content, chunk_hash, embedding) VALUES (%s, %s, %s, %s::vector) ON CONFLICT DO NOTHING",
                                (filename, chunk, chunk_hash, vector_literal)
                            )
                    conn.commit()
                    print(f"    - Committed batch {i//batch_size + 1}")
                    time.sleep(0.5)
            except Exception as e:
                print(f"  - ERROR: Failed during processing for {filename}: {e}")
                conn.rollback()
    finally:
        conn.close()
        print("\n--- Pipeline Complete ---")

if __name__ == "__main__":
    main()