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

// Lightweight synthesis missing markers
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

// Verify URLs (HEAD), with fallback to GET
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
 * - Extracts numeric tokens / currency from answerText (e.g., "$100,000", "100000", "2025")
 * - Checks whether any of the docs' excerpts contain those same numeric tokens.
 * - If answer contains numeric/currency claims but none are found in docs => returns false (no evidence).
 * - Otherwise returns true (evidence exists or no numeric claims present).
 *
 * This helps catch cases where the model invents a fee or date but the retrieved sources don't contain it.
 */
function numericEvidenceCheck(answerText = "", docs = []) {
  if (!answerText) return false; // no answer => treat as missing
  // find dollar amounts and plain numbers (years or large numbers)
  const currencyMatches = Array.from(new Set([...answerText.matchAll(/\$\s?[\d,]+(?:\.\d+)?/g)].map(m => m[0].replace(/\s+/g, ""))));
  const plainNumberMatches = Array.from(new Set([...answerText.matchAll(/\b\d{4}\b|\b\d{3,}\b/g)].map(m => m[0])));

  const numericCandidates = [...currencyMatches, ...plainNumberMatches].map(s => s.replace(/[,]/g, "").toLowerCase());
  if (numericCandidates.length === 0) return true; // no numeric claims => OK

  // Normalize docs text and check for presence of numeric tokens
  const lowerDocs = docs.map(d => (d.content || "").replace(/[,]/g, "").toLowerCase());
  for (const token of numericCandidates) {
    for (const dtext of lowerDocs) {
      if (!dtext) continue;
      if (dtext.includes(token)) return true; // evidence found
      // sometimes $ is absent in source but number present with whitespace/punctuation; check digits-only
      const digitsOnly = token.replace(/\D/g, "");
      if (digitsOnly && dtext.includes(digitsOnly)) return true;
    }
  }
  // none of the numeric tokens are present in any doc excerpt
  return false;
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return badRequest("Invalid request body");

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return badRequest("Empty user query");

    // quick greeting path
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
      return okJSON({ answer: greet, sources: [] });
    }

    // 1) Router
    const conversationHistory = (messages || []).slice(0, -1);
    const { refined_query, intent, format } = await routeQuery(userQuery, conversationHistory);

    // 2) Retrieval
    const candidateRows = await retrieveCandidates(refined_query, { limit: 20 });

    // If no candidates, fallback and return dual (RAG empty + fallback)
    if (!candidateRows || candidateRows.length === 0) {
      const fallback = await getGeneralAnswer(userQuery);
      const linkInfo = await verifyUrls(fallback.raw_urls || []);
      return okJSON({
        rag: { answer: null, sources: [] },
        fallback: { answer: fallback.answer, links: linkInfo },
        path: "dual",
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

    // 5) Confidence check (pre-synthesis)
    const confident = isConfident(reranked);

    // If not confident -> fallback (dual view), include attempted RAG sources
    if (!confident) {
      const fallback = await getGeneralAnswer(userQuery);
      const linkInfo = await verifyUrls(fallback.raw_urls || []);
      return okJSON({
        rag: {
          answer: null,
          sources: reranked.map((d, idx) => ({ id: idx + 1, title: d.source_title, url: d.source_url, excerpt: d.content })),
        },
        fallback: { answer: fallback.answer, links: linkInfo },
        path: "dual",
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
      // fallback to ChatGPT and return both RAG and fallback (dual)
      const fallback = await getGeneralAnswer(userQuery);
      const linkInfo = await verifyUrls(fallback.raw_urls || []);
      return okJSON({
        rag: { answer: final.answer, sources: final.sources || topDocs.map((d,i)=>({ id: i+1, title: d.source_title, url: d.source_url })) },
        fallback: { answer: fallback.answer, links: linkInfo },
        path: "dual",
        reason: hasMissing ? "synthesis_incomplete" : "numeric_mismatch"
      });
    }

    // 8) All good — return RAG-only
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
