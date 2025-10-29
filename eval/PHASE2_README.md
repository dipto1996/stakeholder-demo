# RAG Evaluation System - Phase 2: Claim-Level Evaluation

## 🎯 What's New in Phase 2

Phase 2 adds **claim extraction** and **granular claim-level evaluation** to your RAG system.

### Phase 1 (Answer-Level):
- ✅ Compare whole answer to gold answer
- ❌ Can't track individual facts
- ❌ Can't detect partial hallucinations

### Phase 2 (Claim-Level):
- ✅ Extract atomic claims from answers
- ✅ Link each claim to source document
- ✅ Detect hallucinations (claims without sources)
- ✅ Track critical facts
- ✅ Precision/recall/F1 per claim
- ✅ Human review workflow (optional)

---

## 🏗️ Architecture

### Backend Changes:

**New Module:** `lib/claim_extractor.js`
- Extracts atomic factual claims from synthesized answers
- Links each claim to supporting source document
- Validates claims against documents

**Updated:** `lib/rag/synthesizer.js`
- Calls claim extractor after generating answer
- Returns `claims` array in addition to `answer` and `sources`

**Updated:** `pages/api/chat.js`
- Includes `claims` in API response:

```json
{
  "rag": {
    "answer": "H-1B requires bachelor's degree and costs $460...",
    "sources": [...],
    "claims": [
      {
        "id": "c1",
        "text": "H-1B requires a bachelor's degree",
        "source": {
          "title": "USCIS H-1B Guide",
          "url": "https://www.uscis.gov/h-1b",
          "snippet": "...specialty occupation requiring bachelor's..."
        },
        "verified": true,
        "critical": false
      },
      {
        "id": "c2",
        "text": "Filing fee is $460",
        "source": {...},
        "verified": true,
        "critical": false
      }
    ]
  },
  "path": "rag"
}
```

---

## 📊 New Metrics

### Claim-Level Metrics:

| Metric | Description | Good Target |
|--------|-------------|-------------|
| **Precision** | % of model claims that match gold claims | > 0.80 |
| **Recall** | % of gold claims found in model output | > 0.75 |
| **F1** | Harmonic mean of precision and recall | > 0.77 |
| **Hallucination Rate** | % of model claims without sources | < 0.10 |
| **Critical Fail Rate** | % of questions missing critical claims | < 0.05 |
| **Unverified Rate** | % of claims not verified against sources | < 0.15 |

---

## 🚀 Usage

### Workflow A: Automatic Evaluation (No Human Review)

```bash
# Step 1: Run API calls (same as Phase 1)
python call_and_save_api_v2.py \
  --eval eval.jsonl \
  --out model_outputs.jsonl \
  --endpoint https://your-url.vercel.app/api/chat

# Step 2: Claim-level evaluation
python evaluate_claim_level.py \
  --eval eval.jsonl \
  --model_out model_outputs.jsonl \
  --threshold 0.6

# Output:
# - eval_results_claim.json (summary metrics)
# - eval_details_claim.csv (per-question details)
```

### Workflow B: With Human Review (Highest Quality)

```bash
# Step 1: Run API calls
python call_and_save_api_v2.py \
  --eval eval.jsonl \
  --out model_outputs.jsonl \
  --endpoint https://your-url.vercel.app/api/chat

# Step 2: Generate review CSV
python to_review_csv.py \
  --model model_outputs.jsonl \
  --out review.csv

# Step 3: Human review (Google Sheets)
# - Upload review.csv to Google Sheets
# - Reviewers mark each claim as correct/incorrect
# - Download as review_labeled.csv

# Step 4: Merge human labels
python merge_labels.py \
  --model model_outputs.jsonl \
  --review review_labeled.csv \
  --out model_outputs_labeled.jsonl

# Step 5: Evaluate with human labels
python evaluate_claim_level.py \
  --eval eval.jsonl \
  --model_out model_outputs_labeled.jsonl \
  --threshold 0.6
```

---

## 📋 Review CSV Format

`review.csv` has one row per extracted claim:

| Column | Description | Reviewer Fills |
|--------|-------------|----------------|
| `id` | Question ID | - |
| `question` | The question | - |
| `claim_text` | The extracted claim | - |
| `claim_verified` | Auto-verified? | - |
| `source_title` | Source document | - |
| `source_url` | Source URL | - |
| **`label_match`** | Claim correct? | **yes/no/partial** |
| **`label_comment`** | Notes/corrections | **Free text** |
| **`citations_ok`** | Source appropriate? | **yes/no** |
| **`escalate_recommended`** | Needs attorney? | **yes/no** |

---

## 📈 Interpreting Results

### Example Output:

```json
{
  "summary": {
    "cases": 5,
    "precision": 0.85,
    "recall": 0.78,
    "f1": 0.81,
    "hallucination_rate": 0.12,
    "critical_fail_rate": 0.20,
    "unverified_rate": 0.08,
    "avg_claims_per_answer": 4.2
  }
}
```

### What This Means:

**Precision: 0.85** ✅
- 85% of model claims match gold claims
- Low false positives

**Recall: 0.78** ⚠️
- 78% of gold claims were found
- Missing 22% of expected facts

**F1: 0.81** ✅
- Good balance overall

**Hallucination Rate: 0.12** ⚠️
- 12% of claims lack source attribution
- Consider lowering synthesis creativity

**Critical Fail Rate: 0.20** ❌
- 20% of questions missing critical facts
- Need to improve retrieval or docs

**Unverified Rate: 0.08** ✅
- Only 8% of claims couldn't be verified
- Good source attribution

---

## 🔧 Configuration

### Enable/Disable Claim Extraction

Set in Vercel environment variables:

```bash
ENABLE_CLAIM_EXTRACTION=1  # Enable (default)
ENABLE_CLAIM_EXTRACTION=0  # Disable (revert to Phase 1)
```

### Adjust Extraction Parameters

Edit `lib/claim_extractor.js`:

```javascript
const claims = await extractClaims(answer, documents, {
  maxClaims: 10,  // Max claims per answer
  minClaimLength: 20  // Min characters per claim
});
```

---

## 🎓 Best Practices

### For Automatic Evaluation:

1. **Start with Phase 1** - Get baseline metrics first
2. **Add Phase 2** - Enable claim extraction
3. **Compare metrics** - Check if claims improve evaluation
4. **Tune threshold** - Adjust fuzzy matching sensitivity

### For Human Review:

1. **Review 10-20 questions** first (spot check)
2. **Use multiple reviewers** for inter-rater reliability
3. **Focus on critical claims** first
4. **Document patterns** in failing claims
5. **Feed back to docs** - Update documents based on findings

---

## 🐛 Troubleshooting

### No claims extracted?

**Check:**
- Is `ENABLE_CLAIM_EXTRACTION=1` in Vercel?
- Did synthesis complete successfully?
- Check logs: `[synthesizer] Extracting claims...`

**Solution:**
```bash
# Check Vercel logs for claim extraction
vercel logs

# Look for:
# [synthesizer] Extracting claims from answer...
# [synthesizer] Extracted 5 claims (4 verified)
```

### All claims marked as unverified?

**Problem:** Claims don't match source documents

**Check:**
- Are documents too short/truncated?
- Are excerpts meaningful?
- Is validation threshold too strict?

**Solution:** Edit `lib/claim_extractor.js`:
```javascript
// Lower threshold in validateClaims
if (matchRatio < 0.4) { // was 0.5
  return { ...claim, verified: false };
}
```

### Claim extraction slow?

**Problem:** Extra LLM call adds latency

**Solutions:**
1. Use smaller model: Change to `gpt-4o-mini` (already set)
2. Reduce max_tokens in `claim_extractor.js`
3. Disable for real-time use, enable for evaluation only

---

## 📊 Comparing Phase 1 vs Phase 2

Run both and compare:

```bash
# Phase 1 (answer-level)
python evaluate_answer_level.py \
  --eval eval.jsonl \
  --model_out model_outputs.jsonl

# Phase 2 (claim-level)
python evaluate_claim_level.py \
  --eval eval.jsonl \
  --model_out model_outputs.jsonl
```

**Phase 2 gives you:**
- More granular metrics
- Better hallucination detection
- Actionable insights per claim

**Phase 1 is faster but less detailed**

---

## 🔄 Iteration Loop

1. **Run Phase 2 evaluation**
2. **Review `eval_details_claim.csv`**
3. **Identify patterns:**
   - Which visa types have low recall?
   - Which claims are hallucinated?
   - Which documents are missing?
4. **Improve system:**
   - Add missing documents
   - Fix retrieval threshold
   - Update synthesis prompts
5. **Re-evaluate and compare**

---

## 📁 Files

```
eval/
├── PHASE2_README.md                  # This file
├── call_and_save_api_v2.py          # API caller (Phase 1 & 2)
├── evaluate_claim_level.py          # NEW: Claim-level evaluator
├── to_review_csv.py                 # NEW: Generate review CSV
├── merge_labels.py                  # NEW: Merge human labels
├── eval.jsonl                       # Eval dataset
├── model_outputs.jsonl              # API responses
├── eval_results_claim.json          # Claim-level metrics
├── eval_details_claim.csv           # Per-question claim details
├── review.csv                       # For human review (optional)
└── review_labeled.csv               # After human review
```

---

## ✅ Quick Start

```bash
# Activate environment
cd eval
source .venv/bin/activate

# Run Phase 2 evaluation
python call_and_save_api_v2.py \
  --eval eval.jsonl \
  --out model_outputs.jsonl \
  --endpoint https://your-url.vercel.app/api/chat

python evaluate_claim_level.py \
  --eval eval.jsonl \
  --model_out model_outputs.jsonl

# Review results
cat eval_results_claim.json | python -m json.tool
open eval_details_claim.csv
```

---

**Phase 2 is ready! Deploy and test!** 🚀

