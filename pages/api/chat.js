// pages/api/chat.js
import { sql } from "@vercel/postgres";
import openai from "../../lib/openaiClient.js";
import { routeQuery } from "../../lib/rag/router.js";
import { retrieveCandidates } from "../../lib/rag/retriever.js";
import { rerankCandidates } from "../../lib/rag/reranker.js";
import { isConfident } from "../../lib/rag/confidence.js";
import { synthesizeRAGAnswer } from "../../lib/rag/synthesizer.js";
import { getGeneralAnswer } from "../../lib/rag/fallback.js";

export const config = { runtime: "edge" };

// small helper: JSON responses
function okJSON(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}
function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } });
}

// Lightweight missing markers check
function synthesisHasMissingMarkers(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  const markers = [
    "not in sources", "not in the sources", "not present in the sources",
    "i could not find", "no supporting source", "no evidence in the sources",
    "not found in the sources", "no documentation found"
  ];
  return markers.some((m) => low.includes(m));
}

// Strip inline URLs and "Links:" block from fallback LLM text
function stripUrlsFromText(text = "") {
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((text.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  let cleaned = text.replace(urlRegex, "").replace(/(Links|URLs?)\s*:\s*\n?[\s\S]*$/i, "").trim();
  cleaned = cleaned.replace(/\n{2,}/g, "\n\n").trim();
  return { cleanedText: cleaned, urlsInText: urls };
}

// numeric and visa checks omitted here for brevity — you can re-add earlier checks if needed
function numericEvidenceCheck(answerText = "", docs = []) {
  if (!answerText) return false;
  const currencyMatches = Array.from(new Set([...answerText.matchAll(/\$\s?[\d,]+(?:\.\d+)?/g)].map(m => m[0].replace(/\s+/g, ""))));
  const plainNumberMatches = Array.from(new Set([...answerText.matchAll(/\b\d{4}\b|\b\d{3,}\b/g)].map(m => m[0])));
  const numericCandidates = [...currencyMatches, ...plainNumberMatches].map(s => s.replace(/[,]/g, "").toLowerCase());
  if (numericCandidates.length === 0) return true;
  const lowerDocs = docs.map(d => (d.content || "").replace(/[,]/g, "").toLowerCase());
  for (const token of numericCandidates) {
    for (const dtext of lowerDocs) {
      if (!dtext) continue;
      if (dtext.includes(token)) return true;
      const digitsOnly = token.replace(/\D/g, "");
      if (digitsOnly && dtext.includes(digitsOnly)) return true;
    }
  }
  return false;
}

/* ---- URL verification with per-URL timeout & parallelism ----
   - limit to maxUrls (so we don't attempt 20 HEADs)
   - per-url timeoutMs (2s)
   - returns array of { url, ok: true|false|null, status: number|null }
*/
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal, redirect: "follow" });
    clearTimeout(id);
    return resp;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function verifyUrls(urls = [], { maxUrls = 8, perUrlTimeout = 2000 } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  const take = urls.slice(0, maxUrls);
  // run in parallel with Promise.allSettled
  const promises = take.map(async (u) => {
    try {
      // try HEAD first
      try {
        const resp = await fetchWithTimeout(u, { method: "HEAD" }, perUrlTimeout);
        return { url: u, ok: resp.ok, status: resp.status };
      } catch (headErr) {
        // if HEAD fails quickly, try GET (within remaining timeout)
        try {
          const resp2 = await fetchWithTimeout(u, { method: "GET" }, perUrlTimeout);
          return { url: u, ok: resp2.ok, status: resp2.status };
        } catch (getErr) {
          return { url: u, ok: false, status: null };
        }
      }
    } catch (err) {
      // network error / timeout
      return { url: u, ok: false, status: null };
    }
  });

  const settled = await Promise.allSettled(promises);
  return settled.map((s) => (s.status === "fulfilled" ? s.value : { url: null, ok: false, status: null })).filter(Boolean);
}

// Short greeting detection (only short greetings)
function isShortGreeting(text = "") {
  if (!text) return false;
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 4) return false;
  return /^(hi|hello|hey|hey there|good (morning|afternoon|evening)|howdy)[\s!.,]*$/i.test(trimmed);
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Defensive per-request timeout guard (soft) — we can't force Vercel to extend runtime,
  // but we will avoid waiting on slow tasks. We'll attempt to finish quickly.
  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return badRequest("Invalid request body");

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return badRequest("Empty user query");

    // greeting path
    if (isShortGreeting(userQuery)) {
      try {
        const greetResp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a warm, succinct immigration info assistant. Greet briefly and ask how you can help." },
            { role: "user", content: userQuery },
          ],
          max_tokens: 120,
          temperature: 0.2,
        });
        const greet = greetResp?.choices?.[0]?.message?.content?.trim() || "Hello! How can I help?";
        return okJSON({ rag: { answer: greet, sources: [] }, fallback: null, path: "greet" });
      } catch (gerr) {
        // if OpenAI call failed quickly, return a safe greeting
        console.warn("greet error:", gerr?.message || gerr);
        return okJSON({ rag: { answer: "Hello! How can I help?", sources: [] }, fallback: null, path: "greet" });
      }
    }

    // 1) Router - make robust
    let conversationHistory = (messages || []).slice(0, -1);
    let refined_query = userQuery;
    let intent = "question";
    try {
      const route = await routeQuery(userQuery, conversationHistory);
      refined_query = route.refined_query || refined_query;
      intent = route.intent || intent;
      if (/\b(compare|difference|vs\.?|vs\b|versus)\b/i.test(userQuery.toLowerCase())) intent = "comparison";
    } catch (rerr) {
      console.warn("routeQuery error:", rerr?.message || rerr);
      // continue with raw query
    }

    // 2) Retrieval (embedding / pgvector with keyword fallback inside retrieveCandidates)
    let candidateRows = [];
    try {
      candidateRows = await retrieveCandidates(refined_query, { limit: 20 });
    } catch (re) {
      console.warn("retrieveCandidates error:", re?.message || re);
      candidateRows = [];
    }

    // If no candidates -> fallback-only; but keep it quick
    if (!candidateRows || candidateRows.length === 0) {
      let fallback;
      try {
        fallback = await getGeneralAnswer(userQuery, conversationHistory);
      } catch (ferr) {
        console.warn("fallback LLM error:", ferr?.message || ferr);
        fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      }
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;

      // Verify urls but don't wait forever — per-url timeout 2s and only up to 8 urls.
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try {
        linkInfo = await verifyUrls(rawUrls, { maxUrls: 8, perUrlTimeout: 2000 });
      } catch (verr) {
        console.warn("verifyUrls error:", verr?.message || verr);
        // Build best-effort linkInfo array with unknown statuses
        linkInfo = (rawUrls || []).slice(0, 8).map(u => ({ url: u, ok: null, status: null }));
      }
      return okJSON({ answer: cleanedWithDisclaimer, sources: [], fallback_links: linkInfo, path: "fallback" });
    }

    // 3) prepare candidates for reranking (trim content)
    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i + 1,
      content: (r.content || "").slice(0, 1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file,
    }));

    // 4) Rerank (LLM + domain boosts inside reranker)
    let reranked = [];
    try {
      reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length));
    } catch (rrerr) {
      console.warn("rerankCandidates error:", rrerr?.message || rrerr);
      // fallback: use lexical heuristic
      reranked = candidates.map((c, i) => ({ ...c, score: 0.5 - i * 0.05 })).slice(0, Math.min(6, candidates.length));
    }

    // 5) Confidence check
    const confident = isConfident(reranked);

    if (!confident) {
      // quick fallback path — return fallback-only but include attempted/partial sources in logs
      let fallback;
      try {
        fallback = await getGeneralAnswer(userQuery, conversationHistory);
      } catch (ferr) {
        fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      }
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try {
        linkInfo = await verifyUrls(rawUrls, { maxUrls: 8, perUrlTimeout: 2000 });
      } catch (verr) {
        linkInfo = (rawUrls || []).slice(0,8).map(u => ({ url: u, ok: null, status: null }));
      }

      // Return fallback quickly (no dual block) — front end will show sources panel for fallback_links
      return okJSON({ answer: cleanedWithDisclaimer, sources: [], fallback_links: linkInfo, path: "fallback", reason: "pre_synthesis_low_confidence" });
    }

    // 6) Synthesize using top reranked docs
    const topDocs = reranked.map((d) => ({
      id: d.id,
      content: d.content,
      source_title: d.source_title,
      source_url: d.source_url,
      score: d.score,
    }));

    let final;
    try {
      final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory);
    } catch (synthErr) {
      console.warn("synthesizeRAGAnswer error:", synthErr?.message || synthErr);
      // fallback to chatgpt
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try {
        linkInfo = await verifyUrls(rawUrls, { maxUrls: 8, perUrlTimeout: 2000 });
      } catch (verr) {
        linkInfo = (rawUrls || []).slice(0,8).map(u => ({ url: u, ok: null, status: null }));
      }
      return okJSON({ answer: cleanedWithDisclaimer, sources: [], fallback_links: linkInfo, path: "fallback", reason: "synth_error" });
    }

    // Post-synthesis checks (missing markers / numeric evidence)
    const synthText = (final.answer || "");
    const hasMissing = synthesisHasMissingMarkers(synthText);
    const numericEvidenceOk = numericEvidenceCheck(synthText, topDocs);

    if (hasMissing || !numericEvidenceOk) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try {
        linkInfo = await verifyUrls(rawUrls, { maxUrls: 8, perUrlTimeout: 2000 });
      } catch (verr) {
        linkInfo = (rawUrls || []).slice(0,8).map(u => ({ url: u, ok: null, status: null }));
      }
      return okJSON({ answer: cleanedWithDisclaimer, sources: [], fallback_links: linkInfo, path: "fallback", reason: hasMissing ? "synthesis_incomplete" : "numeric_mismatch" });
    }

    // Success: return RAG result (sources include URLs)
    return okJSON({
      rag: { answer: final.answer, sources: final.sources || topDocs.map((d, i) => ({ id: i + 1, title: d.source_title, url: d.source_url })) },
      fallback: null,
      path: "rag",
    });

  } catch (err) {
    console.error("chat api error:", err);
    // Return an API-friendly error message rather than letting the platform timeout silently
    return new Response(JSON.stringify({ error: err?.message || "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
