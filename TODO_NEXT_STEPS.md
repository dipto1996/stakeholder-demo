# TODO: Next Steps for stakeholder-demo

## ✅ COMPLETED (October 27, 2025)

### Performance Fixes (Critical - Branch: feature/cred-check)
- [x] Identified 504 timeout issue (FUNCTION_INVOCATION_TIMEOUT)
- [x] Switched GPT-4o → GPT-4o-mini (3-5x faster)
- [x] Made URL verification optional (saves 6-12 seconds)
- [x] Skip query router for short queries (saves 1-2 seconds)
- [x] Reduced max_tokens 800 → 600 (faster generation)
- [x] Created PERFORMANCE_FIXES.md documentation
- [x] Created VERCEL_DEPLOYMENT_GUIDE.md

**Expected Improvement:** 70-80% faster (15-25s → 4-8s)

---

## 🚨 CRITICAL - Do These First

### 1. Deploy Performance Fixes to Vercel
**Priority:** URGENT  
**Time:** 5 minutes  
**Branch:** feature/cred-check

**Steps:**
1. Commit changes: `git add . && git commit -m "fix: optimize performance"`
2. Push: `git push origin feature/cred-check`
3. Add `SKIP_URL_VERIFY=1` in Vercel environment variables
4. Redeploy application
5. Test with simple question

**Success Criteria:** Response in <10 seconds, no timeout

---

### 2. Fix Import Error in user/me.js
**Priority:** HIGH  
**Time:** 2 minutes  
**Status:** Bug found during code review

**File:** `/pages/api/user/me.js` line 4

**Current (BROKEN):**
```javascript
import authOptions from "../auth/[...nextauth]";
```

**Should be:**
```javascript
import { authOptions } from "../auth/[...nextauth]";
```

**Impact:** Profile page will crash

---

### 3. Implement Missing /api/cred_check Endpoint
**Priority:** HIGH (for feature/cred-check branch)  
**Time:** 1-2 hours  
**Status:** Referenced but not implemented

**File:** Referenced in `/pages/api/chat.js` line 221

**What it needs to do:**
1. Accept JSON with claims and citations
2. Verify claims against authoritative sources
3. Return credibility score and decision (verified/probable/reject)

**Create:** `/pages/api/cred_check.js`

---

## ⚠️ HIGH PRIORITY - Security & Stability

### 4. Add Rate Limiting
**Priority:** HIGH  
**Time:** 2-3 hours  
**Current Risk:** API abuse, high OpenAI costs

**Recommendation:**
```javascript
// Use @upstash/ratelimit with Redis
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "1 m"), // 10 requests per minute
});
```

**Apply to:** All API routes (especially /api/chat)

---

### 5. Add Input Validation
**Priority:** MEDIUM-HIGH  
**Time:** 1-2 hours  
**Current Risk:** Injection attacks, crashes

**Recommendation:**
- Install Zod: `npm install zod`
- Validate all API inputs
- Example:
```javascript
import { z } from 'zod';

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(2000)
  })).min(1)
});
```

---

### 6. Add Error Boundaries (Frontend)
**Priority:** MEDIUM  
**Time:** 1 hour  
**Current Issue:** Crashes show blank page

**Create:** `/components/ErrorBoundary.jsx`
**Wrap:** `_app.js` Component

---

## 💡 FEATURE ENHANCEMENTS

### 7. Implement Streaming Responses
**Priority:** MEDIUM  
**Time:** 3-4 hours  
**Benefit:** Better UX, appears faster

**Changes needed:**
- Modify `/api/chat` to use SSE (Server-Sent Events)
- Update frontend to handle streaming
- Use OpenAI streaming mode

---

### 8. Add Conversation Search
**Priority:** LOW-MEDIUM  
**Time:** 2-3 hours  
**User request:** "Can I search my old chats?"

**Implementation:**
- Add search box in sidebar
- Full-text search on messages
- SQL: `WHERE messages::text ILIKE '%search%'`

---

### 9. Add Analytics & Monitoring
**Priority:** MEDIUM  
**Time:** 2-3 hours  
**Current Issue:** No visibility into usage

**Options:**
- Vercel Analytics (free)
- Posthog (open source)
- Mixpanel

**Track:**
- Questions asked
- Response times
- RAG vs fallback usage
- User engagement

---

### 10. Add Caching Layer
**Priority:** MEDIUM  
**Time:** 3-4 hours  
**Benefit:** Faster responses for common questions

**Implementation:**
- Use Redis (Vercel KV or Upstash)
- Cache:
  - Embeddings for common queries
  - Reranker results
  - Complete answers for FAQs
- TTL: 24 hours

---

## 🔧 CODE QUALITY IMPROVEMENTS

### 11. Add Unit Tests
**Priority:** LOW-MEDIUM  
**Time:** 4-6 hours  
**Current Coverage:** 0%

**Framework:** Jest + React Testing Library

**Test:**
- RAG pipeline stages
- API endpoints (with mocks)
- React components

---

### 12. Add API Documentation
**Priority:** LOW  
**Time:** 2-3 hours  

**Tool:** Swagger/OpenAPI

**Document:**
- All API endpoints
- Request/response schemas
- Authentication requirements

---

### 13. Implement Logging
**Priority:** MEDIUM  
**Time:** 2 hours  
**Current Issue:** Only console.log

**Recommendations:**
- Structured logging (Winston or Pino)
- Log levels (debug, info, warn, error)
- Log aggregation (Vercel Log Drains)

---

## 📊 DATABASE OPTIMIZATIONS

### 14. Add Database Indexes
**Priority:** MEDIUM  
**Time:** 30 minutes  
**Benefit:** Faster queries

**SQL to run:**
```sql
-- Index for user lookups
CREATE INDEX idx_users_email ON users(email);

-- Index for conversation queries
CREATE INDEX idx_conversations_user_created ON conversations(user_id, created_at DESC);

-- Index for vault files
CREATE INDEX idx_vault_files_user ON vault_files(user_id);

-- Index for document searches (if not using vector index)
CREATE INDEX idx_documents_content ON documents USING gin(to_tsvector('english', content));
```

---

### 15. Add Database Migrations
**Priority:** LOW-MEDIUM  
**Time:** 2-3 hours  
**Current Issue:** Schema changes are manual

**Tool:** Prisma or node-pg-migrate

**Benefit:** Version-controlled schema changes

---

## 🎨 UI/UX IMPROVEMENTS

### 16. Add Loading States
**Priority:** LOW  
**Time:** 1 hour  

**Improvements:**
- Skeleton loaders instead of "loading..."
- Progress indicators for long operations
- Animated dots for "Thinking..."

---

### 17. Add Toast Notifications
**Priority:** LOW  
**Time:** 1 hour  

**Use:** react-hot-toast or sonner

**Replace:** `alert()` calls with nice toasts

---

### 18. Mobile Responsive Design
**Priority:** LOW-MEDIUM  
**Time:** 3-4 hours  
**Current Issue:** Sidebar doesn't adapt on mobile

**Fix:**
- Collapsible sidebar on mobile
- Hamburger menu
- Touch-friendly buttons

---

## 🔐 SECURITY HARDENING

### 19. Add CSRF Protection
**Priority:** MEDIUM  
**Time:** 1 hour  

**Check:** NextAuth already provides some CSRF protection

**Verify:** All state-changing endpoints use POST

---

### 20. Add Content Security Policy
**Priority:** LOW-MEDIUM  
**Time:** 1 hour  

**Add to:** `next.config.mjs`

```javascript
async headers() {
  return [{
    source: '/(.*)',
    headers: [
      {
        key: 'Content-Security-Policy',
        value: "default-src 'self'; ..."
      }
    ]
  }]
}
```

---

## 📦 DEPLOYMENT & INFRASTRUCTURE

### 21. Set Up Staging Environment
**Priority:** MEDIUM  
**Time:** 1 hour  

**Create:**
- staging branch
- Separate Vercel project
- Separate database

---

### 22. Add Health Check Endpoint
**Priority:** LOW-MEDIUM  
**Time:** 30 minutes  

**Create:** `/api/health`

**Check:**
- Database connection
- OpenAI API availability
- S3 connection

---

### 23. Set Up Monitoring Alerts
**Priority:** MEDIUM  
**Time:** 1 hour  

**Use:** Vercel monitoring or Better Uptime

**Alert on:**
- API errors > 5%
- Response time > 10s
- 500 errors

---

## 🧪 TESTING & QA

### 24. End-to-End Tests
**Priority:** LOW  
**Time:** 4-6 hours  

**Framework:** Playwright or Cypress

**Test:**
- User signup flow
- Ask question → get answer
- Save conversation
- Upload to vault

---

### 25. Load Testing
**Priority:** LOW-MEDIUM  
**Time:** 2 hours  

**Tool:** k6 or Artillery

**Test:**
- Concurrent users
- Response times under load
- Database connection limits

---

## 💰 COST OPTIMIZATION

### 26. Monitor OpenAI Costs
**Priority:** HIGH  
**Time:** 1 hour  

**Action:**
- Set up OpenAI usage alerts
- Track cost per query
- Set monthly budget limit

---

### 27. Optimize Token Usage
**Priority:** MEDIUM  
**Time:** 2-3 hours  

**Ideas:**
- Truncate long context more aggressively
- Cache common responses
- Use cheaper models where possible

---

## 📝 DOCUMENTATION

### 28. Add Architecture Diagram
**Priority:** LOW  
**Time:** 1 hour  

**Tool:** Excalidraw or Mermaid

**Show:**
- Frontend → API → Database flow
- RAG pipeline stages
- External services (OpenAI, S3, etc.)

---

### 29. Add Developer Setup Guide
**Priority:** MEDIUM  
**Time:** 1 hour  

**Include:**
- Local development setup
- Environment variables needed
- Database setup
- Running tests

---

### 30. Add User Documentation
**Priority:** LOW  
**Time:** 2-3 hours  

**Create:**
- FAQ page
- How-to guides
- Video tutorials

---

## 🎯 PRIORITY SUMMARY

### Week 1 (This Week):
1. ✅ **Deploy performance fixes** (DONE - needs deployment)
2. Fix import error in user/me.js
3. Implement /api/cred_check endpoint
4. Add rate limiting
5. Add input validation

### Week 2:
6. Add error boundaries
7. Implement streaming responses
8. Add database indexes
9. Add monitoring & logging
10. Set up staging environment

### Week 3:
11. Add caching layer
12. Add conversation search
13. Add analytics
14. Security hardening (CSRF, CSP)
15. Mobile responsiveness

### Month 2+:
- Testing (unit, E2E, load)
- Cost optimization
- Documentation
- Advanced features

---

**Last Updated:** October 27, 2025  
**Branch:** feature/cred-check  
**Status:** Performance fixes complete, ready for deployment

