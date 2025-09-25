// chat.js — Final Version with Structured Data Streaming
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

export const config = { runtime: 'edge' };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req) {
  try {
    const { messages } = await req.json();
    const userQuery = messages[messages.length - 1].content;

    // --- Greeting Handler ---
    const GREETING_RE = /^(hi|hello|hey)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("Hello! How can I help with your U.S. immigration questions?"));
          controller.close();
        }
      });
      return new StreamingTextResponse(stream);
    }

    // --- RAG Pipeline ---
    const embResp = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: userQuery,
    });
    const queryEmbedding = embResp.data[0].embedding;

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
    
    const contextText = rows.map((r, i) => `[${i + 1}] source: ${r.source_title || 'Unknown Source'}\ncontent: ${r.content}`).join('\n\n---\n\n');
    
    const systemPrompt = `You are a friendly and professional AI assistant for U.S. immigration questions. Use ONLY the numbered sources in the CONTEXT section below to answer the user's QUESTION. You must cite your sources for every factual claim you make using the format [1], [2], etc. Your response should be structured with a short direct answer, followed by key points in a bulleted list, and finally a list of next steps. Do NOT provide legal advice.`;
    const userPrompt = `CONTEXT:\n${contextText}\n\nQUESTION:\n${userQuery}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
    });

    // --- CORRECTED: Use the Vercel AI SDK's built-in data streaming ---
    const stream = OpenAIStream(response, {
      experimental_streamData: true,
    });

    const data = {
      sources: sources,
    };
    
    stream.append(data); // Append the structured sources data to the stream
    
    return new StreamingTextResponse(stream);

  } catch (err) {
    console.error('Error in handler:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
