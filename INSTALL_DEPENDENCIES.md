# New Dependencies to Install

## Required Packages

Run this command to install the new dependencies:

```bash
npm install zod
```

## Optional (For Production Rate Limiting with Redis)

If you want production-ready rate limiting with Upstash Redis:

```bash
npm install @upstash/ratelimit @upstash/redis
```

Then:
1. Sign up at [upstash.com](https://upstash.com/)
2. Create a Redis database
3. Add environment variables to Vercel:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Uncomment the Upstash code in `/lib/rateLimit.js`

## Optional (For Error Tracking)

For production error tracking with Sentry:

```bash
npm install @sentry/nextjs
```

Then:
1. Sign up at [sentry.io](https://sentry.io/)
2. Follow their Next.js setup guide
3. Add Sentry DSN to environment variables

## Summary of Changes

### New Files Created:
- ✅ `/pages/api/cred_check.js` - Credibility checking endpoint
- ✅ `/pages/api/health.js` - Health check endpoint
- ✅ `/lib/validation.js` - Zod validation schemas
- ✅ `/lib/rateLimit.js` - Rate limiting utilities
- ✅ `/components/ErrorBoundary.jsx` - Error boundary component

### Modified Files:
- ✅ `/pages/_app.js` - Added ErrorBoundary wrapper
- ✅ `/pages/api/chat.js` - Performance optimizations
- ✅ `/pages/api/user/me.js` - Fixed import bug
- ✅ `/lib/rag/synthesizer.js` - Faster model
- ✅ `/lib/rag/fallback.js` - Faster model

## Current Status

### ✅ Implemented (No external action needed):
- Performance optimizations (GPT-4o → GPT-4o-mini)
- Optional URL verification
- Skip router for short queries
- Error boundary component
- Health check endpoint
- Cred check endpoint (for BYPASS_RAG mode)
- Validation schemas (need to install Zod)
- Rate limiting utilities (in-memory for now)

### ⏳ Requires Action:
1. **Install Zod:** `npm install zod`
2. **Commit & Push:** Git commands to deploy
3. **Set Environment Variable:** `SKIP_URL_VERIFY=1` in Vercel
4. **Redeploy:** Trigger deployment

### 🔮 Future (Optional):
- Install Upstash for production rate limiting
- Install Sentry for error tracking
- Add more monitoring tools

## Installation Steps

### Step 1: Install Required Package
```bash
cd /Users/roydi/Desktop/stakeholder-demo-mac/stakeholder-demo
npm install zod
```

### Step 2: Commit Changes
```bash
git add .
git commit -m "feat: add validation, rate limiting, error handling, and cred_check endpoint"
git push origin feature/cred-check
```

### Step 3: Configure Vercel
1. Go to Vercel dashboard
2. Add environment variable: `SKIP_URL_VERIFY=1`
3. Redeploy

### Step 4: Test
- Open your app
- Test chat functionality
- Check `/api/health` endpoint

## What's Working Now

### Without Installing Anything:
- ✅ Performance fixes (already applied)
- ✅ Error boundary (catches React errors)
- ✅ Health check endpoint
- ✅ Cred check endpoint

### After Installing Zod:
- ✅ Input validation on all API routes (commented examples in validation.js)
- ✅ Protection against malformed requests
- ✅ Better error messages

### After Installing Upstash (Optional):
- ✅ Production-ready rate limiting
- ✅ Works across multiple serverless instances
- ✅ Persistent rate limit tracking

## Testing the New Features

### Test Health Check:
```bash
curl https://your-domain.vercel.app/api/health
```

Expected: JSON with status of all services

### Test Cred Check:
```bash
curl -X POST https://your-domain.vercel.app/api/cred_check \
  -H "Content-Type: application/json" \
  -d '{
    "answer_text": "Test answer",
    "claims": [{"id": "c1", "text": "Test claim"}],
    "citations": [{"claim_id": "c1", "urls": [{"url": "https://uscis.gov"}]}]
  }'
```

Expected: JSON with credibility decision

### Test Error Boundary:
- Temporarily break something in your React code
- Should show nice error page instead of blank screen

## Documentation References

- **Validation:** See `/lib/validation.js` for all schemas
- **Rate Limiting:** See `/lib/rateLimit.js` for usage examples
- **Error Handling:** See `/components/ErrorBoundary.jsx`
- **Health Check:** See `/pages/api/health.js`
- **Cred Check:** See `/pages/api/cred_check.js`

---

**Ready to install?** Run `npm install zod` and you're good to go! 🚀

