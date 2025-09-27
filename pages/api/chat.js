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
function errJSON(msg, code = 500) {
  return new Response(JSON.stringify({ error: msg }), { status: code, headers: { "Content-Type": "application/json" } });
}

// Strip inline URLs/Links block and capture raw urls found in the text
function stripUrlsFromText(text = "") {
  const urlRegex = /\bhttps?:\/\/[^\s)]+/gi;
  const urls = Array.from(new Set((text.match(urlRegex) || []).map(u => u.replace(/[),.]*$/, ""))));
  let cleaned = text.replace(urlRegex, "").replace(/(Links|URLs?)\s*:\s*\n?[\s\S]*$/i, "").trim();
  cleaned = cleaned.replace(/\n{2,}/g, "\n\n").trim();
  return { cleanedText: cleaned, urlsInText: urls };
}

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
      } catch (headErr) {
        try {
          const g = await fetchWithTimeout(u, { method: "GET" }, perUrlTimeout);
          return { url: u, ok: g.ok, status: g.status };
        } catch (getErr) {
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

function synthesisHasMissingMarkers(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  const markers = [
    "not in sources","not in the sources","not present in the sources","i could not find",
    "no supporting source","no evidence in the sources","not found in the sources","no documentation found"
  ];
  return markers.some(m => low.includes(m));
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return errJSON("Invalid request body", 400);

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return errJSON("Empty user query", 400);

    // quick greeting detection (short)
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(userQuery) && userQuery.split(/\s+/).length <= 4) {
      try {
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
        return okJSON({ rag: { answer: greet, sources: [] }, fallback: null, path: "greet" });
      } catch (gerr) {
        // safe fallback greeting
        return okJSON({ rag: { answer: "Hello! How can I help?", sources: [] }, fallback: null, path: "greet" });
      }
    }

    // 1) Router (best-effort)
    const conversationHistory = (messages || []).slice(0, -1);
    let refined_query = userQuery;
    let intent = "question";
    try {
      const r = await routeQuery(userQuery, conversationHistory);
      refined_query = r?.refined_query || refined_query;
      intent = r?.intent || intent;
    } catch (re) {
      // continue with original query
      console.warn("routeQuery error:", re?.message || re);
    }

    // 2) Retrieval (with pgvector fallback inside retrieveCandidates)
    let candidateRows = [];
    try {
      candidateRows = await retrieveCandidates(refined_query, { limit: 20 });
    } catch (cre) {
      console.warn("retrieveCandidates error:", cre?.message || cre);
      candidateRows = [];
    }

    // If no candidates, do fallback route and return quickly, but ensure we return sources/mapped links
    if (!candidateRows || candidateRows.length === 0) {
      let fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      try { fallback = await getGeneralAnswer(userQuery, conversationHistory); } catch (ferr) { console.warn("fallback error:", ferr); }

      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      // verify links in parallel but don't block beyond per-url timeout
      let linkInfo = [];
      try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }); } catch (verr) { console.warn("verifyUrls error:", verr); linkInfo = (rawUrls || []).slice(0,6).map(u => ({ url: u, ok: null, status: null })); }

      // Map fallback links into sources so frontend shows them
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : ((rawUrls||[]).slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u })));

      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;

      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback" });
    }

    // 3) Prepare candidates and rerank
    const candidates = candidateRows.map((r,i)=>({
      id: r.id || i+1,
      content: (r.content || "").slice(0,1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file
    }));

    let reranked = [];
    try { reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length)); }
    catch (rr) { console.warn("rerankCandidates error:", rr?.message || rr); reranked = candidates.map((c,i)=>({...c, score: 0.5 - i*0.02})).slice(0, Math.min(6,candidates.length)); }

    // 4) Confidence check (use your isConfident)
    const confident = isConfident(reranked);

    // If not confident: fallback but include attempted sources for transparency
    if (!confident) {
      let fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      try { fallback = await getGeneralAnswer(userQuery, conversationHistory); } catch (ferr) { console.warn("fallback error:", ferr); }
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;

      let linkInfo = [];
      try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }); } catch (verr) { linkInfo = (rawUrls||[]).slice(0,6).map(u=>({url:u, ok:null, status:null})); }

      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : ((rawUrls||[]).slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u })));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback", reason: "pre_synthesis_low_confidence" });
    }

    // 5) Synthesize using top reranked docs
    const topDocs = reranked.map(d=>({ id: d.id, content: d.content, source_title: d.source_title, source_url: d.source_url, score: d.score }));
    let final = null;
    try { final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory); }
    catch (synthErr) {
      console.warn("synthesizeRAGAnswer error:", synthErr?.message || synthErr);
      // fallback as above
      const fallback = await getGeneralAnswer(userQuery, conversationHistory).catch(()=>({ answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] }));
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      const linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }).catch(()=> (rawUrls||[]).slice(0,6).map(u=>({url:u,ok:null,status:null})));
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : ((rawUrls||[]).slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u })));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback", reason: "synth_error" });
    }

    // 6) Post-check: if synthesizer says "not in sources" or similar -> fallback
    const synthText = (final?.answer || "");
    if (synthesisHasMissingMarkers(synthText)) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory).catch(()=>({ answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] }));
      const { cleanedText, urlsInText } = stripUrlsFromText(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      const linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }).catch(()=> (rawUrls||[]).slice(0,6).map(u=>({url:u,ok:null,status:null})));
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : ((rawUrls||[]).slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u })));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback", reason: "synthesis_incomplete" });
    }

    // 7) Success: return RAG answer with sources (synthesizer should already provide sources)
    const ragSources = final.sources && final.sources.length ? final.sources : topDocs.map((d,i)=>({ id: i+1, title: d.source_title || d.source_file || `source ${i+1}`, url: d.source_url || null }));
    return okJSON({ rag: { answer: final.answer, sources: ragSources }, fallback: null, path: "rag" });

  } catch (err) {
    console.error("chat api error:", err);
    return errJSON(err?.message || "Internal Server Error");
  }
}
