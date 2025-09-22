// This is the final, complete code for pages/api/chat.js
import { OpenAIStream, StreamingTextResponse } from 'ai';
import OpenAI from 'openai';

// Import the knowledge base directly
import proclamationContext from '../../data/proclamation.txt';
import f1OptContext from '../../data/f1_opt_rules.txt';

export const config = {
  runtime: 'edge',
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const knowledgeBase = [
  { name: 'proclamation', content: proclamationContext },
  { name: 'f1_opt_rules', content: f1OptContext },
];

// Helper to create a stream from a simple string for greetings
function createStreamFromString(text) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
  return new StreamingTextResponse(stream);
}

const getContext = async (message) => {
  let bestContext = 'No relevant context found.';
  let bestScore = 0;
  const queryWords = new Set(message.toLowerCase().split(/\s+/));

  for (const doc of knowledgeBase) {
    const contentWords = new Set(doc.content.toLowerCase().split(/\s+/));
    let score = 0;
    for (const word of queryWords) {
      if (contentWords.has(word)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestContext = doc.content;
    }
  }
  return bestContext;
};

export default async function handler(req) {
  try {
    const { messages } = await req.json();
    const currentMessageContent = messages[messages.length - 1].content;
    const lowerCaseMessage = currentMessageContent.toLowerCase().trim();

    // Greeting Detection Logic
    const greetings = ['hello', 'hi', 'hey'];
    const thanks = ['thanks', 'thank you'];

    if (greetings.includes(lowerCaseMessage)) {
      return createStreamFromString("Hello! How can I help you with U.S. immigration questions today?");
    }

    if (thanks.includes(lowerCaseMessage)) {
      return createStreamFromString("You're welcome! Let me know if you have other questions.");
    }

    // RAG Logic
    const context = await getContext(currentMessageContent);

    const prompt = `
      You are an AI assistant for U.S. immigration.
      Answer the user's question based ONLY on the provided context.
      Do not provide legal advice. If the context is not sufficient, state that you cannot find the information.

      Context: """
      ${context}
      """

      User Question: "${currentMessageContent}"

      Answer:
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
    });

    const stream = OpenAIStream(response);
    return new StreamingTextResponse(stream);

  } catch (error) {
    console.error('Error in chat API:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
