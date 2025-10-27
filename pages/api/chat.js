// pages/api/chat.js
import { sql } from "@vercel/postgres";
import openai from "../../lib/openaiClient.js";
import { routeQuery } from "../../lib/rag/router.js";
import { retrieveCandidates } from "../../lib/rag/retriever.js";
import { rerankCandidates } from "../../lib/rag/reranker.js";
import { isConfident } from "../../lib/rag/confidence.js";
import { synthesizeRAGAnswer } from "../../lib/rag/synthesizer.js";
import { getGeneralAnswer } from "../../lib/rag/fallback.js";

/**
 * Use Node runtime so process.env is available (Edge runtime does not expose env the same way).
 * If you previously had `{ runtime: "edge" }`, replace it with the line below.
 */
export const config = { runtime: "nodejs" };

// Helper functions no longer needed - using res.json() directly

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
 * DEBUG / FEATURE FLAGS
 * - DEBUG_RAG=1 → include debug payload
 * - BYPASS_RAG=1 → skip RAG and run LLM + cred_check
 * - SKIP_URL_VERIFY=1 → skip URL verification (faster response)
 *
 * Request header override for easy testing:
 * - x-bypass-rag: "1" => bypass regardless of env
 */
const DEBUG = process.env.DEBUG_RAG === "1";
const ENV_BYPASS = process.env.BYPASS_RAG === "1";
const SKIP_URL_VERIFY = process.env.SKIP_URL_VERIFY === "1";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Next.js API routes already parse the body
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) {
      return res.status(400).json({ error: "Empty user query" });
    }

    const conversationHistory = (messages || []).slice(0, -1);

    // Determine bypass flag: request header overrides env for testing
    const headerBypass = req.headers["x-bypass-rag"] === "1";
    const BYPASS_RAG = headerBypass || ENV_BYPASS;

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
        return res.status(200).json({ rag: { answer: greet, sources: [] }, fallback: null, path: "greet" });
      } catch {
        return res.status(200).json({ rag: { answer: "Hello! How can I help?", sources: [] }, fallback: null, path: "greet" });
      }
    }

    // 1) Router - Skip for simple queries to save time
    let refined_query = userQuery;
    let intent = "question";
    let format = "paragraph";
    
    // Skip router for short queries (performance optimization)
    const shouldRoute = userQuery.split(/\s+/).length > 5;
    if (shouldRoute) {
      try {
        const r = await routeQuery(userQuery, conversationHistory);
        refined_query = r.refined_query || refined_query;
        intent = r.intent || intent;
        format = r.format || format;
      } catch (rerr) {
        console.warn("routeQuery failed:", rerr?.message || rerr);
      }
    }

    /**************************************************************************
     * BYPASS_RAG PATH (LLM -> cred_check)
     **************************************************************************/
    if (BYPASS_RAG) {
      console.log("BYPASS_RAG enabled → Using LLM + cred-check pipeline.");

      // 1) Try to get structured JSON from helper (if available)
      let gptJson = null;
      try {
        if (typeof getGeneralAnswer === "function") {
          try {
            gptJson = await getGeneralAnswer(userQuery, conversationHistory, { structured: true });
          } catch (eStructured) {
            console.warn("getGeneralAnswer(structured) failed:", eStructured?.message || eStructured);
            gptJson = null;
          }
        }
      } catch (e) {
        console.warn("Attempt to call getGeneralAnswer failed:", e?.message || e);
        gptJson = null;
      }

      // 2) Force LLM to produce structured JSON if helper didn't
      if (!gptJson || !Array.isArray(gptJson.claims)) {
        try {
          const superPrompt = `You are a legal-information assistant. Answer using ONLY authoritative U.S. sources and produce valid JSON exactly in this format:
{
  "answer_text":"<full answer>",
  "claims":[{"id":"c1","text":"..."}],
  "citations":[{"claim_id":"c1","urls":[{"url":"https://...","quoted_snippet":"..."}]}]
}
For each factual sentence include at least one primary-source citation when possible (uscis.gov, dol.gov, state.gov, justice.gov, eoir.justice.gov, ecfr.gov, federalregister.gov, uscourts.gov, courtlistener.com, congress.gov, law.cornell.edu).
Return ONLY the JSON object (no extra commentary).`;

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
          if (m) {
            try {
              gptJson = JSON.parse(m[0]);
            } catch (parseErr) {
              console.warn("Failed to parse JSON from LLM response; wrapping as single claim", parseErr?.message || parseErr);
              gptJson = {
                answer_text: raw,
                claims: [{ id: "c1", text: raw.slice(0, 400) }],
                citations: []
              };
            }
          } else {
            gptJson = {
              answer_text: raw,
              claims: [{ id: "c1", text: raw.slice(0, 400) }],
              citations: []
            };
          }
        } catch (llmErr) {
          console.error("LLM structured JSON call failed:", llmErr);
          return res.status(200).json({ answer: "Sorry — temporarily unable to fetch verified answer.", sources: [], path: "fallback" });
        }
      }

      // 3) Call internal cred_check endpoint
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `https://${req.headers.host || "localhost:3000"}`;
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

      // 4) Interpret cred-check result
      let outcome = null;
      if (credRes?.result) outcome = credRes.result;
      else if (credRes?.ok && credRes.result) outcome = credRes.result;
      else if (credRes?.overall || credRes?.overallDecision || credRes?.results) outcome = credRes;

      if (outcome) {
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
            return res.status(200).json({ rag: { answer: gptJson.answer_text, sources }, fallback: null, path: "llm_cred_verified", _debug: debugPayload });
          if (decision === "probable")
            return res.status(200).json({ answer: `Partial verification: some claims could not be fully verified.\n\n${gptJson.answer_text}`, sources, path: "llm_cred_probable", _debug: debugPayload });
          return res.status(200).json({ answer: "We could not verify the claims in the LLM answer.", sources: [], path: "llm_cred_reject", _debug: debugPayload });
        } else {
          if (decision === "verified")
            return res.status(200).json({ rag: { answer: gptJson.answer_text, sources }, fallback: null, path: "llm_cred_verified" });
          if (decision === "probable")
            return res.status(200).json({ answer: `Partial verification: some claims could not be fully verified.\n\n${gptJson.answer_text}`, sources, path: "llm_cred_probable" });
          return res.status(200).json({ answer: "We could not verify the claims in the LLM answer.", sources: [], path: "llm_cred_reject" });
        }
      }

      return res.status(200).json({ answer: "Temporary verification failure; please try again later.", sources: [], path: "cred_check_error" });
    } // end BYPASS_RAG

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
      
      // Skip URL verification if flag is set (performance optimization)
      if (!SKIP_URL_VERIFY) {
        try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 4, perUrlTimeout: 1500 }); } catch { linkInfo = (rawUrls || []).slice(0, 4).map(u => ({ url: u, ok: null, status: null })); }
      } else {
        linkInfo = (rawUrls || []).slice(0, 6).map(u => ({ url: u, ok: null, status: null }));
      }

      const sources = (linkInfo && linkInfo.length)
        ? linkInfo.map((l, i) => ({ id: i + 1, title: l.url, url: l.url, ok: l.ok, status: l.status }))
        : (rawUrls || []).slice(0, 6).map((u, i) => ({ id: i + 1, title: u, url: u }));

      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return res.status(200).json({ answer: replyText, sources, path: "fallback" });
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
      
      // Skip URL verification if flag is set (performance optimization)
      if (!SKIP_URL_VERIFY) {
        try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 4, perUrlTimeout: 1500 }); } catch { linkInfo = (rawUrls || []).slice(0, 4).map(u => ({ url: u, ok: null, status: null })); }
      } else {
        linkInfo = (rawUrls || []).slice(0, 6).map(u => ({ url: u, ok: null, status: null }));
      }
      
      const sources = linkInfo.map((l, i) => ({ id: i + 1, title: l.url, url: l.url }));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return res.status(200).json({ answer: replyText, sources, path: "fallback" });
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
      return res.status(200).json({ answer: cleanedText, sources: [], path: "fallback" });
    }

    const synthText = final?.answer || "";
    if (synthesisHasMissingMarkers(synthText)) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory).catch(() => ({ answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] }));
      const { cleanedText } = stripInlineLinks(fallback.answer || "");
      return res.status(200).json({ answer: cleanedText, sources: [], path: "fallback" });
    }

    const rag_sources = final?.sources?.length
      ? final.sources
      : topDocs.map((d, i) => ({
          id: i + 1,
          title: d.source_title || d.source_file || `source ${i + 1}`,
          url: d.source_url || null,
          excerpt: d.content?.slice(0, 400)
        }));

    return res.status(200).json({ rag: { answer: final.answer, sources: rag_sources }, fallback: null, path: "rag" });
  } catch (err) {
    console.error("chat api error:", err);
    return res.status(500).json({ error: err?.message || "Internal Server Error" });
  }
}
