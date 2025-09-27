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

function okJSON(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}
function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } });
}

// Detect phrases the synthesizer uses to indicate missing coverage
function synthesisHasMissingMarkers(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  const markers = [
    "not in sources",
    "not in the sources",
    "not present in the sources",
    "i could not find",
    "no supporting source",
    "no evidence in the sources",
    "not found in the sources",
    "no documentation found"
  ];
  return markers.some((m) => low.includes(m));
}

// Verify URLs (HEAD) — with GET fallback
async function verifyUrls(urls = []) {
  const results = [];
  for (const u of urls) {
    try {
      const resp = await fetch(u, { method: "HEAD", redirect: "follow" });
      results.push({ url: u, ok: resp.ok, status: resp.status });
    } catch (e) {
      try {
        const resp2 = await fetch(u, { method: "GET", redirect: "follow" });
        results.push({ url: u, ok: resp2.ok, status: resp2.status });
      } catch (e2) {
        results.push({ url: u, ok: false, status: null });
      }
    }
  }
  return results;
}

/**
 * numericEvidenceCheck(answerText, docs)
 * Look for numeric/currency tokens in the answer and ensure at least one token appears in the retrieved docs.
 * If numeric claims present but not found in docs => return false (no evidence).
 * Otherwise return true.
 */
function numericEvidenceCheck(answerText = "", docs = []) {
  if (!answerText) return false;
  const currencyMatches = Array.from(new Set([...answerText.matchAll(/\$\s?[\d,]+(?:\.\d+)?/g)].map(m => m[0].replace(/\s+/g, ""))));
  const plainNumberMatches = Array.from(new Set([...answerText.matchAll(/\b\d{4}\b|\b\d{3,}\b/g)].map(m => m[0])));

  const numericCandidates = [...currencyMatches, ...plainNumberMatches].map(s => s.replace(/[,]/g, "").toLowerCase());
  if (numericCandidates.length === 0) return true; // no numeric claims => OK

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

/**
 * Remove URLs and a trailing "URLs:" block from a text. Returns { cleanedText, urlsInText }.
 * We use this to keep fallback answer body clean and move links into fallback_links.
 */
function stripUrlsFromText(text = "") {
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((text.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  // remove URLs and any leading "URLs:" section lines
  let cleaned = text.replace(urlRegex, "").replace(/URLs?:\s*\n?([\s\S]*)$/i, "").trim();
  // remove multiple blank lines
  cleaned = cleaned.replace(/\n{2,}/g, "\n\n").trim();
  return { cleanedText: cleaned, urlsInText: urls };
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return badRequest("Invalid request body");

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return badRequest("Empty user query");

    // quick greeting path — return as a 'greet' path so frontend won't label it fallback
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(userQuery)) {
      const greetResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a warm, succinct immigration info assistant. Greet briefly and ask how you can help." },
          { role: "user", content: userQuery },
        ],
        max_tokens: 80,
        temperature: 0.2,
      });
      const greet = greetResp?.choices?.[0]?.message?.content?.trim() || "Hello! How can I help?";
      // return in rag-shaped object with a 'greet' path so UI doesn't show fallback disclaimer
      return okJSON({
        rag: { answer: greet, sources: [] },
        fallback: null,
        path: "greet",
      });
    }

    // 1) Router
    const conversationHistory = (messages || []).slice(0, -1);
    const { refined_query: raw_refined_query, intent: raw_intent, format } = await routeQuery(userQuery, conversationHistory);

    // Small intent override: if user explicitly asks "compare" / "difference" / "vs" prefer comparison table
    const lowerQ = userQuery.toLowerCase();
    let refined_query = raw_refined_query || userQuery;
    let intent = raw_intent || "question";
    if (/\b(compare|difference|vs\.?|vs\b|versus)\b/i.test(lowerQ)) {
      intent = "comparison";
    }

    // 2) Retrieval (pgvector) — caller of retrieveCandidates handles pgvector failure
    const candidateRows = await retrieveCandidates(refined_query, { limit: 20 });

    // If no candidates, fallback: return fallback-only (not dual)
    if (!candidateRows || candidateRows.length === 0) {
      const fallback = await getGeneralAnswer(userQuery);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      // return fallback-only (legacy-like shape will still be supported by frontend)
      return okJSON({
        answer: cleanedText,
        sources: [],
        fallback_links: linkInfo,
        path: "fallback",
      });
    }

    // 3) Prepare candidates for reranking
    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i + 1,
      content: (r.content || "").slice(0, 1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file,
    }));

    // 4) Rerank
    const reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length));

    // 5) Confidence check (pre-synthesis) — apply a slightly more lenient rule in addition to isConfident
    const confidentBefore = isConfident(reranked);
    // lenient allowance: accept if top score >= 0.75 and meanTop3 >= 0.45
    const topScore = (reranked[0]?.score) || 0;
    const meanTop3 = (reranked.slice(0,3).reduce((s,d)=>s+(d.score||0),0)) / Math.min(3, reranked.length || 1);
    const lenientAccept = topScore >= 0.75 && meanTop3 >= 0.45;
    const confident = confidentBefore || lenientAccept;

    if (!confident) {
      const fallback = await getGeneralAnswer(userQuery);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      return okJSON({
        answer: cleanedText,
        sources: [],
        fallback_links: linkInfo,
        path: "fallback",
        reason: "pre_synthesis_low_confidence"
      });
    }

    // 6) Synthesize using top reranked docs
    const topDocs = reranked.map((d) => ({
      id: d.id,
      content: d.content,
      source_title: d.source_title,
      source_url: d.source_url,
      source_file: d.source_file,
      score: d.score,
    }));
    const final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory);

    // 7) Post-synthesis checks
    const synthText = (final.answer || "");
    const hasMissing = synthesisHasMissingMarkers(synthText);
    const numericEvidenceOk = numericEvidenceCheck(synthText, topDocs);

    if (hasMissing || !numericEvidenceOk) {
      // fallback-only (don't show dual); remove URLs from fallback answer body
      const fallback = await getGeneralAnswer(userQuery);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      return okJSON({
        answer: cleanedText,
        sources: [],
        fallback_links: linkInfo,
        path: "fallback",
        reason: hasMissing ? "synthesis_incomplete" : "numeric_mismatch"
      });
    }

    // 8) All good — return RAG-only in rag-shaped object
    return okJSON({
      rag: { answer: final.answer, sources: final.sources || topDocs.map((d,i)=>({ id: i+1, title: d.source_title, url: d.source_url })) },
      fallback: null,
      path: "rag",
    });

  } catch (err) {
    console.error("chat api error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal Server Error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
