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

function stripInlineLinks(text = "") {
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
      } catch (_) {
        try {
          const g = await fetchWithTimeout(u, { method: "GET" }, perUrlTimeout);
          return { url: u, ok: g.ok, status: g.status };
        } catch {
          return { url: u, ok: false, status: null };
        }
      }
    } catch {
      return { url: u, ok: false, status: null };
    }
  });
  const settled = await Promise.allSettled(tasks);
  return settled.map(s => (s.status === "fulfilled" ? s.value : null)).filter(Boolean);
}

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
  return markers.some(m => low.includes(m));
}

/**
 * ===========================
 *  DEBUG / FEATURE FLAGS
 * ===========================
 * - DEBUG_RAG=1 → adds debug payloads in responses
 * - BYPASS_RAG=1 → skips RAG and runs LLM + cred_check instead
 */
const DEBUG = process.env.DEBUG_RAG === "1";
const BYPASS_RAG = process.env.BYPASS_RAG === "1";

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) return badRequest("Invalid request body");

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return badRequest("Empty user query");

    const conversationHistory = (messages || []).slice(0, -1);

    // Greeting short-circuit
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(userQuery) && userQuery.split(/\s+/).length <= 4) {
      try {
        const greetResp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a warm succinct immigration assistant. Greet briefly." },
            { role: "user", content: userQuery }
          ],
          max_tokens: 80,
          temperature: 0.2,
        });
        const greet = greetResp?.choices?.[0]?.message?.content?.trim() || "Hello! How can I help?";
        return okJSON({ rag: { answer: greet, sources: [] }, fallback: null, path: "greet" });
      } catch {
        return okJSON({ rag: { answer: "Hello! How can I help?", sources: [] }, fallback: null, path: "greet" });
      }
    }

    // 1) Router
    let refined_query = userQuery;
    let intent = "question";
    let format = "paragraph";
    try {
      const r = await routeQuery(userQuery, conversationHistory);
      refined_query = r.refined_query || refined_query;
      intent = r.intent || intent;
      format = r.format || format;
    } catch (rerr) {
      console.warn("routeQuery failed:", rerr?.message || rerr);
    }

    /**************************************************************************
     * BYPASS_RAG PATH
     **************************************************************************/
    if (BYPASS_RAG) {
      console.log("BYPASS_RAG enabled → Using LLM + cred-check pipeline.");

      let gptJson = null;
      try {
        if (typeof getGeneralAnswer === "function") {
          gptJson = await getGeneralAnswer(userQuery, conversationHistory, { structured: true });
        }
      } catch (e) {
        console.warn("getGeneralAnswer(structured) failed:", e?.message || e);
      }

      if (!gptJson || !Array.isArray(gptJson.claims)) {
        try {
          const superPrompt = `You are a legal-information assistant. Answer using ONLY authoritative US sources and produce valid JSON exactly as:
{
  "answer_text":"<full answer>",
  "claims":[{"id":"c1","text":"..."}],
  "citations":[{"claim_id":"c1","urls":[{"url":"https://...","quoted_snippet":"..."}]}]
}`;
          const resp = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: superPrompt },
              { role: "user", content: userQuery }
            ],
            max_tokens: 1200,
            temperature: 0.0,
          });
          const raw = resp?.choices?.[0]?.message?.content || "{}";
          const m = raw.match(/\{[\s\S]*\}/);
          gptJson = m ? JSON.parse(m[0]) : {
            answer_text: raw,
            claims: [{ id: "c1", text: raw.slice(0, 300) }],
            citations: []
          };
        } catch (err) {
          console.error("LLM structured JSON call failed:", err);
          return okJSON({ answer: "Sorry — temporarily unable to fetch verified answer.", sources: [], path: "fallback" });
        }
      }

      // --- Call cred_check API ---
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `https://${req.headers.get("host") || "localhost:3000"}`;
      let credRes = null;
      try {
        const credResp = await fetch(`${baseUrl}/api/cred_check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(gptJson),
        });
        credRes = await credResp.json();
      } catch (cErr) {
        console.warn("cred_check call failed:", cErr?.message || cErr);
      }

      let outcome = null;
      if (credRes?.result) outcome = credRes.result;
      else if (credRes?.ok && credRes.result) outcome = credRes.result;
      else if (credRes?.overall || credRes?.overallDecision || credRes?.results) outcome = credRes;

      if (outcome) {
        // --- fixed syntax here ---
        const decision =
          outcome.decision ||
          outcome.overallDecision ||
          (
            typeof outcome.overall_score === "number"
              ? (outcome.overall_score >= 0.85
                  ? "verified"
                  : outcome.overall_score >= 0.6
                    ? "probable"
                    : "reject")
              : typeof outcome.overall === "number"
                ? (outcome.overall >= 0.85
                    ? "verified"
                    : outcome.overall >= 0.6
                      ? "probable"
                      : "reject")
                : "reject"
          );

        const gatherSources = (outcome.results || [])
          .flatMap(r => (r.evidence || []).map(e => e.url).filter(Boolean));
        const sources = Array.from(new Set(gatherSources))
          .slice(0, 6)
          .map((u, i) => ({ id: i + 1, title: u, url: u }));

        if (DEBUG) {
          const debugPayload = { raw_gpt_json: gptJson, cred_raw: credRes, decision };
          if (decision === "verified")
            return okJSON({ rag: { answer: gptJson.answer_text, sources }, fallback: null, path: "llm_cred_verified", _debug: debugPayload });
          if (decision === "probable")
            return okJSON({ answer: `Partial verification: some claims could not be fully verified.\n\n${gptJson.answer_text}`, sources, path: "llm_cred_probable", _debug: debugPayload });
          return okJSON({ answer: "We could not verify the claims in the LLM answer.", sources: [], path: "llm_cred_reject", _debug: debugPayload });
        } else {
          if (decision === "verified")
            return okJSON({ rag: { answer: gptJson.answer_text, sources }, fallback: null, path: "llm_cred_verified" });
          if (decision === "probable")
            return okJSON({ answer: `Partial verification: some claims could not be fully verified.\n\n${gptJson.answer_text}`, sources, path: "llm_cred_probable" });
          return okJSON({ answer: "We could not verify the claims in the LLM answer.", sources: [], path: "llm_cred_reject" });
        }
      }

      return okJSON({ answer: "Temporary verification failure; please try again later.", sources: [], path: "cred_check_error" });
    }

    /**************************************************************************
     * ORIGINAL RAG FLOW (unchanged)
     **************************************************************************/
    let candidateRows = [];
    try {
      candidateRows = await retrieveCandidates(refined_query, { limit: 20 });
    } catch (cre) {
      console.warn("retrieveCandidates failed:", cre?.message || cre);
      candidateRows = [];
    }

    if (!candidateRows || candidateRows.length === 0) {
      let fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      try { fallback = await getGeneralAnswer(userQuery, conversationHistory); } catch (ferr) { console.warn("getGeneralAnswer error:", ferr); }

      const { cleanedText, urlsInText } = stripInlineLinks(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }); } catch { linkInfo = (rawUrls || []).slice(0, 6).map(u => ({ url: u, ok: null, status: null })); }

      const sources = (linkInfo && linkInfo.length)
        ? linkInfo.map((l, i) => ({ id: i + 1, title: l.url, url: l.url, ok: l.ok, status: l.status }))
        : (rawUrls || []).slice(0, 6).map((u, i) => ({ id: i + 1, title: u, url: u }));

      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, path: "fallback" });
    }

    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i + 1,
      content: (r.content || "").slice(0, 1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file,
    }));

    let reranked = [];
    try { reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length)); }
    catch { reranked = candidates.map((c, i) => ({ ...c, score: 0.5 - i * 0.02 })).slice(0, Math.min(6, candidates.length)); }

    const confident = isConfident(reranked);
    if (!confident) {
      let fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      try { fallback = await getGeneralAnswer(userQuery, conversationHistory); } catch { }
      const { cleanedText, urlsInText } = stripInlineLinks(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }); } catch { linkInfo = (rawUrls || []).slice(0, 6).map(u => ({ url: u, ok: null, status: null })); }
      const sources = linkInfo.map((l, i) => ({ id: i + 1, title: l.url, url: l.url }));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, path: "fallback" });
    }

    const topDocs = reranked.map(d => ({
      id: d.id, content: d.content, source_title: d.source_title,
      source_url: d.source_url, score: d.score
    }));

    let final;
    try { final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory); }
    catch {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory).catch(() => ({ answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] }));
      const { cleanedText } = stripInlineLinks(fallback.answer || "");
      return okJSON({ answer: cleanedText, sources: [], path: "fallback" });
    }

    const synthText = final?.answer || "";
    if (synthesisHasMissingMarkers(synthText)) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory).catch(() => ({ answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] }));
      const { cleanedText } = stripInlineLinks(fallback.answer || "");
      return okJSON({ answer: cleanedText, sources: [], path: "fallback" });
    }

    const rag_sources = final?.sources?.length
      ? final.sources
      : topDocs.map((d, i) => ({
          id: i + 1,
          title: d.source_title || d.source_file || `source ${i + 1}`,
          url: d.source_url || null,
          excerpt: d.content?.slice(0, 400)
        }));

    return okJSON({ rag: { answer: final.answer, sources: rag_sources }, fallback: null, path: "rag" });
  } catch (err) {
    console.error("chat api error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
