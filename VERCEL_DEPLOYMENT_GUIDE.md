# Vercel Deployment Guide - Quick Fix for Timeout Issue

## 🚨 Immediate Action Required

Your chat is timing out because the API takes too long. Follow these steps to fix it:

---

## Step 1: Add Environment Variable in Vercel

1. **Go to Vercel Dashboard:**
   - Visit [vercel.com](https://vercel.com)
   - Click on your project: `stakeholder-demo`

2. **Navigate to Settings:**
   - Click "Settings" tab
   - Click "Environment Variables" in left sidebar

3. **Add the critical variable:**
   ```
   Name:  SKIP_URL_VERIFY
   Value: 1
   ```
   - Select all environments (Production, Preview, Development)
   - Click "Save"

---

## Step 2: Redeploy Your Application

### Option A: Trigger Redeploy from Vercel Dashboard
1. Go to "Deployments" tab
2. Click "..." menu on the latest deployment
3. Click "Redeploy"

### Option B: Push Changes to GitHub
```bash
# Make sure you're on the right branch
git status

# Commit and push these performance fixes
git add .
git commit -m "fix: optimize API performance to prevent timeout"
git push origin feature/cred-check
```

---

## Step 3: Test the Fix

1. **Wait for deployment to complete** (1-2 minutes)

2. **Open your app:**
   ```
   https://stakeholder-demo-ra0z4tl4t-jambi007s-projects.vercel.app/
   ```

3. **Ask a test question:**
   - Example: "What is H-1B visa?"
   - Should respond in **5-10 seconds** (instead of timing out)

---

## ⚡ What We Fixed

| Issue | Solution | Time Saved |
|-------|----------|------------|
| GPT-4o too slow | Changed to GPT-4o-mini | 3-5 seconds |
| URL verification slow | Made optional (now skipped) | 6-12 seconds |
| Router for short queries | Skip router for simple questions | 1-2 seconds |
| **Total improvement** | **Multiple optimizations** | **10-19 seconds** |

---

## 🔍 Troubleshooting

### If it still times out:

**Check 1: Verify environment variable is set**
```bash
# In Vercel Dashboard → Settings → Environment Variables
# Should see: SKIP_URL_VERIFY = 1
```

**Check 2: Check Vercel Function Logs**
1. Go to Deployments tab
2. Click on latest deployment
3. Click "Functions" tab
4. Find `/api/chat` function
5. Check execution time (should be <10s)

**Check 3: Verify OpenAI API Key**
```bash
# In Vercel Dashboard → Settings → Environment Variables
# Should have: OPENAI_API_KEY = sk-...
```

**Check 4: Check Database Connection**
```bash
# In Vercel Dashboard → Settings → Environment Variables
# Should have: POSTGRES_URL = postgresql://...
```

### If you see database errors:

The timeout might be because the database is not accessible. Check:
1. Vercel Postgres is properly configured
2. `pgvector` extension is installed:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

### If you see OpenAI errors:

Check that your OpenAI API key:
1. Is valid (not expired)
2. Has sufficient credits
3. Is correctly set in Vercel environment variables

---

## 📊 Expected Response Times

After fixes:

| Query Type | Expected Time | Status |
|------------|---------------|--------|
| Simple greeting | 0.5-1s | ⚡ Very fast |
| Short question (≤5 words) | 2-5s | ⚡ Fast |
| Complex question | 5-10s | ✅ Good |
| With fallback | 8-15s | ⚠️ Acceptable |

If still timing out after 15s, contact support.

---

## 🚀 Optional: Upgrade to Vercel Pro

If you need even more time:

**Hobby Plan:** 10-second timeout  
**Pro Plan:** 60-second timeout

Upgrade at: [vercel.com/account/billing](https://vercel.com/account/billing)

---

## 📝 Additional Environment Variables Needed

Make sure ALL these are set in Vercel:

### Required for Basic Functionality:
```bash
POSTGRES_URL=postgresql://...
OPENAI_API_KEY=sk-...
NEXTAUTH_URL=https://your-domain.vercel.app
NEXTAUTH_SECRET=generate-random-secret-here
```

### Required for Authentication:
```bash
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

### Required for Email Verification:
```bash
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@yourdomain.com
```

### Required for Vault Feature:
```bash
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=your-bucket-name
```

### Performance Optimization (CRITICAL - Add this):
```bash
SKIP_URL_VERIFY=1
```

---

## 🔄 How to Generate NEXTAUTH_SECRET

If you don't have this set:

```bash
# On Mac/Linux:
openssl rand -base64 32

# Or visit: https://generate-secret.vercel.app/32
```

Copy the output and add as `NEXTAUTH_SECRET` in Vercel.

---

## ✅ Success Checklist

- [ ] Added `SKIP_URL_VERIFY=1` to Vercel environment variables
- [ ] Redeployed the application
- [ ] Tested with a simple question
- [ ] Response came back in <10 seconds
- [ ] No 504 timeout errors in browser console

---

## 📞 Still Having Issues?

1. **Check Vercel Function Logs:**
   - Deployments → Latest → Functions → api/chat
   - Look for specific error messages

2. **Check Browser Console:**
   - Press F12
   - Go to Network tab
   - Look for failed requests and error messages

3. **Common error messages and fixes:**
   - `FUNCTION_INVOCATION_TIMEOUT` → Environment variable not set correctly
   - `OPENAI_API_ERROR` → Check API key and credits
   - `DATABASE_CONNECTION_ERROR` → Check POSTGRES_URL
   - `AUTHENTICATION_ERROR` → Check NEXTAUTH_SECRET

---

**Last Updated:** October 27, 2025  
**Status:** Ready for deployment  
**Estimated Fix Time:** 5 minutes

