# 🔒 PHASE 2: Golden Answers Integration Plan

## ⚠️ CRITICAL: This will modify `pages/api/chat.js`

---

## 📊 CURRENT FLOW (Existing):

```
User Query
    ↓
Greeting Check
    ↓
Query Router (refine query)
    ↓
Retrieve Candidates (from documents)
    ↓
If no candidates → FALLBACK
    ↓
Rerank Candidates
    ↓
Confidence Check → If low → FALLBACK
    ↓
Synthesize RAG Answer
    ↓
If synthesis has missing markers → FALLBACK
    ↓
Return RAG Answer with Sources
```

---

## 🎯 NEW FLOW (With Golden Answers):

```
User Query
    ↓
Greeting Check
    ↓
[NEW] Check USE_GOLD_KB flag → If false, skip to existing RAG flow
    ↓
[NEW] Search Golden Answers (parallel with Query Router + RAG Retrieval)
    ↓
[NEW] Evaluate Golden Match Score:
    - If score >= 0.75 AND human_confidence >= 0.50 → Return Golden Answer ✅
    - If score >= 0.60 → Return Golden Answer with borderline disclaimer
    - Else → Continue to RAG
    ↓
Query Router (refine query)
    ↓
Retrieve Candidates (from documents)
    ↓
[Rest of existing flow unchanged...]
```

---

## 📝 EXACT CHANGES TO `chat.js`:

### **CHANGE 1: Add Import (Line 9)**

**ADD THIS LINE:**
```javascript
import { searchGold, formatGoldSources } from "../../lib/rag/searchGold.js";
```

**After:**
```javascript
import { getGeneralAnswer } from "../../lib/rag/fallback.js";
```

---

### **CHANGE 2: Add Feature Flag Check (After line 106, before Router)**

**INSERT THIS CODE BLOCK:**
```javascript
// === GOLDEN ANSWERS LOOKUP ===
const USE_GOLD_KB = process.env.USE_GOLD_KB === "true";

if (USE_GOLD_KB) {
  try {
    console.log("[gold] Searching golden answers for:", userQuery);
    const goldResult = await searchGold(userQuery, { limit: 5 });
    
    if (goldResult.best) {
      console.log(`[gold] Best match: ${goldResult.best.id}, combined=${goldResult.best.combined.toFixed(4)}, classification=${goldResult.classification}`);
      
      // HIGH CONFIDENCE: Auto-serve golden answer
      if (goldResult.classification === "gold") {
        const formattedSources = formatGoldSources(goldResult.best.sources);
        return okJSON({
          rag: {
            answer: goldResult.best.gold_answer,
            sources: formattedSources
          },
          fallback: null,
          path: "gold",
          gold_metadata: {
            id: goldResult.best.id,
            question: goldResult.best.question,
            human_confidence: goldResult.best.human_confidence,
            combined_score: goldResult.best.combined,
            verified_by: goldResult.best.verified_by,
            last_verified: goldResult.best.last_verified
          }
        });
      }
      
      // BORDERLINE: Serve with disclaimer
      if (goldResult.classification === "gold_borderline") {
        const disclaimer = "⚠️ Note: This is a high-confidence match from our curated knowledge base, but pending final verification.\n\n";
        const formattedSources = formatGoldSources(goldResult.best.sources);
        return okJSON({
          rag: {
            answer: disclaimer + goldResult.best.gold_answer,
            sources: formattedSources
          },
          fallback: null,
          path: "gold_borderline",
          gold_metadata: {
            id: goldResult.best.id,
            question: goldResult.best.question,
            human_confidence: goldResult.best.human_confidence,
            combined_score: goldResult.best.combined
          }
        });
      }
      
      // LOW SCORE: Continue to RAG
      console.log(`[gold] Score too low (${goldResult.best.combined.toFixed(4)}), falling through to RAG`);
    } else {
      console.log("[gold] No golden answer candidates found, falling through to RAG");
    }
  } catch (goldErr) {
    console.warn("[gold] Golden answer search failed:", goldErr?.message || goldErr);
    // Continue to RAG on error
  }
}
// === END GOLDEN ANSWERS LOOKUP ===
```

---

## 🔍 WHAT THIS DOES:

### **If `USE_GOLD_KB=true`:**
1. **Searches golden answers** for the user query
2. **Calculates similarity scores** (question + answer embeddings)
3. **Three possible outcomes:**
   - **High score (≥ 0.75):** Return golden answer immediately ✅
   - **Borderline (≥ 0.60):** Return golden answer with disclaimer ⚠️
   - **Low score (< 0.60):** Continue to normal RAG flow 🔄

### **If `USE_GOLD_KB=false` (default):**
- **Nothing changes** - existing RAG flow works exactly as before

---

## 🛡️ SAFETY FEATURES:

1. **Feature Flag:** Can disable instantly by setting `USE_GOLD_KB=false`
2. **Try-Catch:** If golden search fails, continues to RAG (no breakage)
3. **Logging:** Detailed logs for monitoring and debugging
4. **Metadata:** Returns gold_metadata for tracking which golden answer was used
5. **Non-Breaking:** If flag is off, code is skipped entirely

---

## 📊 RESPONSE FORMAT CHANGES:

### **New Response Format (Golden Answer):**
```json
{
  "rag": {
    "answer": "# Short answer\nNo. H-1B requires U.S. worksite...",
    "sources": [
      {
        "id": 1,
        "title": "USCIS Form I-129 Instructions",
        "url": "https://www.uscis.gov/i-129",
        "excerpt": "H-1B specialty occupation requires U.S. worksite..."
      }
    ]
  },
  "fallback": null,
  "path": "gold",
  "gold_metadata": {
    "id": "H1B-remote-work",
    "question": "Can we hire a developer in India...",
    "human_confidence": 0.0,
    "combined_score": 0.7542,
    "verified_by": null,
    "last_verified": null
  }
}
```

### **Existing Response Format (RAG - unchanged):**
```json
{
  "rag": {
    "answer": "...",
    "sources": [...]
  },
  "fallback": null,
  "path": "rag"
}
```

**Frontend compatibility:** ✅ Golden responses use same structure as RAG responses!

---

## 🧪 TESTING PLAN:

### **Test 1: With `USE_GOLD_KB=false` (Default)**
```bash
# Set in .env.local
USE_GOLD_KB=false

# Start dev server
npm run dev

# Test query
# Expected: Normal RAG flow, no golden answers used
```

### **Test 2: With `USE_GOLD_KB=true` + Matching Query**
```bash
# Set in .env.local
USE_GOLD_KB=true

# Query: "Can we hire remote developers from India?"
# Expected: Golden answer returned (path="gold")
```

### **Test 3: With `USE_GOLD_KB=true` + Non-Matching Query**
```bash
USE_GOLD_KB=true

# Query: "What is the H-4 visa processing time?"
# Expected: Normal RAG flow (no golden answer for this)
```

### **Test 4: Frontend Compatibility**
```bash
# Verify UI displays golden answers correctly
# Check that sources are clickable
# Verify "Verified (RAG)" badge shows for golden answers
```

---

## 📋 ENVIRONMENT VARIABLES:

### **Development (`.env.local`):**
```bash
USE_GOLD_KB=false          # Default: disabled for safety
GOLD_THRESHOLD=0.75        # Optional: override default
GOLD_THRESHOLD_LOW=0.60    # Optional: override default
HUMAN_CONF_THRESH=0.50     # Optional: override default
```

### **Vercel Production:**
```bash
USE_GOLD_KB=false          # Keep disabled initially!
# Enable only after local testing and monitoring setup
```

---

## ⚠️ ROLLOUT CHECKLIST:

- [ ] Review this plan thoroughly
- [ ] Backup current `chat.js` (or commit to git first)
- [ ] Implement changes
- [ ] Test locally with `USE_GOLD_KB=false` (verify nothing broke)
- [ ] Test locally with `USE_GOLD_KB=true` (verify golden answers work)
- [ ] Test with multiple query variations
- [ ] Commit changes to git
- [ ] Deploy to Vercel with `USE_GOLD_KB=false`
- [ ] Verify deployment works (RAG still functions normally)
- [ ] Set up monitoring/logging dashboard
- [ ] Enable `USE_GOLD_KB=true` in Vercel
- [ ] Monitor for 24-48 hours
- [ ] Review logs for golden answer usage rates

---

## 🚨 ROLLBACK PLAN:

**If anything goes wrong:**

### **Immediate (Emergency):**
```bash
# In Vercel dashboard:
# Set USE_GOLD_KB=false
# Redeploy
```

### **Full Rollback:**
```bash
# Revert git commit
git revert HEAD

# Redeploy
vercel --prod
```

---

## ❓ QUESTIONS TO ANSWER BEFORE PROCEEDING:

1. **Do you want to proceed with these exact changes?**
2. **Should I create a backup of `chat.js` first?**
3. **Any modifications to the plan?**
4. **Ready for me to implement?**

---

**SAY "GO" AND I'LL IMPLEMENT EXACTLY AS DESCRIBED ABOVE.** 🚀

