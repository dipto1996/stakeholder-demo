// lib/rag/retriever.js
import OpenAI from "openai";
import { sql } from "@vercel/postgres";
import openai from "../openaiClient.js";

/**
 * createQueryEmbedding(text)
 */
export async function createQueryEmbedding(text) {
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return resp?.data?.[0]?.embedding || null;
}

/**
 * Keyword fallback search when pgvector isn't available or returns nothing.
 */
async function keywordSearch(query, limit = 20) {
  try {
    const q = `%${query}%`;
    const resp = await sql`
      SELECT id, content, source_title, source_url, source_file
      FROM documents
      WHERE content ILIKE ${q} OR source_title ILIKE ${q}
      LIMIT ${limit}
    `;
    return resp.rows || [];
  } catch (err) {
    console.warn("keywordSearch failed:", err?.message || err);
    return [];
  }
}

/**
 * retrieveCandidates(refinedQuery, opts)
 * - Try pgvector (embedding) ordering.
 * - If pgvector fails (no extension or query error), fall back to simple keyword search.
 */
export async function retrieveCandidates(refinedQuery, opts = { limit: 20 }) {
  const limit = opts.limit || 20;

  // 1) Attempt to get a query embedding
  let qEmb = null;
  try {
    qEmb = await createQueryEmbedding(refinedQuery);
  } catch (e) {
    console.warn("createQueryEmbedding failed:", e?.message || e);
    qEmb = null;
  }

  // 2) If we have an embedding, try pgvector ordering
  if (qEmb) {
    const embLiteral = "[" + qEmb.join(",") + "]";
    try {
      const resp = await sql`
        SELECT id, content, source_title, source_url, source_file, embedding
        FROM documents
        ORDER BY embedding <=> ${embLiteral}::vector
        LIMIT ${limit}
      `;
      const rows = resp.rows || [];
      if (rows.length > 0) return rows;
      // if empty, fall through to keyword search
    } catch (err) {
      console.warn("retrieveCandidates pgvector path failed:", err?.message || err);
      // fall back to keyword search
    }
  }

  // 3) Keyword fallback
  return await keywordSearch(refinedQuery, limit);
}

/**
 * Domain lists for reranker boosting/penalties (exported for other modules if needed)
 */
export const TRUSTED_DOMAINS = ["uscis.gov", "state.gov", "federalregister.gov", "congress.gov"];
export const NEWS_DOMAINS = ["nytimes.com","washingtonpost.com","cnn.com","foxnews.com","bloomberg.com","reuters.com","theguardian.com","forbes.com"];
