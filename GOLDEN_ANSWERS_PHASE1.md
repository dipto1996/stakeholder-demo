# Golden Answers - Phase 1 Implementation Guide

## ✅ What's Been Created

### 1. Database Schema
**Table:** `public.gold_answers`
- Dual embeddings: `question_embedding` + `answer_embedding`
- `human_confidence` field (renamed from `confidence`)
- Version tracking with auto-increment on updates
- Indexes for fast KNN search

### 2. Directory Structure
```
kb/
└── questions/
    └── H1B-remote-work.md    # Example golden answer

scripts/
├── ingest_md_to_neon.py      # Ingestion script
└── test_search_gold.js       # Search test script

lib/rag/
└── searchGold.js             # Search implementation
```

### 3. Files Created

**requirements.txt** - Added `python-frontmatter>=1.0.0`

**kb/questions/H1B-remote-work.md** - Example golden answer with:
- Frontmatter (id, question, human_confidence, sources)
- Structured content (short answer, detailed guidance, key requirements)
- Atomic claims for evaluation

**scripts/ingest_md_to_neon.py** - Python ingestion script that:
- Reads all `.md` files from `kb/questions/`
- Computes dual embeddings (question + answer)
- Parses atomic claims from markdown
- Upserts to Neon with version tracking
- Uses same embedding model as RAG (`text-embedding-3-small`)

**lib/rag/searchGold.js** - Node.js search module that:
- Uses `@vercel/postgres` (consistent with existing code)
- Reuses `createQueryEmbedding()` from `retriever.js`
- Runs dual searches (question + answer) in parallel
- Merges results with weighted scoring
- Returns classification: `gold`, `gold_borderline`, or `rag`

**scripts/test_search_gold.js** - Test script for validation

---

## 🎯 Phase 1 Tasks (DO NOW)

### Step 1: Install Python Dependencies
```bash
cd /Users/roydi/Desktop/stakeholder-demo-mac/stakeholder-demo
pip install -r requirements.txt
```

### Step 2: Run Ingestion Script
```bash
# Make sure OPENAI_API_KEY and POSTGRES_URL are set
export OPENAI_API_KEY="your-key"
export POSTGRES_URL="your-neon-url"

python scripts/ingest_md_to_neon.py
```

**Expected output:**
```
============================================================
Golden Answers Ingestion
============================================================
📡 Connecting to Neon PostgreSQL...
✅ Connected to database

📂 Found 1 markdown files in kb/questions

[1/1] Processing: H1B-remote-work.md
  📝 ID: H1B-remote-work
  ❓ Question: Can we hire a developer in India to work remotely...
  📊 Human confidence: 0.0
  📋 Extracted 4 atomic claims
  🧮 Computing question embedding...
  🧮 Computing answer embedding...
  💾 Upserting to database...
  ✅ Success!

============================================================
✅ Ingestion complete! Processed 1 files.
============================================================
```

### Step 3: Verify in Database
```sql
SELECT id, question, human_confidence, version 
FROM public.gold_answers 
ORDER BY created_at DESC;
```

**Expected result:**
| id | question | human_confidence | version |
|----|----------|------------------|---------|
| H1B-remote-work | Can we hire a developer in India... | 0.0 | 1 |

### Step 4: Test Search Function
```bash
node scripts/test_search_gold.js "Can we hire remote developers from India?"
```

**Expected output:**
```
============================================================
Golden Answers Search Test
============================================================

🔍 Query: "Can we hire remote developers from India?"

📊 Search Results:
   Found 1 candidates
   Classification: gold_borderline
   Thresholds: high=0.75, low=0.60

🏆 Best Match:
   ID: H1B-remote-work
   Question: Can we hire a developer in India to work remotely and be paid in India only?
   Human Confidence: 0.0
   Similarity Scores:
     - Question: 0.9234 (dist: 0.0766)
     - Answer: 0.8512 (dist: 0.1488)
     - Combined: 0.7095
```

**Classification logic:**
- `combined >= 0.75` AND `human_confidence >= 0.50` → `gold`
- `combined >= 0.60` → `gold_borderline`
- Otherwise → `rag`

---

## ✅ Phase 1 Checklist

- [ ] Install Python dependencies
- [ ] Run `ingest_md_to_neon.py` successfully
- [ ] Verify row exists in `gold_answers` table
- [ ] Run `test_search_gold.js` with sample queries
- [ ] Test with paraphrased queries (e.g., "remote work from India on H1B")
- [ ] Test with different queries (ensure fallback to RAG works)
- [ ] Review search scores and thresholds

---

## 🔧 Configuration (Environment Variables)

### Current Defaults
```bash
GOLD_THRESHOLD=0.75         # Auto-serve threshold
GOLD_THRESHOLD_LOW=0.60     # Borderline threshold
HUMAN_CONF_THRESH=0.50      # Minimum human confidence
```

### Scoring Weights (in code)
- Question similarity: 60% (`wq = 0.6`)
- Answer similarity: 30% (`wa = 0.3`)
- Human confidence: 10% (`wh = 0.1`)

---

## 📝 Adding More Golden Answers

### Create a new `.md` file in `kb/questions/`:

```markdown
---
id: H1B-transfer-process
question: "What is the process to transfer H-1B to a new employer?"
verified_by: null
last_verified: null
human_confidence: 0.0
sources:
  - title: "USCIS H-1B Portability"
    url: "https://www.uscis.gov/working-in-the-united-states/h-1b"
    doc_id: null
    snapshot_url: null
    excerpt: "AC21 portability allows H-1B transfer before approval"
---
# Short answer
You can start working for the new employer as soon as they file Form I-129 (H-1B portability/AC21), without waiting for approval.

# Detailed guidance
- Step 1: New employer files Form I-129 with USCIS
- Step 2: You can begin work immediately upon filing (portability rule)
- Step 3: Maintain valid H-1B status until new petition is approved
- Step 4: If denied, you must stop working for new employer

# Atomic claims
- H-1B transfer allows portability (critical: true)
- Worker can start before approval (critical: true)
- Form I-129 must be filed by new employer (critical: true)
```

### Re-run ingestion:
```bash
python scripts/ingest_md_to_neon.py
```

---

## 🚨 Troubleshooting

### Error: "Table does not exist"
**Solution:** Run the SQL schema creation:
```sql
CREATE TABLE IF NOT EXISTS public.gold_answers (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  gold_answer TEXT NOT NULL,
  gold_answer_html TEXT,
  gold_claims JSONB,
  sources JSONB,
  question_embedding VECTOR(1536),
  answer_embedding VECTOR(1536),
  human_confidence FLOAT DEFAULT 0.0,
  verified_by TEXT,
  last_verified TIMESTAMP,
  version INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### Error: "Extension pgvector does not exist"
**Solution:** Enable in Neon console or run:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Low similarity scores
**Issue:** All queries getting low scores (< 0.60)
**Solution:** 
1. Verify embeddings are being created correctly
2. Check that same model is used (`text-embedding-3-small`)
3. Lower thresholds temporarily for testing

---

## 📊 Next Steps (Phase 2)

**After Phase 1 validation:**
1. Refactor existing RAG flow in `chat.js` into `runRagFlow()` function
2. Add feature flag `USE_GOLD_KB=false`
3. Integrate `searchGold()` into chat API
4. Test locally with feature flag enabled
5. Deploy to Vercel with flag disabled
6. Enable gradually (5% canary → full rollout)

---

## 🎯 Success Criteria

**Phase 1 is complete when:**
- ✅ At least 1 golden answer ingested successfully
- ✅ Database queries return expected embeddings
- ✅ `searchGold()` returns relevant results for paraphrased queries
- ✅ Similarity scores are in expected range (0.60-0.95 for good matches)
- ✅ Test script runs without errors

**DO NOT proceed to Phase 2 until all above criteria are met!**

---

## 📞 Need Help?

**Common issues:**
1. **OpenAI rate limits:** Script includes 0.2s delay between embeddings
2. **Database connection:** Verify `POSTGRES_URL` includes `?sslmode=require`
3. **Embedding dimension mismatch:** Must be 1536 for `text-embedding-3-small`

---

**Last updated:** Phase 1 implementation complete, awaiting validation.

