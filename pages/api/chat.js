import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';

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
    const { messages } = await req.json();
    const userQuery = messages[messages.length - 1].content;

    // --- DIAGNOSTIC STEP ---
    // Instead of querying the database, we are using a hardcoded context.
    // This isolates the database connection as the potential point of failure.
    const contextText = `
      H-1B Proclamation of Sep 19, 2025: A $100,000 fee is required for certain H-1B beneficiaries.
      F-1 Student OPT Rules: When traveling on OPT, students must carry their EAD card and their I-20 endorsed for travel by their DSO within the last six months.
    `;
    // --- END OF DIAGNOSTIC STEP ---

    const prompt = \`You are a helpful AI assistant. Answer the user's question based ONLY on the provided context.
      
Context: """
\${contextText}
"""

User Question: "\${userQuery}"

Answer:\`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    });

    const stream = OpenAIStream(response);
    return new StreamingTextResponse(stream);

  } catch (error) {
    console.error('Error in chat API:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
