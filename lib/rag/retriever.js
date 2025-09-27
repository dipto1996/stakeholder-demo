// lib/rag/retriever.js
import openai from "../openaiClient.js";
import { sql } from "@vercel/postgres";

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
 * retrieveCandidates(refinedQuery, limit)
 * Attempts to use pgvector ordering; if that fails, return []
 */
export async function retrieveCandidates(refinedQuery, opts = { limit: 20 }) {
  const qEmb = await createQueryEmbedding(refinedQuery);
  if (!qEmb) return [];

  const embLiteral = "[" + qEmb.join(",") + "]";
  try {
    const limit = opts.limit || 20;
    const resp = await sql`
      SELECT id, content, source_title, source_url, source_file, embedding
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT ${limit}
    `;
    return resp.rows || [];
  } catch (err) {
    console.warn("retrieveCandidates: pgvector path failed", err?.message || err);
    return [];
  }
}

/**
 * Export trusted domain lists for downstream boosting/penalizing
 */
export const TRUSTED_DOMAINS = ["uscis.gov", "state.gov", "federalregister.gov", "congress.gov"];
export const NEWS_DOMAINS = ["nytimes.com","washingtonpost.com","cnn.com","foxnews.com","bloomberg.com","reuters.com","theguardian.com","forbes.com","buzzfeed.com","huffpost.com"];
