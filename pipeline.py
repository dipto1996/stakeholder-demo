import os
import re
import json
import gspread
import requests
import psycopg2
import openai
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# --- Configuration ---
load_dotenv()
DATABASE_URL = os.getenv("POSTGRES_URL")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID")
openai.api_key = os.getenv("OPENAI_API_KEY")

# Use the OpenAI model for consistency with the live API
EMBEDDING_MODEL = "text-embedding-3-small"
VECTOR_DIMENSION = 1536 # This must match the model's output dimension

# --- Google Authentication ---
def get_google_creds():
    creds_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not creds_json:
        raise ValueError("GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable not found.")
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
        cursor.execute("DROP TABLE IF EXISTS documents;") # Wipe old data
        cursor.execute(f"""
            CREATE TABLE documents (
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
            return main_content.get_text(separator='\\n', strip=True)
    except Exception as e:
        print(f"  - Failed to scrape {url}: {e}")
    return None

def chunk_text(text, chunk_size=2000, chunk_overlap=200):
    if not text: return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - chunk_overlap
    return chunks

# --- Main Pipeline Logic ---
def main():
    print("--- Starting Automated Data Pipeline (OpenAI Embeddings) ---")

    # For now, we will process local files to confirm the OpenAI embedding works.
    # The Google integration logic is ready for when we automate fully.

    conn = psycopg2.connect(DATABASE_URL)
    setup_database(conn)
    with conn.cursor() as cursor:
        files_to_process = [f for f in os.listdir("data") if f.endswith('.txt')]
        for filename in files_to_process:
            filepath = os.path.join("data", filename)
            with open(filepath, 'r', encoding='utf-8') as f:
                file_content = f.read()

            chunks = chunk_text(file_content)
            if not chunks: continue

            print(f"  - Embedding '{filename}' with OpenAI ({len(chunks)} chunks)...")
            response = openai.embeddings.create(model=EMBEDDING_MODEL, input=chunks)
            embeddings = [e.embedding for e in response.data]

            for i, chunk in enumerate(chunks):
                embedding = embeddings[i]
                cursor.execute(
                    "INSERT INTO documents (source_file, content, embedding) VALUES (%s, %s, %s)",
                    (filename, chunk, str(embedding))
                )
        conn.commit()
    conn.close()

    print("\\n--- Pipeline Complete ---")

if __name__ == "__main__":
    main()