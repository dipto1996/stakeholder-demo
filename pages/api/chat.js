// chat.js — Final, Stable Version with Citations + Greetings
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const MAX_EXCERPT = 1600;
const MAX_CONTEXT_TOTAL = 6000;

// --- Helpers ---
async function embed(text) {
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return res.data[0].embedding;
}

// --- Handler ---
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json();
    const userQuery = (messages?.at(-1)?.content || '').trim();
    if (!userQuery) return new Response('Empty query', { status: 400 });

    // Greeting shortcut
    if (/^(hi|hello|hey)\b/i.test(userQuery)) {
      const s = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("Hello! 👋 How can I help with your U.S. immigration questions?"));
          c.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // Embedding + retrieval
    const emb = await embed(userQuery);
    const { rows } = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(emb)}::vector
      LIMIT 5
    `;

    if (!rows?.length) {
      const s = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("I couldn’t find supporting sources in the database."));
          c.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // Build sources metadata
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || "Untitled Source",
      url: r.source_url || null,
    }));

    // Context
    let chars = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (chars + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] ${excerpt}`);
      chars += excerpt.length;
    }

    const context = parts.join("\n\n---\n\n");
    const sysPrompt = `
You are a careful assistant for U.S. immigration.
Use ONLY the CONTEXT below. Always cite with [1], [2], etc.
Answer with: 
1) Short direct answer 
2) Key points (bullets) 
3) Next steps
Do not provide legal advice.
    `;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      stream: true,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION:\n${userQuery}` }
      ],
      temperature: 0.2,
    });

    // Prepend sources JSON
    const preamble = `SOURCES_JSON:${JSON.stringify(sources)}\n\n`;
    const encoded = new TextEncoder().encode(preamble);
    const stream = OpenAIStream(completion);

    const combined = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoded);
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      }
    });

    return new StreamingTextResponse(combined);

  } catch (err) {
    console.error("chat.js error", err);
    return new Response("Server error", { status: 500 });
  }
}
