# RAG Evaluation System - Phase 1

## Overview

This evaluation system measures your RAG system's performance at the **answer level** (Phase 1). It's adapted specifically for your API format and provides immediate, actionable metrics.

## What It Measures

### Core Metrics:
- ✅ **Answer Correctness** - Fuzzy similarity vs gold answers
- ✅ **RAG Usage Rate** - How often RAG vs fallback is used
- ✅ **Citation Rate** - Percentage of answers with sources
- ✅ **Latency** - Response time per query
- ✅ **Hallucination Proxy** - Detects numbers/facts not in gold answer

### Output Files:
- `model_outputs.jsonl` - All API responses with metadata
- `eval_results.json` - Summary metrics
- `eval_details.csv` - Per-question details (easy for reviewers)

---

## Setup

### 1. Install Dependencies

```bash
cd eval
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Set Your Endpoint

You'll need your API endpoint URL. For production:
```
https://your-app.vercel.app/api/chat
```

For local testing:
```
http://localhost:3000/api/chat
```

---

## Usage

### Step 1: Call API and Save Responses

```bash
python call_and_save_api_v2.py \
  --eval eval.jsonl \
  --out model_outputs.jsonl \
  --endpoint https://your-app.vercel.app/api/chat
```

**Options:**
- `--api_key_env YOUR_ENV_VAR` - If your API requires authentication

**What it does:**
- Calls your API for each question in `eval.jsonl`
- Normalizes responses (handles both RAG and fallback formats)
- Records latency, path taken, sources
- Saves to `model_outputs.jsonl`

**Expected time:** ~5-10 seconds per question (5 questions = ~1 minute)

---

### Step 2: Evaluate Results

```bash
python evaluate_answer_level.py \
  --eval eval.jsonl \
  --model_out model_outputs.jsonl \
  --threshold 0.6
```

**Options:**
- `--threshold 0.6` - Similarity threshold for "pass" (0.0-1.0)
- `--out_json eval_results.json` - JSON output file
- `--out_csv eval_details.csv` - CSV for human review

**What it does:**
- Compares model answers to gold answers
- Calculates fuzzy similarity scores
- Checks RAG usage and citation presence
- Detects potential hallucinations
- Outputs summary metrics and per-question details

---

## Understanding Results

### Example Output:

```json
{
  "summary": {
    "cases": 5,
    "pass_rate": 0.80,
    "rag_rate": 0.60,
    "citation_rate": 0.80,
    "avg_latency_ms": 2500.0
  }
}
```

### Metrics Explained:

| Metric | Meaning | Good Target |
|--------|---------|-------------|
| **pass_rate** | % answers above similarity threshold | > 0.70 |
| **rag_rate** | % using RAG (vs fallback) | > 0.60 |
| **citation_rate** | % answers with sources | > 0.80 |
| **avg_latency_ms** | Average response time | < 5000ms |

### CSV Columns:

Open `eval_details.csv` in Google Sheets or Excel:

- `id` - Question ID
- `question` - The question asked
- `gold_answer` - Expected answer
- `model_answer` - Your system's answer
- `similarity` - Similarity score (0.0-1.0)
- `pass` - TRUE/FALSE (above threshold?)
- `use_rag` - TRUE/FALSE (used RAG?)
- `citations_present` - TRUE/FALSE (has sources?)
- `hallucination_proxy` - TRUE/FALSE (suspicious facts?)
- `latency_ms` - Response time

---

## Interpreting Results

### 🎯 **Good Performance:**
```
pass_rate: 0.80+
rag_rate: 0.70+
citation_rate: 0.90+
avg_latency_ms: < 3000
```

### ⚠️ **Needs Improvement:**
```
pass_rate: < 0.60  → Answers don't match gold standard
rag_rate: < 0.40   → Falling back too often (need more docs?)
citation_rate: < 0.50  → Not providing sources
avg_latency_ms: > 8000  → Too slow
```

### 🔍 **What To Check:**

**Low RAG Rate:**
- Do you have enough documents in Neon DB?
- Are embeddings working?
- Is retrieval threshold too strict?

**Low Pass Rate:**
- Are gold answers realistic?
- Is threshold too high (try 0.5 instead of 0.6)?
- Are documents outdated?

**High Latency:**
- Too many retrieval candidates?
- Reranking taking too long?
- LLM synthesis slow?

---

## Next Steps

### After Phase 1:

1. **Review `eval_details.csv`**
   - Sort by `pass = FALSE`
   - Identify failing patterns
   - Update documents or tune retrieval

2. **Adjust Threshold**
   - If too many false negatives, lower `--threshold`
   - If too many false positives, raise it

3. **Expand Dataset**
   - Add more questions to `eval.jsonl`
   - Cover edge cases and new visa types

4. **Ready for Phase 2?**
   - Once baseline is good (pass_rate > 0.70)
   - Add claim extraction for granular metrics
   - Get claim-level evaluation

---

## Phase 2 Preview (Coming Next)

Phase 2 will add:
- ✅ **Claim Extraction** - Extract atomic claims from answers
- ✅ **Claim-Level Metrics** - Precision/recall per claim
- ✅ **Source Attribution** - Which claim came from which document?
- ✅ **Critical Claim Tracking** - Mark must-have facts
- ✅ **Hallucination Detection** - Detect unsupported claims

---

## Troubleshooting

### Error: "Connection refused"
- Check your API endpoint URL
- Is the service running?
- Try local: `http://localhost:3000/api/chat`

### Error: "Invalid response shape"
- Check `model_outputs.jsonl` for `raw_error` field
- Your API might return unexpected format
- Add debug logging to `normalize_response()`

### All questions fail
- Check if `gold_answer` format matches model output
- Try lowering `--threshold` to 0.4
- Inspect `eval_details.csv` to see actual answers

### Script hangs
- Ctrl+C to stop
- Check `model_outputs.jsonl` for partial results
- Add `--timeout 30` to limit per-request wait

---

## Files

```
eval/
├── README.md                       # This file
├── requirements.txt                # Python dependencies
├── call_and_save_api_v2.py        # Step 1: Call API
├── evaluate_answer_level.py       # Step 2: Evaluate
├── eval.jsonl                     # Input: Questions + gold answers
├── model_outputs.jsonl            # Output: API responses
├── eval_results.json              # Output: Summary metrics
└── eval_details.csv               # Output: Per-question details
```

---

## Quick Start

```bash
# Setup
cd eval
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run evaluation (replace with your URL)
python call_and_save_api_v2.py \
  --eval eval.jsonl \
  --out model_outputs.jsonl \
  --endpoint https://your-app.vercel.app/api/chat

# Analyze results
python evaluate_answer_level.py \
  --eval eval.jsonl \
  --model_out model_outputs.jsonl

# Review
cat eval_results.json
open eval_details.csv
```

---

## Support

Questions? Check:
1. Your API response format matches expected shape
2. `eval.jsonl` has valid JSON (one object per line)
3. Dependencies installed (`pip list`)

---

**Happy Evaluating!** 🎯

