// lib/rag/searchGold.js
// Golden Answers search using dual embeddings (question + answer)

import { sql } from "@vercel/postgres";
import { createQueryEmbedding } from "./retriever.js";

/**
 * Search gold_answers table using question embeddings
 * @param {Array<number>} embedding - Query embedding vector
 * @param {number} limit - Max results to return
 * @returns {Array} Results with id, question, gold_answer, human_confidence, distance
 */
export async function searchGoldByQuestion(embedding, limit = 5) {
  try {
    const embLiteral = "[" + embedding.join(",") + "]";
    const resp = await sql`
      SELECT 
        id, 
        question, 
        gold_answer, 
        sources,
        human_confidence, 
        verified_by,
        last_verified,
        (question_embedding <=> ${embLiteral}::vector) as distance
      FROM public.gold_answers
      ORDER BY distance ASC
      LIMIT ${limit}
    `;
    return resp.rows || [];
  } catch (err) {
    console.warn("[searchGold] Question search failed:", err?.message || err);
    return [];
  }
}

/**
 * Search gold_answers table using answer embeddings
 * @param {Array<number>} embedding - Query embedding vector
 * @param {number} limit - Max results to return
 * @returns {Array} Results with id, question, gold_answer, human_confidence, distance
 */
export async function searchGoldByAnswer(embedding, limit = 5) {
  try {
    const embLiteral = "[" + embedding.join(",") + "]";
    const resp = await sql`
      SELECT 
        id, 
        question, 
        gold_answer, 
        sources,
        human_confidence, 
        verified_by,
        last_verified,
        (answer_embedding <=> ${embLiteral}::vector) as distance
      FROM public.gold_answers
      ORDER BY distance ASC
      LIMIT ${limit}
    `;
    return resp.rows || [];
  } catch (err) {
    console.warn("[searchGold] Answer search failed:", err?.message || err);
    return [];
  }
}

/**
 * Main gold search function - runs both question and answer searches in parallel
 * @param {string} queryText - User's query
 * @param {Object} opts - Options { limit: 5 }
 * @returns {Array} Merged and scored results
 */
export async function searchGold(queryText, opts = {}) {
  const limit = opts.limit || 5;
  
  // Thresholds (configurable via env vars)
  const GOLD_THRESHOLD = parseFloat(process.env.GOLD_THRESHOLD || "0.75");
  const GOLD_THRESHOLD_LOW = parseFloat(process.env.GOLD_THRESHOLD_LOW || "0.60");
  const HUMAN_CONF_THRESH = parseFloat(process.env.HUMAN_CONF_THRESH || "0.50");
  
  // Scoring weights
  const wq = 0.6;  // question similarity weight
  const wa = 0.3;  // answer similarity weight
  const wh = 0.1;  // human confidence weight
  
  try {
    // 1. Create query embedding
    const queryEmbedding = await createQueryEmbedding(queryText);
    if (!queryEmbedding) {
      console.warn("[searchGold] Failed to create query embedding");
      return { candidates: [], best: null, thresholds: { high: GOLD_THRESHOLD, low: GOLD_THRESHOLD_LOW } };
    }
    
    // 2. Run both searches in parallel
    const [questionResults, answerResults] = await Promise.all([
      searchGoldByQuestion(queryEmbedding, limit),
      searchGoldByAnswer(queryEmbedding, limit)
    ]);
    
    // 3. Merge results by ID
    const candidatesMap = {};
    
    // Helper to add/update candidate
    function addCandidate(row, type) {
      const id = row.id;
      // Convert distance to similarity (cosine distance: 0=identical, 2=opposite)
      // Similarity: 0=opposite, 1=identical
      const similarity = 1 - row.distance;
      
      if (!candidatesMap[id]) {
        candidatesMap[id] = {
          id: row.id,
          question: row.question,
          gold_answer: row.gold_answer,
          sources: row.sources || [],
          human_confidence: row.human_confidence || 0,
          verified_by: row.verified_by,
          last_verified: row.last_verified,
          sim_q: 0,
          sim_a: 0,
          dist_q: row.distance,
          dist_a: row.distance
        };
      }
      
      if (type === 'question') {
        candidatesMap[id].sim_q = Math.max(candidatesMap[id].sim_q, similarity);
        candidatesMap[id].dist_q = Math.min(candidatesMap[id].dist_q, row.distance);
      } else {
        candidatesMap[id].sim_a = Math.max(candidatesMap[id].sim_a, similarity);
        candidatesMap[id].dist_a = Math.min(candidatesMap[id].dist_a, row.distance);
      }
    }
    
    questionResults.forEach(row => addCandidate(row, 'question'));
    answerResults.forEach(row => addCandidate(row, 'answer'));
    
    // 4. Calculate combined scores
    const candidates = Object.values(candidatesMap).map(c => {
      // Combined score: weighted average of similarities + human confidence
      const combined = 
        wq * c.sim_q + 
        wa * c.sim_a + 
        wh * (c.human_confidence || 0);
      
      return { ...c, combined };
    });
    
    // 5. Sort by combined score (highest first)
    candidates.sort((a, b) => b.combined - a.combined);
    
    // 6. Determine best match and classification
    const best = candidates[0] || null;
    
    let classification = null;
    if (best) {
      if (best.combined >= GOLD_THRESHOLD && best.human_confidence >= HUMAN_CONF_THRESH) {
        classification = "gold";  // Auto-serve
      } else if (best.combined >= GOLD_THRESHOLD_LOW) {
        classification = "gold_borderline";  // Show with disclaimer
      } else {
        classification = "rag";  // Fall back to RAG
      }
    }
    
    return {
      candidates,
      best,
      classification,
      thresholds: {
        high: GOLD_THRESHOLD,
        low: GOLD_THRESHOLD_LOW,
        human_conf: HUMAN_CONF_THRESH
      }
    };
    
  } catch (err) {
    console.error("[searchGold] Error:", err?.message || err);
    return { 
      candidates: [], 
      best: null, 
      classification: "rag",
      thresholds: { 
        high: parseFloat(process.env.GOLD_THRESHOLD || "0.75"), 
        low: parseFloat(process.env.GOLD_THRESHOLD_LOW || "0.60") 
      } 
    };
  }
}

/**
 * Format gold sources for response
 * Converts gold_answers.sources format to match RAG sources format
 * @param {Array} goldSources - Sources from gold_answers table
 * @returns {Array} Formatted sources
 */
export function formatGoldSources(goldSources) {
  if (!goldSources || !Array.isArray(goldSources)) return [];
  
  return goldSources.map((src, idx) => ({
    id: idx + 1,
    title: src.title || "Gold Standard Answer",
    url: src.url || null,
    excerpt: src.excerpt || "",
    snapshot_url: src.snapshot_url || null
  }));
}

