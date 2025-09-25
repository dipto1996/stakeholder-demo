// pages/api/chat.js
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tunables
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT_LENGTH = 1600;
const MAX_CONTEXT_LENGTH = 6000;

async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!r?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return r;
    } catch (e) {
      if (attempt === EMB_RETRIES - 1) throw e;
      await new Promise((res) => setTimeout(res, 2 ** attempt * 1000));
    }
  }
}

async function createCompletionWithRetry(messages, stream = true) {
  for (let attempt = 0; attempt < CHAT_RETRIES; attempt++) {
    try {
      return await openai.chat.completions.create({
        model: CHAT_MODEL,
        stream,
        messages,
        temperature: 0.15,
      });
    } catch (e) {
      if (attempt === CHAT_RETRIES - 1) throw e;
      await new Promise((res) => setTimeout(res, 2 ** attempt * 1000));
    }
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request body', { status: 400 });
    }

    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty user query', { status: 400 });

    // Greeting shortcut: use the model rather than raw bytes so the stream format matches.
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greetingMessages = [
        { role: 'system', content: 'You are a friendly assistant.' },
        { role: 'user', content: 'Say a short friendly greeting and ask how you can help with US immigration in one sentence.' },
      ];
      const completion = await createCompletionWithRetry(greetingMessages);
      const modelStream = OpenAIStream(completion);
      return new StreamingTextResponse(modelStream);
    }

    // 1) embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) retrieve top-k docs (expects documents table to have source_title, source_url, content, embedding)
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    if (!rows || rows.length === 0) {
      // Friendly fallback (no LLM call) — keep streaming format
      const fallbackText = "I couldn't find supporting documents in our indexed sources for that question. Would you like (A) a broader search, (B) general guidance, or (C) lawyer review?";
      const fallbackStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallbackText));
          controller.close();
        }
      });
      return new StreamingTextResponse(fallbackStream);
    }

    // 3) Build sources (title + url) and context (trimmed)
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || 'Untitled Source',
      url: r.source_url || null,
    }));

    let totalChars = 0;
    const contextParts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT_LENGTH);
      if (totalChars + excerpt.length > MAX_CONTEXT_LENGTH) break;
      contextParts.push(`[${i + 1}] source_title: ${rows[i].source_title || 'Untitled'}\ncontent: ${excerpt}`);
      totalChars += excerpt.length;
    }
    const contextText = contextParts.join('\n\n---\n\n');

    // 4) prompts
    const systemPrompt = `You are a friendly and professional AI assistant for U.S. immigration questions. Use ONLY the numbered sources in the CONTEXT section below to answer the user's QUESTION. Cite factual claims with [1], [2], etc. Output: (1) short answer, (2) key points (bulleted), (3) next steps. Do NOT provide legal advice. If context insufficient, say you cannot find it in the provided documents.`;
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    // 5) call model (stream)
    const completion = await createCompletionWithRetry(messagesForModel, /*stream*/ true);
    const modelStream = OpenAIStream(completion);

    // 6) append trailing SOURCES_JSON after model stream so frontend onFinish can parse it
    const suffix = `\n\nSOURCES_JSON:${JSON.stringify(sources)}\n`;
    const encodedSuffix = new TextEncoder().encode(suffix);

    const combined = new ReadableStream({
      async start(controller) {
        // pipe modelStream first
        const reader = modelStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        // then append suffix
        controller.enqueue(encodedSuffix);
        controller.close();
      }
    });

    return new StreamingTextResponse(combined);

  } catch (err) {
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
