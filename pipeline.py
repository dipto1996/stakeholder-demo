# pipeline.py — Final Production-Grade Version
# This script is compatible with the final database schema, extracts titles for citations,
# and incorporates robustness features like retries, batching, and smarter scraping for
# webpages, Google Docs, and PDFs.
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
from io import BytesIO
from PyPDF2 import PdfReader
from urllib.parse import urlparse # <-- THIS IS THE FIX

# --- Configuration & Validation ---
load_dotenv()
DATABASE_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
openai.api_key = os.getenv("OPENAI_API_KEY")

if not all([DATABASE_URL, GOOGLE_SHEET_ID, openai.api_key]):
    raise SystemExit("Missing required environment variables. Check .env and GOOGLE_SHEET_ID.")

EMBEDDING_MODEL = "text-embedding-3-small"
VECTOR_DIMENSION = 1536

# --- Helper Functions ---
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

def get_processed_urls(conn):
    with conn.cursor() as cursor:
        cursor.execute("SELECT DISTINCT source_url FROM documents WHERE source_url IS NOT NULL;")
        return {row[0] for row in cursor.fetchall() if row[0]}

def scrape_url(url):
    try:
        print(f"  - Scraping URL: {url}...")
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        
        content_type = response.headers.get('Content-Type', '')
        if 'text/html' not in content_type:
            print(f"  - Skipping non-HTML content type: {content_type}")
            return None

        soup = BeautifulSoup(response.text, 'html.parser')
        title = soup.title.string.strip() if soup.title else "Untitled"
        main_content = soup.select_one('article, div.main-content, div.content, div[role="main"]')
        if main_content:
            for element in main_content.select('nav, header, footer, script, style, .usa-alert'):
                element.decompose()
            text = main_content.get_text(separator='\n', strip=True)
        else:
            text = soup.get_text(separator='\n', strip=True)
            
        return {"title": title, "text": text}
    except Exception as e:
        print(f"  - Failed to scrape {url}: {e}")
    return None

def read_google_doc(service, doc_id):
    try:
        print(f"  - Reading Google Doc ID: {doc_id}...")
        doc = service.documents().get(documentId=doc_id, fields='title,body').execute()
        title = doc.get('title', 'Untitled Google Doc')
        content = ""
        for element in doc.get('body').get('content'):
            if 'paragraph' in element:
                for sub_element in element.get('paragraph').get('elements'):
                    if 'textRun' in sub_element:
                        content += sub_element.get('textRun').get('content')
        return {"title": title, "text": content}
    except Exception as e:
        print(f"  - Failed to read Google Doc: {e}")
    return None

def read_pdf_from_url(url):
    """Downloads a PDF from a URL and extracts text content."""
    try:
        print(f"  - Processing PDF URL: {url}...")
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=60, stream=True)
        response.raise_for_status()

        pdf_file = BytesIO(response.content)
        reader = PdfReader(pdf_file)
        
        text = ""
        for page in reader.pages:
            text += page.extract_text() + "\n"
        
        title = os.path.basename(urlparse(url).path)

        return {"title": title, "text": text}
    except Exception as e:
        print(f"  - Failed to process PDF from {url}: {e}")
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
    print("--- Starting Production Data Pipeline ---")
    
    creds = get_google_creds()
    gc = gspread.authorize(creds)
    docs_service = build('docs', 'v1', credentials=creds)

    print(f"\n1. Reading sources from Google Sheet...")
    sheet = gc.open_by_key(GOOGLE_SHEET_ID).sheet1
    source_urls = sheet.col_values(1)[1:] 
    print(f"  - Found {len(source_urls)} sources to process.")

    conn = psycopg2.connect(DATABASE_URL)
    try:
        processed_urls = get_processed_urls(conn)
        
        for url in source_urls:
            if url in processed_urls:
                print(f"  - Skipping '{url}', already processed.")
                continue

            content_data = None
            source_type = "UNKNOWN"
            
            doc_match = re.search(r'/document/d/([a-zA-Z0-9-_]+)', url)
            if url.lower().endswith('.pdf'):
                source_type = "PDF"
                content_data = read_pdf_from_url(url)
            elif doc_match:
                source_type = "GOOGLE_DOC"
                doc_id = doc_match.group(1)
                content_data = read_google_doc(docs_service, doc_id)
            else:
                source_type = "WEBPAGE"
                content_data = scrape_url(url)
            
            if not content_data or not content_data.get("text"):
                print(f"  - No content extracted from {url}, skipping.")
                continue

            title = content_data.get("title")
            content = content_data.get("text")
            
            try:
                chunks = chunk_text(content)
                if not chunks: continue

                print(f"  - Embedding {len(chunks)} chunks for '{title}'...")
                
                batch_size = 100
                for i in range(0, len(chunks), batch_size):
                    batch = chunks[i:i+batch_size]
                    print(f"    - Processing batch {i//batch_size + 1}...")
                    
                    response = create_embeddings_with_retry(batch)
                    embeddings = [e.embedding for e in response.data]
                    
                    with conn.cursor() as cursor:
                        for j, chunk in enumerate(batch):
                            embedding = embeddings[j]
                            chunk_hash = hashlib.sha1(chunk.encode('utf-8')).hexdigest()
                            vector_literal = '[' + ','.join(map(str, embedding)) + ']'
                            cursor.execute(
                                """
                                INSERT INTO documents 
                                    (source_title, source_url, source_type, content, chunk_hash, embedding, scraped_at)
                                VALUES (%s, %s, %s, %s, %s, %s::vector, now())
                                ON CONFLICT DO NOTHING
                                """,
                                (title, url, source_type, chunk, chunk_hash, vector_literal)
                            )
                    conn.commit()
                    print(f"    - Committed batch {i//batch_size + 1}.")

                print(f"  - Successfully processed and stored '{title}'.")
            except Exception as e:
                print(f"  - ERROR: Failed during processing for '{title}': {e}")
                conn.rollback()
    finally:
        conn.close()
        print("\n--- Pipeline Complete ---")

if __name__ == "__main__":
    main()

