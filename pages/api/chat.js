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

const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_EXCERPT = 1600;
const MAX_CONTEXT_TOTAL = 6000;
const RETRIEVE_LIMIT = 20;
const FINAL_TOP_K = 6;

function okJSON(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}
function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } });
}

// buildContextRows similar to earlier
function buildContextRows(rows) {
  const sources = rows.map((r, i) => ({
    id: i + 1,
    title: r.source_title || r.source_file || "Untitled",
    url: r.source_url || null,
  }));

  let used = 0;
  const blocks = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = (rows[i].content || "").slice(0, MAX_EXCERPT);
    if (used + raw.length > MAX_CONTEXT_TOTAL) break;
    blocks.push(`[${i + 1}] source: ${rows[i].source_title || rows[i].source_file || 'Untitled'}\ncontent: ${raw}`);
    used += raw.length;
  }
  return { sources, contextText: blocks.join("\n\n---\n\n") };
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return badRequest("Invalid request body");

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return badRequest("Empty user query");

    // quick greeting path to keep responses fast for salutations
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

    // 2) Retriever (attempt pgvector via retrieveCandidates)
    const candidateRows = await retrieveCandidates(refined_query, { limit: RETRIEVE_LIMIT });

    // If no candidates (pgvector not present or empty), fallback to general answer
    if (!candidateRows || candidateRows.length === 0) {
      const fallback = await getGeneralAnswer(userQuery);
      return okJSON({ answer: fallback.answer, sources: [] });
    }

    // 3) Build candidate objects for reranker
    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i + 1,
      content: (r.content || "").slice(0, MAX_EXCERPT),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file,
    }));

    // 4) Rerank
    const reranked = await rerankCandidates(refined_query, candidates, Math.min(FINAL_TOP_K, candidates.length));

    // 5) Confidence check
    const confident = isConfident(reranked);

    // 6) Choose path
    if (confident) {
      const topDocs = reranked.map((d) => ({
        id: d.id,
        content: d.content,
        source_title: d.source_title,
        source_url: d.source_url,
        source_file: d.source_file,
        score: d.score,
      }));
      const final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory);
      // match legacy output shape: { answer, sources }
      return okJSON({
        answer: final.answer,
        sources: final.sources.map((s) => ({ id: s.id, title: s.title, url: s.url })),
      });
    } else {
      const fallback = await getGeneralAnswer(userQuery);
      return okJSON({ answer: fallback.answer, sources: [] });
    }
  } catch (err) {
    console.error("chat api error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
