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

async function createEmbeddingsWithRetry(text) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
      if (!resp?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return resp;
    } catch (err) {
      if (attempt === EMB_RETRIES - 1) throw err;
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
        temperature: 0.15,
      });
    } catch (err) {
      if (attempt === CHAT_RETRIES - 1) throw err;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
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

    // Quick greeting shortcut (cheap)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)[!.]?\s*$/i;
    if (GREETING_RE.test(userQuery)) {
      const greeting = "Hello! 👋 I can help explain U.S. immigration topics (H-1B, F-1, OPT, CPT). What would you like to know?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(greeting));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 1) Embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) Retrieve top-k
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question. Would you like (A) a broader search, (B) general guidance, or (C) lawyer review?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 3) Build sources and context
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || `Source ${i + 1}`,
      url: r.source_url || null,
    }));

    let totalChars = 0;
    const contextParts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT_LENGTH);
      if (totalChars + excerpt.length > MAX_CONTEXT_LENGTH) break;
      contextParts.push(`[${i + 1}] title: ${rows[i].source_title || `source_${i+1}`}\ncontent: ${excerpt}`);
      totalChars += excerpt.length;
    }
    const contextText = contextParts.join('\n\n---\n\n');

    const systemPrompt = `You are a friendly, careful AI assistant for U.S. immigration questions. Use ONLY the provided CONTEXT / SOURCES for factual claims. Cite facts with bracketed numbers like [1], [2]. Provide a short direct answer, key points (bulleted list), and next steps. Do NOT provide legal advice. If context is insufficient, say you couldn't find the answer in the provided documents. At the end output SUGGESTED: ["followup 1","followup 2"]`;
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 4) Chat completion (stream)
    const completion = await createCompletionWithRetry(messagesForModel);

    // 5) Prepare preamble AS AN SSE 'data: ' CHUNK (THIS IS THE CRITICAL FIX)
    // Important: we wrap JSON into an SSE data line so the ai/react client can parse the stream.
    const sourcesJson = JSON.stringify(sources);
    const preambleText = `SOURCES_JSON:${sourcesJson}\n\n`;
    // Format as an SSE `data:` line (OpenAIStream expects SSE framing).
    const preambleSSE = `data: ${preambleText}\n\n`;
    const encodedPreamble = new TextEncoder().encode(preambleSSE);

    // 6) Model stream produced by OpenAIStream (SSE formatted)
    const modelStream = OpenAIStream(completion);

    // 7) Combined stream: first the SSE preamble, then the model SSE stream
    const combined = new ReadableStream({
      async start(controller) {
        // enqueue the preamble as an SSE event
        controller.enqueue(encodedPreamble);

        // pipe the model SSE stream after
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
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
