import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';

// NOTE: We are NOT importing or using the database for this test.

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

    // Using a hardcoded context to bypass the database completely.
    const contextText = "The H-1B proclamation requires a significant fee for applicants outside the US. F-1 students on OPT need their EAD card for travel.";

    // Using simple string concatenation to prevent any build errors.
    let prompt = "You are a helpful AI assistant. Answer the user's question based ONLY on the provided context.\n\n";
    prompt += 'Context: """\n';
    prompt += contextText;
    prompt += '\n"""\n\n';
    prompt += `User Question: "${userQuery}"\n\n`;
    prompt += "Answer:";

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
