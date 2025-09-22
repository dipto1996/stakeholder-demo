# This is the final corrected content for embed.py
# It fixes the indentation syntax error.
import os
import openai
import psycopg2
from dotenv import load_dotenv
import re

# --- Configuration ---
load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY")
DATABASE_URL = os.getenv("POSTGRES_URL")
EMBEDDING_MODEL = "text-embedding-3-small"
TEXT_SOURCE_DIR = "data"

def setup_database():
    """Connects to the database and creates the correct table schema."""
    print("Connecting to the database...")
    conn = psycopg2.connect(DATABASE_URL)
    cursor = conn.cursor()
    try:
        print("Ensuring 'vector' extension is enabled...")
        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector;")

        print("Setting up 'documents' table...")
        cursor.execute("DROP TABLE IF EXISTS documents;")
        cursor.execute("""
            CREATE TABLE documents (
                id SERIAL PRIMARY KEY,
                source_file TEXT,
                content TEXT,
                embedding VECTOR(1536)
            );
        """)

        conn.commit()
    finally:
        cursor.close()
        conn.close()
    print("Database setup complete.")

def chunk_text(text, chunk_size=2000, chunk_overlap=200):
    """Splits text into overlapping chunks based on character count."""
    if not text:
        return []

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - chunk_overlap
    return chunks

def main():
    """Main function to read, chunk, embed, and store documents."""
    print("\n--- Starting Embedding Process (v4) ---")
    setup_database()

    conn = psycopg2.connect(DATABASE_URL)
    cursor = conn.cursor()
    try:
        files_to_process = [f for f in os.listdir(TEXT_SOURCE_DIR) if f.endswith('.txt')]
        for filename in files_to_process:
            filepath = os.path.join(TEXT_SOURCE_DIR, filename)
            print(f"\nProcessing file: {filename}...")
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

            chunks = chunk_text(content)
            if not chunks:
                print("  - No content to embed. Skipping.")
                continue
            print(f"  - Split into {len(chunks)} chunks.")

            print("  - Creating embeddings with OpenAI...")
            response = openai.embeddings.create(model=EMBEDDING_MODEL, input=chunks)
            embeddings = [e.embedding for e in response.data]

            print(f"  - Storing {len(embeddings)} vectors in the database...")
            for i, chunk in enumerate(chunks):
                embedding = embeddings[i]
                cursor.execute(
                    "INSERT INTO documents (source_file, content, embedding) VALUES (%s, %s, %s)",
                    (filename, chunk, str(embedding))
                )
            conn.commit()
            print(f"  - Successfully stored embeddings for {filename}.")
    finally:
        cursor.close()
        conn.close()

    print("\n--- Embedding Process Complete ---")

if __name__ == "__main__":
    main()