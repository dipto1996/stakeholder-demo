import os
import psycopg2
from dotenv import load_dotenv
import re
from sentence_transformers import SentenceTransformer
import numpy as np # Import numpy

# --- Configuration ---
load_dotenv()
DATABASE_URL = os.getenv("POSTGRES_URL")
MODEL_NAME = 'all-MiniLM-L6-v2' 
VECTOR_DIMENSION = 384
TEXT_SOURCE_DIR = "data"

def setup_database():
    """Connects to the database and creates the correct table schema for the local model."""
    print("Connecting to the database...")
    conn = psycopg2.connect(DATABASE_URL)
    cursor = conn.cursor()
    try:
        print("Ensuring 'vector' extension is enabled...")
        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        print(f"Setting up 'documents' table for vectors of dimension {VECTOR_DIMENSION}...")
        cursor.execute("DROP TABLE IF EXISTS documents;")
        cursor.execute(f"""
            CREATE TABLE documents (
                id SERIAL PRIMARY KEY,
                source_file TEXT,
                content TEXT,
                embedding VECTOR({VECTOR_DIMENSION})
            );
        """)
        conn.commit()
    finally:
        cursor.close()
        conn.close()
    print("Database setup complete.")

def chunk_text(text, chunk_size=1000, chunk_overlap=150):
    """Splits text into overlapping chunks based on character count."""
    if not text: return []
    chunks, start = [], 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - chunk_overlap
    return chunks

def main():
    """Main function to read, chunk, embed locally, and store documents."""
    print("\n--- Starting Local Embedding Process (v2) ---")
    setup_database()

    print(f"\nLoading local model: '{MODEL_NAME}'...")
    model = SentenceTransformer(MODEL_NAME)
    print("Model loaded successfully.")

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

            print("  - Creating embeddings locally...")
            embeddings = model.encode(chunks)

            print(f"  - Storing {len(embeddings)} vectors in the database...")
            for i, chunk in enumerate(chunks):
                # THIS IS THE CORRECTED LINE:
                embedding_list = embeddings[i].tolist()
                cursor.execute(
                    "INSERT INTO documents (source_file, content, embedding) VALUES (%s, %s, %s)",
                    (filename, chunk, str(embedding_list))
                )
            conn.commit()
            print(f"  - Successfully stored embeddings for {filename}.")
    finally:
        cursor.close()
        conn.close()

    print("\n--- Local Embedding Process Complete ---")

if __name__ == "__main__":
    main()