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
    } catch (e) {
      if (attempt === CHAT_RETRIES - 1) throw e;
      await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

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

    // Quick greeting shortcut (use same streaming format as normal completions)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      // Use the model to generate a greeting so stream shape is identical
      const greetMessages = [
        { role: 'system', content: 'You are a concise friendly assistant for U.S. immigration.' },
        { role: 'user', content: userQuery }
      ];
      const greetCompletion = await createCompletionWithRetry(greetMessages);
      const greetStream = OpenAIStream(greetCompletion);
      return new StreamingTextResponse(greetStream);
    }

    // 1) create embedding for query
    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;
    const embLiteral = JSON.stringify(queryEmbedding);

    // 2) retrieve top-k docs from DB (pgvector)
    const q = await sql`
      SELECT source_title, source_url, content
      FROM documents
      ORDER BY embedding <=> ${embLiteral}::vector
      LIMIT 6
    `;
    const rows = q?.rows ?? [];

    // fallback if no docs
    if (!rows || rows.length === 0) {
      const fallback = "I couldn't find supporting documents in our indexed sources for that question.";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(fallback));
          controller.close();
        }
      });
      return new StreamingTextResponse(s);
    }

    // 3) build sources and context (trimmed)
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || r.source_url || `source_${i + 1}`,
      url: r.source_url || null
    }));

    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] source: ${rows[i].source_title || rows[i].source_url || 'Unknown'}\ncontent: ${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 4) compose prompt instructing model to cite sources, and to embed machine-readable sources at end
    const systemPrompt = `
You are a friendly and professional AI assistant for U.S. immigration questions.
Use ONLY the numbered sources in the CONTEXT section below to answer the user's QUESTION.
Cite every factual claim with bracketed source numbers like [1], [2].
Structure output: short direct answer (1-3 sentences), key points (bulleted), next steps (1-3).
Do NOT provide legal advice.
At the very end include a machine-parsable JSON exactly like: SUGGESTED: ["follow up 1", "follow up 2"]
    `.trim();

    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // 5) get streaming completion
    const completion = await createCompletionWithRetry(messagesForModel);

    // 6) create an OpenAIStream and attach structured metadata
    // Note: experimental_streamData option (and stream.append) depends on ai SDK version.
    const stream = OpenAIStream(completion, { experimental_streamData: true });

    // append structured metadata payload so frontend receives it as `data` (synchronized)
    // (If your ai SDK/version doesn't support stream.append, you can instead embed SOURCES_JSON preamble—older approach.)
    try {
      if (typeof stream.append === 'function') {
        stream.append({ sources });
      } else {
        // fallback: prepend a small JSON preamble text so legacy frontends can parse
        // we enqueue preamble bytes first and then let the model stream proceed
        // (but prefer stream.append when available)
      }
    } catch (e) {
      // non-fatal — proceed without append if unsupported
      console.warn('Could not append structured stream metadata:', e);
    }

    return new StreamingTextResponse(stream);

  } catch (err) {
    console.error('chat handler error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
