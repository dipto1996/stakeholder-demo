// pages/api/chat.js — Final production-ready Edge RAG handler
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT = 1600;
const MAX_CONTEXT_TOTAL = 6000;

async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!resp?.data?.[0]?.embedding) throw new Error('No embedding returned');
      return resp;
    } catch (e) {
      if (attempt === EMB_RETRIES - 1) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
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
    } catch (e) {
      if (attempt === CHAT_RETRIES - 1) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

/**
 * server handler
 */
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request body', { status: 400 });
    }

    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response('Empty user query', { status: 400 });

    // Quick greeting shortcut — return a small LLM-generated stream so format matches full responses
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      // Use model to generate greeting so output format matches production responses
      const greetMessages = [
        { role: 'system', content: 'You are a friendly assistant for U.S. immigration questions. Greet concisely.' },
        { role: 'user', content: userQuery }
      ];
      const greetCompletion = await createCompletionWithRetry(greetMessages);
      const greetStream = OpenAIStream(greetCompletion);

      // Ensure SOURCES_JSON exists even for greetings
      const guardedGreeting = new ReadableStream({
        async start(controller) {
          const reader = greetStream.getReader();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            fullText += chunk;
            controller.enqueue(value);
          }
          if (!/SOURCES_JSON:/i.test(fullText)) {
            controller.enqueue(new TextEncoder().encode(`\n\nSOURCES_JSON:[]`));
          }
          controller.close();
        }
      });

      return new StreamingTextResponse(guardedGreeting);
    }

    // 1) Embedding
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;

    // 2) Retrieve top-k from DB (using @vercel/postgres sql tagged template)
    const embLiteral = JSON.stringify(queryEmbedding);
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    // 3) No results -> friendly fallback (no LLM call)
    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question.";
      // add SOURCES_JSON empty array so frontend parsing is consistent
      const fallbackWithMeta = `${fallback}\n\nSOURCES_JSON:[]`;
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallbackWithMeta));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 4) Build sources & context (trim excerpts + cap total)
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || `source_${i + 1}`,
      url: r.source_url || null,
    }));

    let totalChars = 0;
    const contextParts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (totalChars + excerpt.length > MAX_CONTEXT_TOTAL) break;
      contextParts.push(`[${i + 1}] source_title: ${rows[i].source_title || rows[i].source_url || 'Untitled'}\ncontent: ${excerpt}`);
      totalChars += excerpt.length;
    }
    const contextText = contextParts.join('\n\n---\n\n');

    // 5) Prompt engineering
    const systemPrompt = `You are a friendly and professional AI assistant for U.S. immigration questions. Use ONLY the numbered sources in the CONTEXT section below to answer the user's QUESTION. Cite facts using bracketed source numbers like [1], [2]. Output structure: short direct answer (1-3 sentences), key points (bulleted), next steps (1-3 items). Do NOT provide legal advice. At the very end include a machine-parsable line exactly like: SOURCES_JSON:[{"id":1,"title":"Source Title","url":"https://..."}]`;
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 6) Ask LLM (streaming)
    const completion = await createCompletionWithRetry(messagesForModel);
    const modelStream = OpenAIStream(completion);

    // 7) Guarded stream: pass chunks through and ensure SOURCES_JSON exists at the end
    const guardedStream = new ReadableStream({
      async start(controller) {
        const reader = modelStream.getReader();
        let fullText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = new TextDecoder().decode(value);
          fullText += chunk;
          controller.enqueue(value);
        }
        // append sources metadata if model didn't include it
        if (!/SOURCES_JSON:/i.test(fullText)) {
          const fallback = `\n\nSOURCES_JSON:${JSON.stringify(sources)}`;
          controller.enqueue(new TextEncoder().encode(fallback));
        } else {
          // If model did include SOURCES_JSON, still ensure it's the rich `sources` object if it omitted URLs/titles
          // (we won't attempt to patch partial model output — only add missing block)
        }
        controller.close();
      }
    });

    return new StreamingTextResponse(guardedStream);
  } catch (err) {
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
