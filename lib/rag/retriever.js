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
 * parseEmbeddingField(value) - parse common DB embedding formats into number[]
 */
function parseEmbeddingField(val) {
  if (!val) return null;
  if (Array.isArray(val)) return val.map(Number);
  if (typeof val === "string") {
    try {
      const j = JSON.parse(val);
      if (Array.isArray(j)) return j.map(Number);
    } catch {
      // try postgres array "{0.1,0.2}" or comma-separated
      const cleaned = val.replace(/^\{|\}$/g, "").trim();
      const parts = cleaned.split(/[, ]+/).filter(Boolean);
      return parts.map(Number);
    }
  }
  if (typeof val === "object") {
    for (const k of Object.keys(val)) if (Array.isArray(val[k])) return val[k].map(Number);
  }
  return null;
}

/**
 * retrieveCandidates(refinedQuery)
 * Attempts to use pgvector ordering; if pgvector not available, returns an empty array (caller handles fallback).
 */
export async function retrieveCandidates(refinedQuery, opts = { limit: 20 }) {
  // 1) create query embedding
  const qEmb = await createQueryEmbedding(refinedQuery);
  if (!qEmb) return [];

  // Build a Postgres literal for casting to vector (pgvector)
  const embLiteral = "[" + qEmb.join(",") + "]";

  try {
    // This assumes documents table has an 'embedding' column of type vector (pgvector).
    const limit = opts.limit || 20;
    const resp = await sql`
      SELECT id, content, source_title, source_url, source_file, embedding
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT ${limit}
    `;
    return resp.rows || [];
  } catch (err) {
    // If the ORDER BY fails (pgvector not present) caller will handle fallback.
    console.warn("retrieveCandidates pgvector path failed:", err?.message || err);
    return [];
  }
}
