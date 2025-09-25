// /pages/api/chat.js
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';

async function getEmbedding(text) {
  const resp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return resp.data[0].embedding;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json();
    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty query', { status: 400 });

    // Shortcut for greetings
    if (/^(hi|hello|hey)\b/i.test(userQuery)) {
      const s = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("Hello 👋 How can I help with U.S. immigration?"));
          c.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 1. Get embedding
    const queryEmbedding = await getEmbedding(userQuery);

    // 2. Query database for top docs
    const { rows } = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 5
    `;

    if (!rows || rows.length === 0) {
      const s = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("I couldn’t find supporting documents in the sources I know."));
          c.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // Build sources block
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || "Untitled",
      url: r.source_url,
    }));

    // Build context
    const context = rows.map((r, i) => `[${i + 1}] ${r.content.slice(0, 800)}`).join("\n\n");

    const systemPrompt = `You are a careful AI for U.S. immigration questions.
Always cite sources using [1], [2], etc. Do not hallucinate.
Keep answers short, structured, and do not give legal advice.`;

    const userPrompt = `CONTEXT:\n${context}\n\nQUESTION:\n${userQuery}`;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      stream: true,
      temperature: 0.15,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    // Send sources first so frontend can parse them
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
    console.error(err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
