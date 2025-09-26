// pages/api/chat.js — Node runtime, plain JSON response
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Keep it Node so it matches NextAuth and your JSON UI expectations.
export const config = { runtime: 'nodejs' };

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const MAX_EXCERPT = 1600;
const MAX_CONTEXT_TOTAL = 6000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body?.messages || [];
    const userQuery = (messages[messages.length - 1]?.content || '').trim();
    if (!userQuery) return res.status(400).json({ error: 'Empty user query' });

    // Simple greeting path — still JSON so UI displays it
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(userQuery)) {
      return res.status(200).json({
        answer: 'Hello! How can I help with your U.S. immigration questions today?',
        sources: [],
      });
    }

    // 1) Embed
    const emb = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: userQuery,
    });
    const queryEmbedding = emb.data[0].embedding;

    // 2) Retrieve with citations
    const { rows } = await sql`
      SELECT content, source_title, source_url
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
      LIMIT 6
    `;

    if (!rows || rows.length === 0) {
      return res.status(200).json({
        answer:
          "I couldn't find supporting official sources in the provided documents. Want me to try a broader search?",
        sources: [],
      });
    }

    // Build sources
    const sources = rows.map((r, i) => ({
      id: i + 1,
      title: r.source_title || 'Untitled Source',
      url: r.source_url || null,
    }));

    // Build trimmed context
    let tot = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i++) {
      const excerpt = (rows[i].content || '').slice(0, MAX_EXCERPT);
      if (tot + excerpt.length > MAX_CONTEXT_TOTAL) break;
      parts.push(`[${i + 1}] ${rows[i].source_title || 'Source'}\n${excerpt}`);
      tot += excerpt.length;
    }
    const contextText = parts.join('\n\n---\n\n');

    // 3) Ask model (non-streaming)
    const systemPrompt =
      'You are a friendly, careful assistant for U.S. immigration. ' +
      'Use ONLY the CONTEXT below for factual claims and cite with [1],[2]. ' +
      'Structure: short answer, key points (bullets), next steps. Do not provide legal advice.';
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      stream: false,
      temperature: 0.15,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() ||
      'Sorry — I could not generate an answer.';

    // 4) Return JSON for your UI
    return res.status(200).json({ answer, sources });
  } catch (err) {
    console.error('chat error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
