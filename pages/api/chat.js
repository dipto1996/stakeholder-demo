// pages/api/chat.js
import { sql } from "@vercel/postgres";
import openai from "../../lib/openaiClient.js";
import { routeQuery } from "../../lib/rag/router.js";
import { createQueryEmbedding, retrieveCandidates } from "../../lib/rag/retriever.js";
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

// Lightweight markdown check: see if synthesizer flagged missing sources
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

// Verify URLs (HEAD) — returns [{ url, ok: true|false, status }]
async function verifyUrls(urls = []) {
  const results = [];
  for (const u of urls) {
    try {
      const resp = await fetch(u, { method: "HEAD", redirect: "follow" });
      results.push({ url: u, ok: resp.ok, status: resp.status });
    } catch (e) {
      // try GET for some servers that don't accept HEAD
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

    // 2) Retrieval (pgvector path)
    const candidateRows = await retrieveCandidates(refined_query, { limit: 20 });

    // If no candidates, do fallback and return dual: rag empty, fallback content
    if (!candidateRows || candidateRows.length === 0) {
      const fallback = await getGeneralAnswer(userQuery);
      // verify fallback links (non-blocking if empty)
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

    // If not confident, produce fallback but return dual view: RAG attempted top N + fallback
    if (!confident) {
      const fallback = await getGeneralAnswer(userQuery);
      const linkInfo = await verifyUrls(fallback.raw_urls || []);
      // Provide the partial RAG candidates (best-effort) too, so UI can show what we attempted
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

    // 7) Post-synthesis coverage check:
    const synthText = (final.answer || "");
    const hasMissing = synthesisHasMissingMarkers(synthText);

    if (hasMissing) {
      // fallback to ChatGPT and return both RAG (synth output) and fallback
      const fallback = await getGeneralAnswer(userQuery);
      const linkInfo = await verifyUrls(fallback.raw_urls || []);
      return okJSON({
        rag: { answer: final.answer, sources: final.sources || topDocs.map((d,i)=>({ id: i+1, title: d.source_title, url: d.source_url })) },
        fallback: { answer: fallback.answer, links: linkInfo },
        path: "dual",
        reason: "synthesis_incomplete"
      });
    }

    // 8) All good — return RAG-only (still included under rag key for consistency)
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
