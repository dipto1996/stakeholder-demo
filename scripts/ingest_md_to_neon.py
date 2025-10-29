#!/usr/bin/env python3
"""
ingest_md_to_neon.py
- Reads .md files from kb/questions
- Computes two embeddings: question_embedding and answer_embedding
- Upserts into public.gold_answers in Neon

Usage:
  python scripts/ingest_md_to_neon.py

Environment variables:
  OPENAI_API_KEY - OpenAI API key
  POSTGRES_URL - Neon PostgreSQL connection string
"""

import os
import json
import time
from pathlib import Path
import frontmatter
import psycopg2
from psycopg2.extras import execute_values
import openai

# Environment variables
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
NEON_DATABASE_URL = os.getenv("POSTGRES_URL")
EMBED_MODEL = "text-embedding-3-small"
MD_DIR = Path("kb/questions")

if not OPENAI_API_KEY or not NEON_DATABASE_URL:
    raise SystemExit("❌ Error: Set OPENAI_API_KEY and POSTGRES_URL env vars")

# Initialize OpenAI client
openai.api_key = OPENAI_API_KEY


def embed_text(text: str):
    """
    Create embedding using OpenAI API (same model as RAG system).
    Returns list of floats (1536 dimensions for text-embedding-3-small).
    """
    try:
        resp = openai.embeddings.create(model=EMBED_MODEL, input=text)
        return resp.data[0].embedding
    except Exception as e:
        print(f"❌ Embedding failed: {e}")
        raise


def upsert_gold(conn, row):
    """
    Upsert a gold answer into the database.
    On conflict (duplicate id), updates all fields and increments version.
    """
    sql = """
    INSERT INTO public.gold_answers
      (id, question, gold_answer, gold_claims, sources, 
       question_embedding, answer_embedding, 
       human_confidence, verified_by, last_verified, created_at, updated_at)
    VALUES (
      %(id)s, %(question)s, %(gold_answer)s, %(gold_claims)s, %(sources)s,
      %(qemb)s::vector, %(aemb)s::vector,
      %(human_confidence)s, %(verified_by)s, %(last_verified)s, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      question = EXCLUDED.question,
      gold_answer = EXCLUDED.gold_answer,
      gold_claims = EXCLUDED.gold_claims,
      sources = EXCLUDED.sources,
      question_embedding = EXCLUDED.question_embedding,
      answer_embedding = EXCLUDED.answer_embedding,
      human_confidence = EXCLUDED.human_confidence,
      verified_by = EXCLUDED.verified_by,
      last_verified = EXCLUDED.last_verified,
      version = public.gold_answers.version + 1,
      updated_at = now();
    """
    with conn.cursor() as cur:
        cur.execute(sql, row)
    conn.commit()


def parse_atomic_claims(content: str):
    """
    Extract atomic claims from markdown content.
    Looks for lines like "- claim text (critical: true)"
    Returns list of dicts: [{"text": "...", "critical": true}]
    """
    claims = []
    lines = content.split('\n')
    in_claims_section = False
    
    for line in lines:
        stripped = line.strip()
        
        # Detect claims section
        if '# Atomic claims' in line or '# atomic claims' in line.lower():
            in_claims_section = True
            continue
        
        # Stop at next section
        if in_claims_section and stripped.startswith('#'):
            break
        
        # Parse claim lines
        if in_claims_section and stripped.startswith('-'):
            # Extract claim text and critical flag
            claim_text = stripped[1:].strip()
            critical = False
            
            if '(critical:' in claim_text.lower():
                critical = 'true' in claim_text.lower()
                # Remove the (critical: ...) part
                claim_text = claim_text.split('(critical:')[0].strip()
            
            claims.append({
                "text": claim_text,
                "critical": critical,
                "source_doc_id": None
            })
    
    return claims


def main():
    print("=" * 60)
    print("Golden Answers Ingestion")
    print("=" * 60)
    
    # Connect to database
    print(f"📡 Connecting to Neon PostgreSQL...")
    try:
        conn = psycopg2.connect(NEON_DATABASE_URL)
        print("✅ Connected to database")
    except Exception as e:
        print(f"❌ Database connection failed: {e}")
        raise
    
    # Find markdown files
    md_files = list(MD_DIR.glob("*.md"))
    print(f"\n📂 Found {len(md_files)} markdown files in {MD_DIR}")
    
    if len(md_files) == 0:
        print("⚠️  No markdown files found. Create .md files in kb/questions/")
        conn.close()
        return
    
    print()
    
    # Process each file
    for idx, md_file in enumerate(md_files, 1):
        print(f"[{idx}/{len(md_files)}] Processing: {md_file.name}")
        
        try:
            # Parse frontmatter and content
            post = frontmatter.load(md_file)
            
            # Extract fields
            id = post.get('id')
            question = post.get('question', '')
            gold_answer = post.content.strip()  # Full markdown content
            sources = post.get('sources', [])
            verified_by = post.get('verified_by')
            last_verified = post.get('last_verified')
            human_confidence = float(post.get('human_confidence', 0.0))
            
            # Validation
            if not id:
                print(f"  ⚠️  Skipping: Missing 'id' in frontmatter")
                continue
            
            if not question:
                print(f"  ⚠️  Skipping: Missing 'question' in frontmatter")
                continue
            
            if not gold_answer:
                print(f"  ⚠️  Skipping: Empty content")
                continue
            
            print(f"  📝 ID: {id}")
            print(f"  ❓ Question: {question[:60]}{'...' if len(question) > 60 else ''}")
            print(f"  📊 Human confidence: {human_confidence}")
            
            # Parse atomic claims from content
            gold_claims = parse_atomic_claims(gold_answer)
            print(f"  📋 Extracted {len(gold_claims)} atomic claims")
            
            # Compute embeddings
            print(f"  🧮 Computing question embedding...")
            question_embedding = embed_text(question)
            
            print(f"  🧮 Computing answer embedding...")
            answer_embedding = embed_text(gold_answer)
            
            # Prepare row for database
            row = {
                "id": id,
                "question": question,
                "gold_answer": gold_answer,
                "gold_claims": json.dumps(gold_claims),
                "sources": json.dumps(sources),
                "qemb": question_embedding,
                "aemb": answer_embedding,
                "human_confidence": human_confidence,
                "verified_by": verified_by,
                "last_verified": last_verified
            }
            
            # Upsert to database
            print(f"  💾 Upserting to database...")
            upsert_gold(conn, row)
            print(f"  ✅ Success!\n")
            
            # Rate limiting (OpenAI has 3000 RPM limit for embeddings)
            time.sleep(0.2)
            
        except Exception as e:
            print(f"  ❌ Error processing {md_file.name}: {e}\n")
            continue
    
    # Close connection
    conn.close()
    
    print("=" * 60)
    print(f"✅ Ingestion complete! Processed {len(md_files)} files.")
    print("=" * 60)
    print("\nNext steps:")
    print("1. Verify entries in Neon:")
    print("   SELECT id, question, human_confidence FROM gold_answers;")
    print("2. Test searchGold function with sample queries")
    print("3. Enable USE_GOLD_KB feature flag after testing")


if __name__ == "__main__":
    main()

