# 🔧 Fixed Commands - Golden Answers Phase 1

## ❌ Issues Found:

1. **Virtual environment conflict:** You were in `eval/.venv` which doesn't have `psycopg2`
2. **Node.js ES module issue:** `.js` files need special handling

---

## ✅ CORRECT COMMANDS (Copy-Paste These):

### **Step 1: Exit virtual environment**
```bash
deactivate
```

### **Step 2: Navigate to project root**
```bash
cd /Users/roydi/Desktop/stakeholder-demo-mac/stakeholder-demo
```

### **Step 3: Install psycopg2 (system Python)**
```bash
pip3 install psycopg2-binary python-frontmatter
```

**Alternative if pip3 not found:**
```bash
python3 -m pip install psycopg2-binary python-frontmatter
```

### **Step 4: Set environment variables**
```bash
export OPENAI_API_KEY="your-openai-key-here"
export POSTGRES_URL="your-neon-postgres-url-here"
```

### **Step 5: Run ingestion**
```bash
python3 scripts/ingest_md_to_neon.py
```

### **Step 6: Test search (using .mjs file)**
```bash
node scripts/test_search_gold.mjs "Can we hire remote developers from India?"
```

---

## 📋 Full Sequence (One Block):

```bash
# Exit virtual env if active
deactivate 2>/dev/null || true

# Navigate to project
cd /Users/roydi/Desktop/stakeholder-demo-mac/stakeholder-demo

# Install dependencies (system Python)
pip3 install psycopg2-binary python-frontmatter

# Set env vars (replace with your actual values)
export OPENAI_API_KEY="sk-..."
export POSTGRES_URL="postgresql://..."

# Run ingestion
python3 scripts/ingest_md_to_neon.py

# Test search
node scripts/test_search_gold.mjs "Can we hire remote developers from India?"
```

---

## ⚠️ Important Notes:

1. **Use `python3` not `python`** (macOS uses Python 2 by default)
2. **Use `.mjs` extension** for the test script (forces ES module mode)
3. **Don't run from virtual environment** (use system Python)
4. **Set environment variables** before running scripts

---

## 🔍 Check Your Environment Variables:

```bash
echo $OPENAI_API_KEY
echo $POSTGRES_URL
```

**Should output:**
- `sk-...` (OpenAI key)
- `postgresql://...` (Neon URL)

If empty, set them first!

---

## ✅ Expected Success Output:

### **Ingestion:**
```
============================================================
Golden Answers Ingestion
============================================================
📡 Connecting to Neon PostgreSQL...
✅ Connected to database

📂 Found 1 markdown files in kb/questions

[1/1] Processing: H1B-remote-work.md
  📝 ID: H1B-remote-work
  ❓ Question: Can we hire a developer in India...
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

### **Search Test:**
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
   Question: Can we hire a developer in India...
   Similarity Scores:
     - Question: 0.9234 (very high!)
     - Answer: 0.8512
     - Combined: 0.7095
```

---

## 🆘 Still Having Issues?

### **Issue: `pip3: command not found`**
**Solution:**
```bash
python3 -m pip install psycopg2-binary python-frontmatter
```

### **Issue: `python3: command not found`**
**Solution:** Install Python 3 or use:
```bash
which python
# Then use that path
```

### **Issue: `OPENAI_API_KEY not set`**
**Solution:** Get your key from https://platform.openai.com/api-keys

### **Issue: `POSTGRES_URL not set`**
**Solution:** Get connection string from Neon dashboard

---

**Try the commands above and report back!** 🚀

