# 🔧 CRITICAL FIX: Database Schema Missing

## ❌ ERROR:
```
column "question_embedding" of relation "gold_answers" does not exist
```

**This means the `gold_answers` table hasn't been created yet!**

---

## ✅ SOLUTION: Run SQL in Neon Dashboard

### **Step 1: Open Neon Dashboard**
1. Go to https://console.neon.tech
2. Select your project
3. Click "SQL Editor" in left sidebar

### **Step 2: Enable pgvector Extension (if not already enabled)**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Click "Run" ▶️

### **Step 3: Create gold_answers Table**
```sql
-- Create gold_answers table with dual embeddings
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

Click "Run" ▶️

### **Step 4: Create Indexes for Fast Search**
```sql
-- Index for question embedding search
CREATE INDEX IF NOT EXISTS idx_gold_qemb ON public.gold_answers 
  USING ivfflat (question_embedding vector_l2_ops) WITH (lists = 100);

-- Index for answer embedding search
CREATE INDEX IF NOT EXISTS idx_gold_aemb ON public.gold_answers 
  USING ivfflat (answer_embedding vector_l2_ops) WITH (lists = 100);
```

Click "Run" ▶️

### **Step 5: Verify Table Exists**
```sql
SELECT table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'gold_answers' 
ORDER BY ordinal_position;
```

**Expected output:** List of columns including `question_embedding` and `answer_embedding` with type `USER-DEFINED`

---

## 🔄 AFTER RUNNING SQL, Try Ingestion Again:

```bash
python3 scripts/ingest_md_to_neon.py
```

**Expected:**
```
✅ Success!
```

---

## 🧪 THEN Test Search:

```bash
node scripts/test_search_simple.js "Can we hire remote developers from India?"
```

---

## ⚠️ Troubleshooting

### **Issue: "extension 'vector' does not exist"**
**Solution:** Enable in Neon dashboard:
1. Go to project settings
2. Enable "pgvector" extension
3. Re-run SQL

### **Issue: "permission denied"**
**Solution:** Make sure you're using the owner connection string (not read-only)

### **Issue: "syntax error near 'VECTOR'"**
**Solution:** pgvector extension not enabled. Run:
```sql
CREATE EXTENSION vector;
```

---

## ✅ Success Criteria

- [ ] SQL runs without errors
- [ ] `SELECT * FROM gold_answers;` returns table structure (even if empty)
- [ ] Python ingestion completes without "column does not exist" error
- [ ] Test script shows search results

---

**Run the SQL above in Neon, then retry ingestion!** 🚀

