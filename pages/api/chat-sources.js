// pages/api/chat-sources.js
import OpenAI from "openai";
import { sql } from "@vercel/postgres";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Return top-k sources (title + url + excerpt) for a query.
// This endpoint is intentionally non-streaming and fast: frontend calls this
// before starting the streaming /api/chat call so UI gets canonical citations.
export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { query, topK = 5 } = await req.json();
    if (!query) return new Response("Missing query", { status: 400 });

    // 1) produce embedding (retry simple)
    let embResp;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        embResp = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: query,
        });
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }
    if (!embResp?.data?.[0]?.embedding) {
      return new Response("Embedding failed", { status: 500 });
    }
    const embLiteral = JSON.stringify(embResp.data[0].embedding);

    // 2) query DB (assumes documents table has source_title, source_url, content, embedding)
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT ${topK}
    `;
    const rows = q?.rows ?? [];

    // 3) build sources array (id, title, url, excerpt)
    const MAX_EXCERPT = 1200;
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || `source_${i + 1}`,
      url: r.source_url || null,
      excerpt: (r.content || "").slice(0, MAX_EXCERPT),
    }));

    return new Response(JSON.stringify({ sources }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("chat-sources error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
