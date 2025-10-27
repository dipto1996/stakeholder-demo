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
  // Remove any explicit "Links:" block and any bare URLs; return cleaned text and urls
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

function synthesisHasMissingMarkers(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  const markers = [
    "not in sources","not in the sources","not present in the sources","i could not find",
    "no supporting source","no evidence in the sources","not found in the sources","no documentation found"
  ];
  return markers.some(m => low.includes(m));
}

/**
 * ===========================
 *  DEBUG / FEATURE FLAGS
 * ===========================
 *
 * - DEBUG_RAG (set to "1" to include debug payloads in responses)
 * - BYPASS_RAG (set to "1" to skip retrieve->rerank->synthesize and instead run LLM->cred_check)
 *
 * Note: BYPASS_RAG is safe toggle for short-term tests. When unset (default) the original RAG flow runs.
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
      } catch (gerr) {
        return okJSON({ rag: { answer: "Hello! How can I help?", sources: [] }, fallback: null, path: "greet" });
      }
    }

    // 1) Router (use conversationHistory)
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
     *
     * If BYPASS_RAG=1, skip retrieve->rerank->synthesize and instead:
     *  - call LLM with a super-prompt to produce structured JSON
     *  - POST JSON to /api/cred_check
     *  - return cred-checked results to client
     *
     * The original RAG logic below is unchanged and will run when BYPASS_RAG is not set.
     **************************************************************************/
    if (BYPASS_RAG) {
      console.log("RAG BYPASS enabled. Using LLM + cred-check pipeline.");

      // --- 1: Try to get structured JSON from existing helper (if available) ---
      let gptJson = null;
      try {
        if (typeof getGeneralAnswer === "function") {
          // If getGeneralAnswer supports a structured flag, prefer that (non-blocking)
          try {
            gptJson = await getGeneralAnswer(userQuery, conversationHistory, { structured: true });
          } catch (eStructured) {
            // ignore and fall back to direct LLM call
            console.warn("getGeneralAnswer(structured) failed:", eStructured?.message || eStructured);
            gptJson = null;
          }
        }
      } catch (e) {
        console.warn("Attempt to call getGeneralAnswer failed:", e?.message || e);
        gptJson = null;
      }

      // --- 2: If no structured JSON, force the LLM to produce it ---
      if (!gptJson || !Array.isArray(gptJson.claims)) {
        try {
          const superPrompt = `You are a legal-information assistant. Answer using ONLY authoritative US sources and produce a JSON exactly in this format:
{
  "answer_text":"<full answer>",
  "claims":[{"id":"c1","text":"..."}],
  "citations":[{"claim_id":"c1","urls":[{"url":"https://...","quoted_snippet":"..."}]}]
}
For each factual sentence include at least one primary-source citation when possible (uscis.gov, dol.gov, state.gov, justice.gov, eoir.justice.gov, ecfr.gov, federalregister.gov, uscourts.gov, courtlistener.com, congress.gov, law.cornell.edu).
If you cannot find a primary-source citation for a claim, still include the claim and set cited URL(s) to an empty list. Return only valid JSON object (no commentary).`;

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
              console.warn("Failed to parse JSON from LLM response; falling back to text-wrapped claim", parseErr?.message || parseErr);
              gptJson = {
                answer_text: raw,
                claims: [{ id: "c1", text: raw.slice(0, 400) }],
                citations: []
              };
            }
          } else {
            // fallback: wrap the raw text as single claim
            gptJson = {
              answer_text: raw,
              claims: [{ id: "c1", text: raw.slice(0, 400) }],
              citations: []
            };
          }
        } catch (llmErr) {
          console.error("LLM structured JSON call failed:", llmErr);
          return okJSON({ answer: "Sorry — temporarily unable to fetch verified answer. Please try again later.", sources: [], path: "fallback" });
        }
      }

      // --- 3: Call the internal cred_check endpoint (serverless) ---
      // Resolve base URL for serverless invocation. Vercel provides VERCEL_URL in env during runtime.
      const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `https://${req.headers.get("host") || "localhost:3000"}`;
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
        credRes = null;
      }

      // --- 4: Interpret cred-check result and return appropriate response ---
      // Expected shapes: { ok:true, result: { overall_score, decision, results: [...] } } OR direct { overall, overallDecision, results }
      let outcome = null;
      if (credRes && credRes.result) outcome = credRes.result;
      else if (credRes && credRes.ok && credRes.result) outcome = credRes.result;
      else if (credRes && (credRes.overall || credRes.overallDecision || credRes.results)) outcome = credRes;
      else outcome = null;

      if (outcome) {
        const decision = outcome.decision || outcome.overallDecision || (typeof outcome.overall_score === "number" ? (outcome.overall_score >= 0.85 ? "verified" : (outcome.overall_score >= 0.6 ? "probable" : "reject")) : (typeof outcome.overall === "number" ? (outcome.overall >= 0.85 ? "verified" : (outcome.overall >= 0.6 ? "probable" : "reject")) : "reject")));

        // gather simple sources list (dedup URLs)
        const gatherSources = (outcome.results || []).flatMap(r => (r.evidence || []).map(e => e.url).filter(Boolean));
        const sources = Array.from(new Set(gatherSources)).slice(0, 6).map((u, i) => ({ id: i + 1, title: u, url: u }));

        if (DEBUG) {
          // include debug payload to help troubleshooting (only when DEBUG_RAG=1)
          const debugPayload = { raw_gpt_json: gptJson, cred_raw: credRes, decision };
          if (decision === "verified") return okJSON({ rag: { answer: gptJson.answer_text, sources }, fallback: null, path: "llm_cred_verified", _debug: debugPayload });
          if (decision === "probable") return okJSON({ answer: `Partial verification: some claims could not be fully verified.\n\n${gptJson.answer_text}`, sources, path: "llm_cred_probable", _debug: debugPayload });
          return okJSON({ answer: "We could not verify the claims in the LLM answer. A human review is required.", sources: [], path: "llm_cred_reject", _debug: debugPayload });
        } else {
          if (decision === "verified") return okJSON({ rag: { answer: gptJson.answer_text, sources }, fallback: null, path: "llm_cred_verified" });
          if (decision === "probable") return okJSON({ answer: `Partial verification: some claims could not be fully verified.\n\n${gptJson.answer_text}`, sources, path: "llm_cred_probable" });
          return okJSON({ answer: "We could not verify the claims in the LLM answer. A human review is required.", sources: [], path: "llm_cred_reject" });
        }
      } else {
        // cred_check failed or returned unexpected format
        return okJSON({ answer: "Temporary verification failure; please try again or contact support.", sources: [], path: "cred_check_error" });
      }
    } // end BYPASS_RAG

    /**************************************************************************
     * ORIGINAL RAG FLOW
     *
     * If BYPASS_RAG is not enabled, the code continues with the existing
     * retrieve -> rerank -> isConfident -> synthesize -> post-synthesis checks.
     * This block is unchanged from your original file.
     **************************************************************************/

    // 2) Retrieval
    let candidateRows = [];
    try {
      candidateRows = await retrieveCandidates(refined_query, { limit: 20 });
    } catch (cre) {
      console.warn("retrieveCandidates failed:", cre?.message || cre);
      candidateRows = [];
    }

    // If no candidates -> fallback-only (conversationHistory passed into fallback)
    if (!candidateRows || candidateRows.length === 0) {
      let fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      try { fallback = await getGeneralAnswer(userQuery, conversationHistory); } catch (ferr) { console.warn("getGeneralAnswer error:", ferr); }

      const { cleanedText, urlsInText } = stripInlineLinks(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }); } catch (verr) { console.warn("verifyUrls error:", verr); linkInfo = (rawUrls || []).slice(0,6).map(u => ({ url: u, ok: null, status: null })); }

      const sources = (linkInfo && linkInfo.length)
        ? linkInfo.map((l,i) => ({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status }))
        : (rawUrls || []).slice(0,6).map((u,i) => ({ id: i+1, title: u, url: u }));

      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback" });
    }

    // 3) Prepare candidates for reranking
    const candidates = candidateRows.map((r, i) => ({
      id: r.id || i+1,
      content: (r.content || "").slice(0, 1600),
      source_title: r.source_title,
      source_url: r.source_url,
      source_file: r.source_file,
    }));

    // 4) Rerank
    let reranked = [];
    try { reranked = await rerankCandidates(refined_query, candidates, Math.min(6, candidates.length)); }
    catch (rrerr) { console.warn("rerankCandidates failed:", rrerr?.message || rrerr); reranked = candidates.map((c,i)=>({...c, score: 0.5 - i*0.02})).slice(0, Math.min(6,candidates.length)); }

    // 5) Confidence check
    const confident = isConfident(reranked);

    if (!confident) {
      // fallback but include attempted sources
      let fallback = { answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] };
      try { fallback = await getGeneralAnswer(userQuery, conversationHistory); } catch (ferr) { console.warn("getGeneralAnswer error:", ferr); }
      const { cleanedText, urlsInText } = stripInlineLinks(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      let linkInfo = [];
      try { linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }); } catch (verr) { linkInfo = (rawUrls||[]).slice(0,6).map(u=>({url:u,ok:null,status:null})); }
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : rawUrls.slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u }));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback", reason: "pre_synthesis_low_confidence" });
    }

    // 6) Synthesize (pass conversationHistory)
    const topDocs = reranked.map(d => ({ id: d.id, content: d.content, source_title: d.source_title, source_url: d.source_url, score: d.score }));
    let final;
    try { final = await synthesizeRAGAnswer(topDocs, userQuery, intent, conversationHistory); }
    catch (synthErr) {
      console.warn("synthesizeRAGAnswer failed:", synthErr?.message || synthErr);
      const fallback = await getGeneralAnswer(userQuery, conversationHistory).catch(()=>({ answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] }));
      const { cleanedText, urlsInText } = stripInlineLinks(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      const linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }).catch(()=> (rawUrls||[]).slice(0,6).map(u=>({url:u,ok:null,status:null})));
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : rawUrls.slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u }));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback", reason: "synth_error" });
    }

    // 7) Post-synthesis check: missing coverage
    const synthText = final?.answer || "";
    if (synthesisHasMissingMarkers(synthText)) {
      const fallback = await getGeneralAnswer(userQuery, conversationHistory).catch(()=>({ answer: "Sorry — couldn't fetch a general answer right now.", raw_urls: [] }));
      const { cleanedText, urlsInText } = stripInlineLinks(fallback.answer || "");
      const rawUrls = (fallback.raw_urls && fallback.raw_urls.length) ? fallback.raw_urls : urlsInText;
      const linkInfo = await verifyUrls(rawUrls, { maxUrls: 6, perUrlTimeout: 2000 }).catch(()=> (rawUrls||[]).slice(0,6).map(u=>({url:u,ok:null,status:null})));
      const sources = (linkInfo && linkInfo.length) ? linkInfo.map((l,i)=>({ id: i+1, title: l.url, url: l.url, ok: l.ok, status: l.status })) : rawUrls.slice(0,6).map((u,i)=>({ id: i+1, title: u, url: u }));
      const disclaimer = "Disclaimer: Based on general knowledge (not verified sources). Please consult official sources for legal decisions.\n\n";
      const replyText = cleanedText.toLowerCase().startsWith("disclaimer:") ? cleanedText : disclaimer + cleanedText;
      return okJSON({ answer: replyText, sources, fallback_links: linkInfo, path: "fallback", reason: "synthesis_incomplete" });
    }

    // 8) Success: return RAG result (final.sources or topDocs -> mapped)
    const rag_sources = (final && final.sources && final.sources.length) ? final.sources : topDocs.map((d,i)=>({ id: i+1, title: d.source_title || d.source_file || `source ${i+1}`, url: d.source_url || null, excerpt: d.content && d.content.slice(0,400) }));
    return okJSON({ rag: { answer: final.answer, sources: rag_sources }, fallback: null, path: "rag" });

  } catch (err) {
    console.error("chat api error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal Server Error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
