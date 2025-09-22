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

    // Using simple string concatenation for 100% reliability
    let prompt = "You are a helpful AI assistant. Answer the user's question based ONLY on the provided context.\n\n";
    prompt += 'Context: """\n';
    prompt += contextText;
    prompt += '\n"""\n\n';
    prompt += `User Question: "${userQuery}"\n\n`;
    prompt += "Answer:";

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
