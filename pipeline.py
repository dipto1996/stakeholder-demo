import os
import re
import json
import gspread
import requests
import psycopg2
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from sentence_transformers import SentenceTransformer

# --- Configuration ---
load_dotenv()
DATABASE_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID")

# Use the free, local model for embedding
MODEL_NAME = 'all-MiniLM-L6-v2'
VECTOR_DIMENSION = 384

# --- Google Authentication ---
def get_google_creds():
    creds_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    creds_dict = json.loads(creds_json)
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive"
    ]
    return Credentials.from_service_account_info(creds_dict, scopes=scopes)

# --- Database Functions ---
def setup_database(conn):
    with conn.cursor() as cursor:
        print("Ensuring 'vector' extension is enabled...")
        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        print(f"Setting up 'documents' table for vectors of dimension {VECTOR_DIMENSION}...")
        cursor.execute(f"""
            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY,
                source_file TEXT,
                content TEXT,
                embedding VECTOR({VECTOR_DIMENSION})
            );
        """)
        conn.commit()
    print("Database setup complete.")

# --- Scraper & Embedder Functions ---
def scrape_url(url):
    try:
        print(f"  - Scraping URL: {url}...")
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        main_content = soup.select_one('article, div.main-content, div.content, div[role="main"]')
        if main_content:
            return main_content.get_text(separator='\n', strip=True)
    except Exception as e:
        print(f"  - Failed to scrape {url}: {e}")
    return None

def chunk_text(text):
    if not text: return []
    # Simple split by paragraph
    return [p.strip() for p in text.split('\n\n') if p.strip()]

# --- Main Pipeline Logic ---
def main():
    print("--- Starting Automated Data Pipeline ---")
    
    creds = get_google_creds()
    drive_service = build('drive', 'v3', credentials=creds)
    sheets_service = gspread.authorize(creds)

    # 1. Read URLs from Google Sheet
    print(f"\n1. Reading URLs from Google Sheet ID: {GOOGLE_SHEET_ID}")
    sheet = sheets_service.open_by_key(GOOGLE_SHEET_ID).sheet1
    urls_to_scrape = sheet.get_col(1, include_empty=False)[1:] # Assumes header in row 1
    print(f"  - Found {len(urls_to_scrape)} URLs to process.")

    # 2. Scrape new content and save to Google Drive
    for url in urls_to_scrape:
        content = scrape_url(url)
        if content:
            filename = re.sub(r'[^a-zA-Z0-9]', '_', url) + ".txt"
            print(f"  - Saving scraped content to Google Drive as '{filename}'...")
            # Code to upload file to Google Drive would go here
            # For simplicity in this example, we'll proceed directly to embedding

    # 3. Process files from Google Drive (and local 'data' for testing)
    # In a full implementation, this would list and download files from the Drive folder
    # For now, we'll just process the local files as before.
    print("\n2. Processing files and generating embeddings...")
    model = SentenceTransformer(MODEL_NAME)
    
    conn = psycopg2.connect(DATABASE_URL)
    setup_database(conn)
    with conn.cursor() as cursor:
        cursor.execute("TRUNCATE TABLE documents;") # Clear old data
        
        files_to_process = [f for f in os.listdir("data") if f.endswith('.txt')]
        for filename in files_to_process:
            filepath = os.path.join("data", filename)
            with open(filepath, 'r', encoding='utf-8') as f:
                file_content = f.read()
            
            chunks = chunk_text(file_content)
            if not chunks: continue

            print(f"  - Embedding '{filename}' ({len(chunks)} chunks)...")
            embeddings = model.encode(chunks)
            
            for i, chunk in enumerate(chunks):
                embedding_list = embeddings[i].tolist()
                cursor.execute(
                    "INSERT INTO documents (source_file, content, embedding) VALUES (%s, %s, %s)",
                    (filename, chunk, str(embedding_list))
                )
        conn.commit()
    conn.close()
    
    print("\n--- Pipeline Complete ---")

if __name__ == "__main__":
    main()