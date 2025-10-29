// pages/api/chat.js
import { sql } from "@vercel/postgres";
import openai from "../../lib/openaiClient.js";
import { routeQuery } from "../../lib/rag/router.js";
import { retrieveCandidates } from "../../lib/rag/retriever.js";
import { rerankCandidates } from "../../lib/rag/reranker.js";
import { isConfident } from "../../lib/rag/confidence.js";
import { synthesizeRAGAnswer } from "../../lib/rag/synthesizer.js";
import { getGeneralAnswer } from "../../lib/rag/fallback.js";
import { searchGold, formatGoldSources } from "../../lib/rag/searchGold.js";

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

    // === GOLDEN ANSWERS LOOKUP ===
    const USE_GOLD_KB = process.env.USE_GOLD_KB === "true";

    if (USE_GOLD_KB) {
      try {
        console.log("[gold] Searching golden answers for:", userQuery);
        const goldResult = await searchGold(userQuery, { limit: 5 });
        
        if (goldResult.best) {
          console.log(`[gold] Best match: ${goldResult.best.id}, combined=${goldResult.best.combined.toFixed(4)}, classification=${goldResult.classification}`);
          
          // HIGH CONFIDENCE: Auto-serve golden answer
          if (goldResult.classification === "gold") {
            const formattedSources = formatGoldSources(goldResult.best.sources);
            return okJSON({
              rag: {
                answer: goldResult.best.gold_answer,
                sources: formattedSources
              },
              fallback: null,
              path: "rag",
              gold_metadata: {
                id: goldResult.best.id,
                question: goldResult.best.question,
                human_confidence: goldResult.best.human_confidence,
                combined_score: goldResult.best.combined,
                verified_by: goldResult.best.verified_by,
                last_verified: goldResult.best.last_verified,
                classification: "gold"
              }
            });
          }
          
          // BORDERLINE: Serve with disclaimer
          if (goldResult.classification === "gold_borderline") {
            const disclaimer = "⚠️ Note: This is a high-confidence match from our curated knowledge base, but pending final verification.\n\n";
            const formattedSources = formatGoldSources(goldResult.best.sources);
            return okJSON({
              rag: {
                answer: disclaimer + goldResult.best.gold_answer,
                sources: formattedSources
              },
              fallback: null,
              path: "rag",
              gold_metadata: {
                id: goldResult.best.id,
                question: goldResult.best.question,
                human_confidence: goldResult.best.human_confidence,
                combined_score: goldResult.best.combined,
                classification: "gold_borderline"
              }
            });
          }
          
          // LOW SCORE: Continue to RAG
          console.log(`[gold] Score too low (${goldResult.best.combined.toFixed(4)}), falling through to RAG`);
        } else {
          console.log("[gold] No golden answer candidates found, falling through to RAG");
        }
      } catch (goldErr) {
        console.warn("[gold] Golden answer search failed:", goldErr?.message || goldErr);
        // Continue to RAG on error
      }
    }
    // === END GOLDEN ANSWERS LOOKUP ===

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
    
    // Phase 2: Include claims if available
    const responsePayload = { 
      rag: { 
        answer: final.answer, 
        sources: rag_sources 
      }, 
      fallback: null, 
      path: "rag" 
    };
    
    // Add claims if they were extracted
    if (final.claims && final.claims.length > 0) {
      responsePayload.rag.claims = final.claims;
    }
    
    return okJSON(responsePayload);

  } catch (err) {
    console.error("chat api error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal Server Error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
