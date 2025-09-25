// pages/api/chat.js
import { OpenAIStream, StreamingTextResponse } from "ai";
import OpenAI from "openai";

export const config = { runtime: "edge" };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMB_MODEL = "text-embedding-3-small";
const CHAT_MODEL = "gpt-4o-mini";

// The model is instructed to append a machine-parsable SUGGESTED JSON line at the very end:
// SUGGESTED: ["followup1", "followup2"]
// We do NOT send a raw byte preamble here — streaming only the model response.
async function createCompletionWithRetry(messages) {
  const RETRIES = 2;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await openai.chat.completions.create({
        model: CHAT_MODEL,
        stream: true,
        messages,
        temperature: 0.15,
      });
    } catch (e) {
      if (attempt === RETRIES - 1) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response("Invalid request body", { status: 400 });
    }
    const userQuery = (messages[messages.length - 1].content || "").trim();
    if (!userQuery) return new Response("Empty user query", { status: 400 });

    // Greeting shortcut (fast)
    const GREETING_RE = /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i;
    if (GREETING_RE.test(userQuery)) {
      const greeting = "Hello! 👋 I can help explain U.S. immigration rules (H-1B, F-1, OPT, CPT). What would you like to know?";
      const s = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(greeting));
          controller.close();
        },
      });
      return new StreamingTextResponse(s);
    }

    // Build a helpful prompt that requires the model to: (a) answer from provided context only,
    // (b) cite sources in [1], [2] format, (c) append SUGGESTED JSON at the end for UI chips.
    // NOTE: The frontend will fetch canonical 'sources' separately and display them as links;
    // here we only ask the model to cite with numbers matching the provided context order.
    const systemPrompt = `You are a friendly, professional assistant for U.S. immigration questions.
Rules:
- Use ONLY the CONTEXT section for factual claims. Do NOT hallucinate.
- Cite every factual claim using bracketed numbers e.g. [1], [2] that correspond to the numbered sources.
- Output structure: (1) Short direct answer (1-3 sentences) (2) Key points (bulleted list) (3) Next steps (1-3 items).
- At the very end (after whitespace/newline) append a machine-parsable SUGGESTED line exactly like:
SUGGESTED: ["prompt 1", "prompt 2"]
- Do NOT provide legal advice. If context is insufficient, say "I couldn't find supporting official sources in the provided documents."`;

    // We expect frontend to include the contextText in the user message if needed.
    // Here we simply use whatever messages the frontend passed through.
    const messagesForModel = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const completion = await createCompletionWithRetry(messagesForModel);

    const stream = OpenAIStream(completion);
    return new StreamingTextResponse(stream);
  } catch (err) {
    console.error("chat error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
