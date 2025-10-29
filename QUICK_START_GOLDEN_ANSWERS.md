# ⚡ Golden Answers - Quick Start (5 Minutes)

## 1️⃣ Install Dependencies (30 seconds)
```bash
cd /Users/roydi/Desktop/stakeholder-demo-mac/stakeholder-demo
pip install python-frontmatter
```

## 2️⃣ Set Environment Variables (if not already set)
```bash
export OPENAI_API_KEY="your-openai-key"
export POSTGRES_URL="your-neon-postgres-url"
```

## 3️⃣ Run Ingestion (2 minutes)
```bash
python scripts/ingest_md_to_neon.py
```

**Expected:** ✅ Success message, 1 file processed

## 4️⃣ Test Search (1 minute)
```bash
node scripts/test_search_gold.js "Can we hire remote developers from India?"
```

**Expected:** 🏆 Best match with similarity > 0.60

## 5️⃣ Verify in Database (30 seconds)
```sql
SELECT id, question, human_confidence, version FROM gold_answers;
```

**Expected:** 1 row: `H1B-remote-work`

---

## ✅ SUCCESS CRITERIA

**Phase 1 is complete when:**
- [ ] Ingestion runs without errors
- [ ] Database has 1 row in `gold_answers`
- [ ] Test script shows similarity > 0.60
- [ ] Embeddings are 1536 dimensions

---

## 🚀 What's Next?

**After validation:**
1. Add 2-3 more golden answers to `kb/questions/`
2. Re-run ingestion
3. Move to Phase 2 (chat.js integration)

---

## 📚 Full Documentation

- **`PHASE1_COMPLETE_SUMMARY.md`** - What was built, improvements, troubleshooting
- **`GOLDEN_ANSWERS_PHASE1.md`** - Detailed implementation guide
- **`kb/questions/H1B-remote-work.md`** - Example golden answer template

---

## 🆘 Quick Troubleshooting

| Error | Fix |
|-------|-----|
| `ModuleNotFoundError: frontmatter` | `pip install python-frontmatter` |
| `relation 'gold_answers' does not exist` | Run SQL schema (see Phase 1 doc) |
| `Cannot find module` | Run from project root |
| Low similarity scores | Verify embedding model is `text-embedding-3-small` |

---

**Ready? Run the 5 steps above!** ⚡

