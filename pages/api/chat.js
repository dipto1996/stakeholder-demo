// pages/api/chat.js
// Non-streaming RAG handler that returns JSON { answer, sources }.
// This is intentionally simple and robust for debugging / initial launch.

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

async function retry(fn, attempts = 3, backoffBaseMs = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, backoffBaseMs * 2 ** i));
    }
  }
  throw lastErr;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const body = await req.json();
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages required' }), { status: 400 });
    }
    const userQuery = (messages[messages.length - 1].content || '').trim();
    if (!userQuery) return new Response(JSON.stringify({ error: 'empty user query' }), { status: 400 });

    // Greeting quick path: return friendly JSON
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greeting = "Hello! 👋 How can I help with your U.S. immigration questions today?";
      return new Response(JSON.stringify({ answer: greeting, sources: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1) create embedding (retry)
    let embedding;
    try {
      const embResp = await retry(() => openai.embeddings.create({ model: EMBEDDING_MODEL, input: userQuery }), EMB_RETRIES, 500);
      embedding = embResp?.data?.[0]?.embedding;
      if (!embedding) throw new Error('No embedding returned');
    } catch (e) {
      console.error('Embedding failed:', e?.message || e);
      // fallback: call LLM without context and return JSON
      const fallbackResp = await retry(() => openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: 'You are a friendly U.S. immigration assistant.' },
          { role: 'user', content: userQuery }
        ],
        temperature: 0.15,
        stream: false
      }), CHAT_RETRIES, 500);
      const fallbackText = fallbackResp?.choices?.[0]?.message?.content || "Sorry, I couldn't answer that right now.";
      return new Response(JSON.stringify({ answer: fallbackText, sources: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // 2) DB retrieval (use @vercel/postgres sql tagged template)
    let rows = [];
    try {
      const embLiteral = JSON.stringify(embedding);
      const q = await sql`
        SELECT source_title, source_url, content
        FROM documents
        ORDER BY embedding <=> ${embLiteral}::vector
        LIMIT 6
      `;
      rows = q?.rows ?? [];
    } catch (dbErr) {
      console.error('DB retrieval failed:', dbErr?.message || dbErr);
      rows = [];
    }

    // 3) If nothing found, fallback to LLM answer (non-RAG)
    if (!rows || rows.length === 0) {
      try {
        const fallbackResp = await retry(() => openai.chat.completions.create({
          model: CHAT_MODEL,
          messages: [
            { role: 'system', content: 'You are a friendly U.S. immigration assistant.' },
            { role: 'user', content: userQuery }
          ],
          temperature: 0.15,
          stream: false
        }), CHAT_RETRIES, 500);
        const fallbackText = fallbackResp?.choices?.[0]?.message?.content || "Sorry, I couldn't find relevant documents.";
        return new Response(JSON.stringify({ answer: fallbackText, sources: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        console.error('Fallback LLM failed:', e);
        return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
      }
    }

    // 4) Build context with budget and sources metadata
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || r.source_url || `source_${i+1}`,
      url: r.source_url || null
    }));

    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i+1}] ${rows[i].source_title || rows[i].source_url || `source_${i+1}`}\n${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 5) Construct RAG prompt and call model (non-stream)
    const systemPrompt = `You are a helpful, professional assistant for U.S. immigration questions.
Rules:
- Use ONLY the CONTEXT below for factual claims and cite using [1], [2], etc.
- If context is insufficient, say "I couldn't find an authoritative source in the provided documents."
- Do NOT provide legal advice.
Output: 1) Short direct answer (1-3 sentences), 2) Key points (bulleted), 3) Next steps (1-3 items).`;

    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    let completionResp;
    try {
      completionResp = await retry(() => openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.15,
        stream: false
      }), CHAT_RETRIES, 500);
    } catch (e) {
      console.error('RAG completion failed:', e);
      // fallback to non-RAG model answer
      const fallbackResp = await retry(() => openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: 'You are a helpful, professional assistant for U.S. immigration questions.' },
          { role: 'user', content: userQuery }
        ],
        temperature: 0.15,
        stream: false
      }), CHAT_RETRIES, 500);
      const fallbackText = fallbackResp?.choices?.[0]?.message?.content || "Sorry, I couldn't answer that right now.";
      return new Response(JSON.stringify({ answer: fallbackText, sources: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const answerText = completionResp?.choices?.[0]?.message?.content || "No response from model.";

    // 6) Return JSON with answer and sources
    return new Response(JSON.stringify({ answer: answerText, sources }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Unhandled API error:', err);
    return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
  }
}
