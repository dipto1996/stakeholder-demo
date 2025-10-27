// pages/api/cred_check.js
import fetch from "node-fetch";
import cheerio from "cheerio";
import stringSimilarity from "string-similarity";
import { OpenAI } from "openai";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.warn("OPENAI_API_KEY not set");
}
const client = new OpenAI({ apiKey: OPENAI_KEY });

// Config thresholds (tune)
const COSINE_VERIFIED = 0.78;
const COSINE_UNCERTAIN = 0.62;
const FUZZY_RATIO_THRESHOLD = 0.7; // 70% fuzzy match
const ALLOWED_PRIMARY_DOMAINS = [
  "uscis.gov","dhs.gov","justice.gov","eoir.justice.gov","ecfr.gov",
  "federalregister.gov","dol.gov","state.gov","uscourts.gov","courtlistener.com",
  "congress.gov","law.cornell.edu","cbp.gov","ice.gov","ssa.gov"
];
const DOMAIN_WEIGHTS = {
  "uscis.gov": 1.0, "dhs.gov": 0.98, "justice.gov": 0.98, "eoir.justice.gov": 0.98,
  "ecfr.gov": 0.95, "federalregister.gov": 0.95, "dol.gov": 0.95, "state.gov": 0.95,
  "uscourts.gov": 0.95, "courtlistener.com": 0.95, "congress.gov": 0.94, "law.cornell.edu": 0.92
};

// helper: get hostname
function getDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return "";
  }
}

// fetch page and extract text (simple)
async function fetchPageText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "CredCheckBot/1.0" }, timeout: 8000 });
    if (!res.ok) return { ok: false, status: res.status, text: "", lastModified: res.headers.get("last-modified") || "" };
    const html = await res.text();
    const $ = cheerio.load(html);
    // remove script/style
    $("script, style, noscript").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    return { ok: true, status: 200, text, lastModified: res.headers.get("last-modified") || "" };
  } catch (e) {
    return { ok: false, status: 0, text: "", lastModified: "" };
  }
}

// compute embeddings via OpenAI
async function getEmbedding(text) {
  // limit length if needed
  const resp = await client.embeddings.create({ model: "text-embedding-3-large", input: text });
  return resp.data[0].embedding;
}

// cosine similarity utility
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

// small NLI fallback using Chat (conservative)
async function openaiNLI(claim, passage) {
  try {
    const prompt = `You are an evidence verifier.
Claim: "${claim}"
Passage: "${passage}"
Answer JSON: {"verdict":"SUPPORT|CONTRADICT|INCONCLUSIVE","confidence":0.0-1.0,"reason":"short"}.
Be conservative and base answer only on the passage.`;
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }],
      max_tokens: 120, temperature: 0.0
    });
    const text = resp.choices[0].message.content;
    const m = text.match(/\{[^}]+\}/s);
    if (!m) return { verdict: "INCONCLUSIVE", confidence: 0.3, reason: "no parse" };
    const obj = JSON.parse(m[0]);
    return { verdict: obj.verdict, confidence: obj.confidence, reason: obj.reason || "" };
  } catch (e) {
    return { verdict: "INCONCLUSIVE", confidence: 0.25, reason: "error" };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const gptJson = req.body;
  if (!gptJson || !Array.isArray(gptJson.claims)) {
    return res.status(400).json({ error: "Invalid GPT payload (missing claims[])" });
  }

  // We'll compute small embedding for each claim once
  const claimTexts = gptJson.claims.map(c => c.text || c);
  const claimEmbeddings = await Promise.all(claimTexts.map(t => getEmbedding(t)));

  // For each claim, evaluate cited URLs
  const results = [];
  for (let i = 0; i < gptJson.claims.length; i++) {
    const claim = gptJson.claims[i];
    const cited = (gptJson.citations || []).filter(c => c.claim_id === claim.id);
    const urls = (cited.length && (cited[0].urls || cited[0].url || cited[0].urls_list)) ? (cited[0].urls || cited[0].url || cited[0].urls_list) : [];
    const evidence = [];
    let bestScore = 0;
    for (const uobj of urls) {
      let url, quoted;
      if (typeof uobj === "string") { url = uobj; quoted = null; }
      else { url = uobj.url || uobj.link; quoted = uobj.quoted_snippet || uobj.snippet || null; }
      if (!url) continue;
      const domain = getDomain(url);
      const domainWeight = DOMAIN_WEIGHTS[domain] ?? (ALLOWED_PRIMARY_DOMAINS.includes(domain) ? 0.9 : 0.6);
      // quickly check domain whitelist: if not in primary list, lower weight
      const page = await fetchPageText(url);
      let snippetMatch = 0;
      let exact = false;
      if (quoted && page.text) {
        const a = quoted.replace(/\s+/g,' ').toLowerCase();
        const p = page.text.replace(/\s+/g,' ').toLowerCase();
        if (p.includes(a)) { snippetMatch = 1.0; exact = true; }
        else {
          const fuzzy = stringSimilarity.compareTwoStrings(a, p);
          snippetMatch = fuzzy; // 0..1
        }
      } else if (page.text) {
        // attempt to check claim text vs page text via fuzzy
        const fuzzy = stringSimilarity.compareTwoStrings(claim.text.toLowerCase(), page.text.toLowerCase());
        snippetMatch = fuzzy;
      } else {
        snippetMatch = 0;
      }
      // semantic similarity via embeddings (costly: use small window)
      let semantic = 0;
      try {
        // take page text head (first 2000 chars) to embed cheaply
        const pageWindow = (page.text || "").slice(0, 2000);
        if (pageWindow.length > 20) {
          const pageEmb = await getEmbedding(pageWindow);
          semantic = cosineSim(claimEmbeddings[i], pageEmb);
        }
      } catch (e) { semantic = 0; }

      // NLI fallback for mid-range
      let nliVerdict = null, nliConf = 0;
      if (!exact && semantic >= COSINE_UNCERTAIN && semantic < COSINE_VERIFIED) {
        const passage = (page.text || "").slice(0, 1200);
        const nli = await openaiNLI(claim.text, passage);
        nliVerdict = nli.verdict; nliConf = nli.confidence;
      } else if (exact || semantic >= COSINE_VERIFIED) {
        nliVerdict = "SUPPORT"; nliConf = Math.max(semantic, snippetMatch);
      } else {
        nliVerdict = "INCONCLUSIVE"; nliConf = Math.max(semantic, snippetMatch * 0.6);
      }

      // freshness multiplier (simple)
      let freshness = 1.0;
      try {
        if (page.lastModified) {
          const y = (new Date(page.lastModified)).getFullYear();
          if (!isNaN(y) && y < (new Date()).getFullYear() - 5) freshness = 0.85;
        }
      } catch (e) {}

      const finalScore = Math.max(0, Math.min(1, 0.35 * snippetMatch + 0.40 * nliConf + 0.20 * domainWeight + 0.05 * freshness));
      evidence.push({ url, domain, snippetMatch, semantic, nliVerdict, nliConf, domainWeight, freshness, finalScore, lastModified: page.lastModified || "" });
      if (finalScore > bestScore) bestScore = finalScore;
    } // end urls

    // per-claim decision
    let decision = "reject";
    if (bestScore >= 0.85) decision = "verified";
    else if (bestScore >= 0.60) decision = "probable";
    results.push({ claim_id: claim.id, text: claim.text, bestScore, decision, evidence });
  } // end claims

  // aggregate
  const overall = results.length ? (results.reduce((s,r)=>s+r.bestScore,0)/results.length) : 0;
  let overallDecision = "reject";
  if (overall >= 0.85) overallDecision = "verified";
  else if (overall >= 0.60) overallDecision = "probable";

  return res.status(200).json({ ok: true, overall, overallDecision, results });
}
