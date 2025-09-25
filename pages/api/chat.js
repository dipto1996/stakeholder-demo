// chat.js — Final Production-Grade Version
// Incorporates all user feedback for robustness, idempotency, and error handling.
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

// This is the critical line that tells Vercel to use the correct, high-performance environment
export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Configuration ---
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const EMB_RETRIES = 3;
const CHAT_RETRIES = 2;
const MAX_EXCERPT_LENGTH = 1600; 
const MAX_CONTEXT_LENGTH = 6000;

// --- Helper Functions ---
async function createEmbeddingsWithRetry(input) {
  for (let attempt = 0; attempt < EMB_RETRIES; attempt++) {
    try {
      const response = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
      if (!response?.data?.[0]?.embedding) throw new Error("Embedding API returned no embedding.");
      return response;
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

// --- Main API Handler ---
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

    const GREETING_RE = /^(hi|hello|hey)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greetingStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("Hello! How can I help with your U.S. immigration questions?"));
          controller.close();
        }
      });
      return new StreamingTextResponse(greetingStream);
    }

    const embResp = await createEmbeddingsWithRetry(userQuery);
    const queryEmbedding = embResp.data[0].embedding;

    // CORRECTED: Added ::vector cast for robust querying
    const { rows } = await sql`
        SELECT source_title, source_url, content 
        FROM documents 
        ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
        LIMIT 5
    `;

    if (!rows || rows.length === 0) {
      const fallbackStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("I couldn't find supporting documents in our indexed sources for that question."));
          controller.close();
        }
      });
      return new StreamingTextResponse(fallbackStream);
    }

    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || "Untitled Source",
      url: r.source_url,
    }));
    
    let totalChars = 0;
    const contextParts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT_LENGTH);
      if (totalChars + excerpt.length > MAX_CONTEXT_LENGTH) break;
      contextParts.push(`[${i + 1}] source: ${rows[i].source_title || 'Unknown Source'}\ncontent: ${excerpt}`);
      totalChars += excerpt.length;
    }
    const contextText = contextParts.join('\n\n---\n\n');
    
    const systemPrompt = `You are a friendly and professional AI assistant for U.S. immigration questions. Use ONLY the numbered sources in the CONTEXT section below to answer the user's QUESTION. You must cite your sources for every factual claim you make using the format [1], [2], etc. Your response should be structured with a short direct answer, followed by key points in a bulleted list, and finally a list of next steps. Do NOT provide legal advice. If the context is insufficient, state that you cannot find the answer in the provided documents. At the very end of your response, include a machine-parsable line exactly like: SOURCES_JSON:[{"id":1,"title":"Source Title","url":"https://..."}, ...]`;
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const messagesForModel = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const completion = await createCompletionWithRetry(messagesForModel);

    // The Vercel AI SDK handles the streaming response
    const stream = OpenAIStream(completion);
    return new StreamingTextResponse(stream);

  } catch (err) {
    console.error('Error in handler:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
