import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages } = await req.json();
    const userQuery = messages[messages.length - 1].content;

    const contextText = `
      H-1B Proclamation of Sep 19, 2025: A $100,000 fee is required.
      F-1 Student OPT Rules: Students must carry their EAD card and I-20.
    `;

    const prompt = `You are a helpful AI assistant. Answer the user's question based ONLY on the provided context.
          
Context: """
${contextText}
"""

User Question: "${userQuery}"

Answer:`;

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