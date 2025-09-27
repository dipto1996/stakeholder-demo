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
 * retrieveCandidates(refinedQuery)
 * Attempts to use pgvector ordering; if pgvector not available or fails, returns [] so caller can fallback.
 */
export async function retrieveCandidates(refinedQuery, opts = { limit: 20 }) {
  const qEmb = await createQueryEmbedding(refinedQuery);
  if (!qEmb) return [];

  // Postgres literal for casting to vector (pgvector)
  const embLiteral = "[" + qEmb.join(",") + "]";

  try {
    const limit = opts.limit || 20;
    const resp = await sql`
      SELECT id, content, source_title, source_url, source_file
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT ${limit}
    `;
    return resp.rows || [];
  } catch (err) {
    console.warn("retrieveCandidates: pgvector path failed:", err?.message || err);
    return [];
  }
}
