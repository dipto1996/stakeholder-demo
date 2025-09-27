// pages/api/chat.js (updated orchestrator)
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

async function verifyUrls(urls = []) {
  const results = [];
  for (const u of urls) {
    try {
      const resp = await fetch(u, { method: "HEAD", redirect: "follow" });
      results.push({ url: u, ok: resp.ok, status: resp.status });
    } catch {
      try {
        const resp2 = await fetch(u, { method: "GET", redirect: "follow" });
        results.push({ url: u, ok: resp2.ok, status: resp2.status });
      } catch {
        results.push({ url: u, ok: false, status: null });
      }
    }
  }
  return results;
}

function stripUrlsFromText(text = "") {
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((text.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  let cleaned = text.replace(urlRegex, "").replace(/(Links|URLs?)\s*:\s*\n?[\s\S]*$/i, "").trim();
  cleaned = cleaned.replace(/\n{2,}/g, "\n\n").trim();
  return { cleanedText: cleaned, urlsInText: urls };
}

// numeric evidence check (unchanged)
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

/**
 * visaTermEvidenceCheck(answerText, docs)
 * If answer asserts that specific visa classes (e.g., L1, J1) are affected,
 * ensure those visa labels appear in the docs. If not present, return false.
 */
function visaTermEvidenceCheck(answerText = "", docs = []) {
  if (!answerText) return true;
  const visaTerms = ["h-1b","h1b","h-1b visa","l1","l-1","l-1 visa","j1","j-1","j-1 visa","o-1","o1"];
  const lowAns = answerText.toLowerCase();
  const mentioned = visaTerms.filter(t => lowAns.includes(t));
  if (mentioned.length === 0) return true; // no visa class assertions => ok
  const lowerDocs = docs.map(d => (d.content || "").toLowerCase());
  for (const term of mentioned) {
    let found = false;
    for (const dtext of lowerDocs) {
      if (!dtext) continue;
      if (dtext.includes(term)) { found = true; break; }
    }
    if (!found) return false; // claimed visa term not present in docs
  }
  return true;
}

// short greeting detector (strict)
function isShortGreeting(text = "") {
  if (!text) return false;
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
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

    // greeting path - strict
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
      return okJSON({ rag: { answer: greet, sources: [] }, fallback: null, path: "greet" });
    }

    // Router / intent
    const conversationHistory = (messages || []).slice(0, -1);
    const { refined_query: raw_refined_query, intent: raw_intent } = await routeQuery(userQuery, conversationHistory);

    let refined_query = raw_refined_query || userQuery;
    let intent = raw_intent || "question";
    const lowerQ = userQuery.toLowerCase();
    if (/\b(compare|difference|vs\.?|vs\b|versus)\b/i.test(lowerQ)) intent = "comparison";

    // Retrieval
    const candidateRows = await retrieveCandidates(refined_query, { limit: 20 });
    if (!candidateRows || candidateRows.length === 0) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      return okJSON({ answer: cleanedWithDisclaimer, sources: [], fallback_links: linkInfo, path: "fallback" });
    }

    // prepare candidates
    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i + 1,
      content: (r.content || "").slice(0, 1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file,
    }));

    // rerank (domain-aware inside reranker)
    const reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length));

    // confidence check (conservative + small leniency)
    const confidentBefore = isConfident(reranked);
    const topScore = (reranked[0]?.score) || 0;
    const meanTop3 = (reranked.slice(0,3).reduce((s,d)=>s+(d.score||0),0)) / Math.min(3, reranked.length || 1);
    const lenientAccept = topScore >= 0.75 && meanTop3 >= 0.45;
    const confident = confidentBefore || lenientAccept;

    if (!confident) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      return okJSON({ answer: cleanedWithDisclaimer, sources: [], fallback_links: linkInfo, path: "fallback", reason: "pre_synthesis_low_confidence" });
    }

    // synthesize from top docs
    const topDocs = reranked.map((d) => ({
      id: d.id,
      content: d.content,
      source_title: d.source_title,
      source_url: d.source_url,
      score: d.score,
    }));
    const final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory);

    // post-checks: missing markers, numeric evidence, visa-term evidence
    const synthText = final.answer || "";
    const hasMissing = synthesisHasMissingMarkers(synthText);
    const numericOk = numericEvidenceCheck(synthText, topDocs);
    const visaTermsOk = visaTermEvidenceCheck(synthText, topDocs);

    if (hasMissing || !numericOk || !visaTermsOk) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleanedWithDisclaimer = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      const linkInfo = await verifyUrls(fallback.raw_urls?.length ? fallback.raw_urls : urlsInText);
      const reason = hasMissing ? "synthesis_incomplete" : (!numericOk ? "numeric_mismatch" : "visa_term_mismatch");
      return okJSON({ answer: cleanedWithDisclaimer, sources: [], fallback_links: linkInfo, path: "fallback", reason });
    }

    // success - return rag object
    return okJSON({
      rag: { answer: final.answer, sources: final.sources || topDocs.map((d,i) => ({ id: i+1, title: d.source_title, url: d.source_url })) },
      fallback: null,
      path: "rag",
    });

  } catch (err) {
    console.error("chat api error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal Server Error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
