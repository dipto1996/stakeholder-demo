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
 * Remove URLs and a trailing "URLs:" block from a text. Returns { cleanedText, urlsInText }.
 */
function stripUrlsFromText(text = "") {
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((text.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  let cleaned = text.replace(urlRegex, "").replace(/URLs?:\s*\n?([\s\S]*)$/i, "").trim();
  cleaned = cleaned.replace(/\n{2,}/g, "\n\n").trim();
  return { cleanedText: cleaned, urlsInText: urls };
}

/**
 * numericEvidenceCheck(answerText, docs)
 * Same as before — keeps protection vs fabricated numeric claims.
 */
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

// Determine if a message is a short standalone greeting (e.g. "hi", "hello", "hey there")
function isShortGreeting(text = "") {
  if (!text) return false;
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  // only treat as greeting when short (<= 4 words) and matches greeting pattern
  if (wordCount > 4) return false;
  return /^(hi|hello|hey|hey there|good (morning|afternoon|evening)|howdy)[\s!.,]*$/i.test(trimmed);
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return badRequest("Invalid request body");

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return badRequest("Empty user query");

    // 1) Greeting path: only trigger for short, standalone greetings
    if (isShortGreeting(userQuery)) {
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
      return okJSON({
        rag: { answer: greet, sources: [] },
        fallback: null,
        path: "greet",
      });
    }

    // 2) Router
    const conversationHistory = (messages || []).slice(0, -1);
    const { refined_query: raw_refined_query, intent: raw_intent, format } = await routeQuery(userQuery, conversationHistory);

    let refined_query = raw_refined_query || userQuery;
    let intent = raw_intent || "question";
    const lowerQ = userQuery.toLowerCase();
    if (/\b(compare|difference|vs\.?|vs\b|versus)\b/i.test(lowerQ)) {
      intent = "comparison";
    }

    // 3) Retrieval
    const candidateRows = await retrieveCandidates(refined_query, { limit: 20 });

    // If no candidates -> fallback-only
    if (!candidateRows || candidateRows.length === 0) {
      const fallback = await getGeneralAnswer(userQuery);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      // ensure disclaimer present at top of fallback cleanedText
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      return okJSON({
        answer: cleanedWithDisclaimer,
        sources: [],
        fallback_links: linkInfo,
        path: "fallback",
      });
    }

    // 4) prepare candidates and rerank
    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i + 1,
      content: (r.content || "").slice(0, 1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file,
    }));

    const reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length));

    // 5) Confidence check (allow slight leniency)
    const confidentBefore = isConfident(reranked);
    const topScore = (reranked[0]?.score) || 0;
    const meanTop3 = (reranked.slice(0,3).reduce((s,d)=>s+(d.score||0),0)) / Math.min(3, reranked.length || 1);
    const lenientAccept = topScore >= 0.75 && meanTop3 >= 0.45;
    const confident = confidentBefore || lenientAccept;

    if (!confident) {
      const fallback = await getGeneralAnswer(userQuery);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      return okJSON({
        answer: cleanedWithDisclaimer,
        sources: [],
        fallback_links: linkInfo,
        path: "fallback",
        reason: "pre_synthesis_low_confidence"
      });
    }

    // 6) Synthesize from top reranked docs
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
      const fallback = await getGeneralAnswer(userQuery);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      return okJSON({
        answer: cleanedWithDisclaimer,
        sources: [],
        fallback_links: linkInfo,
        path: "fallback",
        reason: hasMissing ? "synthesis_incomplete" : "numeric_mismatch"
      });
    }

    // 8) Good RAG answer — return rag object
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
