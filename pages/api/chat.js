import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';
import { sql } from '@vercel/postgres';

// This is the critical missing line that tells Vercel to use the correct environment
export const config = {
  runtime: 'edge',
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json(); // This command now works correctly in the Edge runtime
    const userQuery = messages[messages.length - 1].content;

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: userQuery,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    const { rows } = await sql`
      SELECT content 
      FROM documents 
      ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)} 
      LIMIT 5
    `;
    const contextText = rows.map(r => r.content).join('\n\n---\n\n');

    const prompt = `
      You are a highly intelligent AI assistant for U.S. immigration questions.
      Answer the user's question based ONLY on the provided context below.
      If the context does not contain enough information, state that you cannot find the information in the provided documents.
      Do not provide legal advice.

      Context: """
      ${contextText}
      """

      User Question: "${userQuery}"

      Answer:
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    const stream = OpenAIStream(response);
    return new StreamingTextResponse(stream);

  } catch (error) {
    console.error('Error in chat API:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
