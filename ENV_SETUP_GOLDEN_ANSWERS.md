# 🔧 Environment Variables Setup for Golden Answers

## **Required: Add to `.env.local`**

Create or update `/Users/roydi/Desktop/stakeholder-demo-mac/stakeholder-demo/.env.local`:

```bash
# Golden Answers Feature Flag
USE_GOLD_KB=false

# Optional: Override default thresholds (uncomment to use)
# GOLD_THRESHOLD=0.75
# GOLD_THRESHOLD_LOW=0.60
# HUMAN_CONF_THRESH=0.50
```

---

## **For Vercel Deployment:**

Add environment variable in Vercel dashboard:

**Name:** `USE_GOLD_KB`  
**Value:** `false`  
**Environment:** Production, Preview, Development

---

## **To Enable Golden Answers:**

### **Locally:**
```bash
# In .env.local
USE_GOLD_KB=true
```

### **Vercel:**
1. Go to Project Settings → Environment Variables
2. Change `USE_GOLD_KB` to `true`
3. Redeploy

---

## **⚠️ IMPORTANT:**

- **Keep `USE_GOLD_KB=false` until thoroughly tested locally**
- **Test with flag OFF first** (verify nothing broke)
- **Test with flag ON** (verify golden answers work)
- **Only enable in production after monitoring is set up**

