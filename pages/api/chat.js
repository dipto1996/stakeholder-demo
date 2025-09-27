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

// small URL verification similar to earlier (parallel, per-url timeout)
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal, redirect: "follow" });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}
async function verifyUrls(urls = [], { maxUrls = 6, perUrlTimeout = 2000 } = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  const take = urls.slice(0, maxUrls);
  const tasks = take.map(async (u) => {
    try {
      try {
        const h = await fetchWithTimeout(u, { method: "HEAD" }, perUrlTimeout);
        return { url: u, ok: h.ok, status: h.status };
      } catch (_) {
        try {
          const g = await fetchWithTimeout(u, { method: "GET" }, perUrlTimeout);
          return { url: u, ok: g.ok, status: g.status };
        } catch (e2) {
          return { url: u, ok: false, status: null };
        }
      }
    } catch (err) {
      return { url: u, ok: false, status: null };
    }
  });
  const settled = await Promise.allSettled(tasks);
  return settled.map(s => s.status === "fulfilled" ? s.value : null).filter(Boolean);
}

// detect synthesizer missing markers
function synthesisHasMissingMarkers(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  const markers = [
    "not in sources", "not in the sources", "not present in the sources", "i could not find",
    "no supporting source", "no evidence in the sources", "not found in the sources", "no documentation found"
  ];
  return markers.some(m => low.includes(m));
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return badRequest("Invalid request body");

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return badRequest("Empty user query");

    // Create conversationHistory array from previous messages (all except last)
    const conversationHistory = (messages || []).slice(0, -1);

    // quick greeting short-circuit
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(userQuery) && userQuery.split(/\s+/).length <= 4) {
      const greetResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "You are a warm, succinct assistant. Greet briefly." }, { role: "user", content: userQuery }],
        max_tokens: 80, temperature: 0.2,
      });
      const greet = greetResp?.choices?.[0]?.message?.content?.trim() || "Hello! How can I help?";
      return okJSON({ rag: { answer: greet, sources: [] }, fallback: null, path: "greet" });
    }

    // 1) Router uses conversationHistory to create refined query & intent
    const { refined_query, intent, format } = await routeQuery(userQuery, conversationHistory);

    // 2) Retrieval (pgvector) using refined_query
    const candidateRows = await retrieveCandidates(refined_query, { limit: 20 });

    if (!candidateRows || candidateRows.length === 0) {
      // fallback only, but keep links mapped to sources
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const rawUrls = fallback.raw_urls || [];
      const linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }).catch(() => rawUrls.map(u => ({ url: u, ok: null, status: null })));
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l, i) => ({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : rawUrls.slice(0,6).map((u,i) => ({ id: i+1, title: u, url: u }));
      // prepend disclaimer server-side (frontend will display it)
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleaned = (fallback.answer || "").startsWith("Disclaimer:") ? fallback.answer : disclaimer + (fallback.answer || "");
      return okJSON({ answer: cleaned, sources, fallback_links: linkInfo, path: "fallback" });
    }

    // 3) Build candidates and rerank
    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i+1,
      content: (r.content || "").slice(0, 1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file
    }));

    const reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length));

    // 4) Confidence check using reranked
    const confident = isConfident(reranked);

    if (!confident) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const rawUrls = fallback.raw_urls || [];
      const linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }).catch(() => rawUrls.map(u => ({ url: u, ok: null, status: null })));
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : rawUrls.slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u }));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleaned = (fallback.answer || "").startsWith("Disclaimer:") ? fallback.answer : disclaimer + (fallback.answer || "");
      return okJSON({ answer: cleaned, sources, fallback_links: linkInfo, path: "fallback", reason: "pre_synthesis_low_confidence" });
    }

    // 5) Synthesize using top reranked docs and pass conversationHistory so the answer is conversationally aware
    const topDocs = reranked.map(d => ({ id: d.id, content: d.content, source_title: d.source_title, source_url: d.source_url, score: d.score }));
    const final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory);

    // 6) Post-check synthesis coverage
    const synthText = final?.answer || "";
    const hasMissing = synthesisHasMissingMarkers(synthText);

    if (hasMissing) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory);
      const rawUrls = fallback.raw_urls || [];
      const linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }).catch(() => rawUrls.map(u => ({ url: u, ok: null, status: null })));
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : rawUrls.slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u }));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const cleaned = (fallback.answer || "").startsWith("Disclaimer:") ? fallback.answer : disclaimer + (fallback.answer || "");
      return okJSON({ answer: cleaned, sources, fallback_links: linkInfo, path: "fallback", reason: "synthesis_incomplete" });
    }

    // 7) OK — return RAG result (final should include final.sources)
    const rag_sources = final.sources && final.sources.length ? final.sources : topDocs.map((d,i)=>({ id: i+1, title: d.source_title || d.source_file || `source ${i+1}`, url: d.source_url || null }));
    return okJSON({ rag: { answer: final.answer, sources: rag_sources }, fallback: null, path: "rag" });

  } catch (err) {
    console.error("chat api error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal Server Error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
