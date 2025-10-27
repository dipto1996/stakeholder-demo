# Performance Fixes Applied

## Problem
The `/api/chat` endpoint was timing out (504 Gateway Timeout) on Vercel because the RAG pipeline was taking longer than the serverless function time limit (10s on Hobby, 60s on Pro).

## Root Causes
1. **Multiple Sequential OpenAI API calls** (5-8 calls per request):
   - Router → Retriever → Reranker → Synthesizer → Fallback
   - Each adds 1-3 seconds

2. **URL Verification was extremely slow**:
   - Checking up to 6 URLs with 2-second timeouts
   - Could add 12+ seconds to response time

3. **Using GPT-4o for synthesis**:
   - GPT-4o takes 3-5 seconds per request
   - GPT-4o-mini is 3-5x faster with similar quality

## Fixes Applied

### 1. Optimized Model Usage
**Changed in:**
- `/lib/rag/synthesizer.js`
- `/lib/rag/fallback.js`

**Changes:**
- Switched from `gpt-4o` → `gpt-4o-mini` (3-5x faster)
- Reduced `max_tokens` from 800 → 600 (faster generation)

### 2. Made URL Verification Optional
**Changed in:**
- `/pages/api/chat.js`

**Changes:**
- Added `SKIP_URL_VERIFY` environment variable flag
- When enabled, skips slow URL verification (saves 6-12 seconds)
- Reduced verification from 6 URLs → 4 URLs
- Reduced timeout from 2000ms → 1500ms per URL

### 3. Skip Router for Short Queries
**Changed in:**
- `/pages/api/chat.js`

**Changes:**
- Skip query router for queries with ≤5 words
- Saves 1-2 seconds on simple questions

## Environment Variables to Add in Vercel

Add these to your Vercel environment variables:

```bash
# CRITICAL: Skip URL verification for faster responses
SKIP_URL_VERIFY=1

# Optional: Skip RAG and use LLM + cred-check
# BYPASS_RAG=1

# Optional: Include debug payload
# DEBUG_RAG=1
```

## How to Deploy

1. **Commit these changes:**
   ```bash
   git add .
   git commit -m "fix: optimize performance to prevent timeout"
   git push origin feature/cred-check
   ```

2. **Add environment variable in Vercel:**
   - Go to your Vercel dashboard
   - Project settings → Environment Variables
   - Add: `SKIP_URL_VERIFY` = `1`
   - Redeploy

3. **Test the changes:**
   - Ask a simple question in the chat
   - Response should come back in <10 seconds

## Expected Performance Improvements

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Router (short queries) | 1-2s | 0s (skipped) | ✅ 100% |
| Synthesis (GPT-4o → mini) | 3-5s | 1-2s | ✅ 60-70% |
| Fallback (GPT-4o → mini) | 2-4s | 1-1.5s | ✅ 50-60% |
| URL verification | 6-12s | 0s (skipped) | ✅ 100% |
| **Total typical request** | **15-25s** | **4-8s** | ✅ **70-80% faster** |

## Additional Recommendations

### Short-term (Next Sprint)
1. **Enable Vercel Pro** if on Hobby plan (10s → 60s timeout)
2. **Add caching** for embeddings and reranker results
3. **Implement streaming responses** (start showing answer before completion)
4. **Add request timeouts** for each stage

### Long-term (Future Sprints)
1. **Move to edge runtime** where possible
2. **Implement background jobs** for non-critical operations
3. **Add Redis cache** for frequently asked questions
4. **Batch OpenAI calls** where possible
5. **Pre-compute embeddings** for common queries

## Monitoring

Check Vercel function logs for:
- Execution time: Should be <10s (Hobby) or <60s (Pro)
- OpenAI API latency: Should be <2s per call
- Database query time: Should be <1s

## Rollback Plan

If issues arise:
```bash
git revert HEAD
git push origin feature/cred-check
```

Or remove the environment variable:
- Delete `SKIP_URL_VERIFY` from Vercel settings
- Redeploy

---

**Applied on:** October 27, 2025  
**Branch:** feature/cred-check  
**Status:** Ready for testing

