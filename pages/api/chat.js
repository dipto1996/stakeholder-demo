// chat.js — Final Production-Ready Version (Edge + citations + streaming)
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Config ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT = 1600;
const MAX_CONTEXT = 6000;

// --- Helpers ---
async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!res?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return res;
    } catch (e) {
      if (attempt === EMB_RETRIES - 1) throw e;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

async function createCompletionWithRetry(messages) {
  for (let attempt = 0; attempt < CHAT_RETRIES; attempt++) {
    try {
      return await openai.chat.completions.create({
        model: CHAT_MODEL,
        stream: true,
        messages,
        temperature: 0.2,
      });
    } catch (e) {
      if (attempt === CHAT_RETRIES - 1) throw e;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

// --- Main handler ---
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { messages } = await req.json();
    if (!messages || messages.length === 0) return new Response('Invalid request', { status: 400 });

    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty query', { status: 400 });

    // Quick greeting
    const GREETING_RE = /^(hi|hello|hey)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("Hello! 👋 How can I help with your U.S. immigration questions?"));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 1. Embedding
    const emb = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = emb.data[0].embedding;

    // 2. Retrieve docs
    const { rows } = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 5
    `;
    if (!rows || rows.length === 0) {
      const s = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("I couldn't find matching documents in my sources."));
          c.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 3. Build sources + context
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || "Untitled Source",
      url: r.source_url,
    }));

    let total = 0;
    const contextParts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (total + excerpt.length > MAX_CONTEXT) break;
      contextParts.push(`[${i + 1}] ${excerpt}`);
      total += excerpt.length;
    }
    const contextText = contextParts.join('\n\n---\n\n');

    // 4. Prompts
    const systemPrompt = `
You are a friendly, careful AI assistant for U.S. immigration questions.
Rules:
- Use ONLY the CONTEXT sources below for factual claims.
- Cite facts with [1], [2], etc. referring to the numbered SOURCES.
- Output format: (1) Short answer (2) Key points (bullets) (3) Next steps.
- End with a line: SUGGESTED: ["Follow-up 1", "Follow-up 2"]
- Do NOT give legal advice.`;
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 5. Get completion
    const completion = await createCompletionWithRetry(messagesForModel);

    // 6. Prepend sources JSON for frontend
    const preamble = `SOURCES_JSON:${JSON.stringify(sources)}\n\n`;
    const encoded = new TextEncoder().encode(preamble);
    const modelStream = OpenAIStream(completion);

    const combined = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoded);
        const reader = modelStream.getReader();
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
    console.error('chat.js error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
