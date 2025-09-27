// lib/rag/synthesizer.js
import openai from "../openaiClient.js";

/**
 * Try to extract any trailing JSON (or ```json fenced block) from model output.
 * If trailing JSON is found and parses, return { answerWithoutJson, parsedJson }.
 * Otherwise return { answerWithoutJson: raw, parsedJson: null }.
 */
function stripTrailingJson(raw) {
  if (!raw || typeof raw !== "string") return { answerWithoutJson: "", parsedJson: null };

  // Remove fenced ```json ... ``` blocks first
  let cleaned = raw.replace(/```json[\s\S]*?```/gi, (match) => {
    // try to get inner JSON
    const inner = match.replace(/```json/i, "").replace(/```$/, "").trim();
    return `\n${inner}\n`;
  });

  // Now try to find a trailing JSON object/string portion and parse it.
  // We'll scan from the end for a '{' and try parse progressively earlier occurrences.
  let lastOpen = cleaned.lastIndexOf("{");
  while (lastOpen > 0) {
    const candidate = cleaned.slice(lastOpen).trim();
    // Try to find a closing brace '}' at the end (if not, skip)
    const lastClose = candidate.lastIndexOf("}");
    if (lastClose === -1) {
      // move to previous '{'
      lastOpen = cleaned.lastIndexOf("{", lastOpen - 1);
      continue;
    }
    const maybeJson = candidate.slice(0, lastClose + 1);
    try {
      const parsed = JSON.parse(maybeJson);
      // If parsed ok, return answer before this json and the parsed object
      const answerWithoutJson = cleaned.slice(0, lastOpen).trim();
      return { answerWithoutJson, parsedJson: parsed };
    } catch (e) {
      // not valid JSON — move to earlier '{'
      lastOpen = cleaned.lastIndexOf("{", lastOpen - 1);
      continue;
    }
  }

  // If no trailing JSON parsed, return full cleaned text and null parsedJson.
  return { answerWithoutJson: cleaned.trim(), parsedJson: null };
}

/**
 * synthesizeRAGAnswer(rankedDocs, userQuery, intent, conversationHistory)
 * returns { answer, sources }
 *
 * Guarantees: answer contains no trailing JSON mapping or code fences.
 * sources is an array derived from rankedDocs (server-controlled).
 */
export async function synthesizeRAGAnswer(rankedDocs = [], userQuery, intent = "question", conversationHistory = []) {
  const docBlock = rankedDocs
    .map((d, i) =>
      `[${i + 1}] Title: ${d.source_title || d.source_file || `Doc ${d.id}`}\nURL: ${d.source_url || "N/A"}\nExcerpt:\n${(d.content || "").slice(0, 1200)}\n`
    )
    .join("\n---\n");

  const formatInstruction = {
    table: "Produce a comparison table and include inline [n] citations.",
    short_answer: "Give a concise answer (2–4 sentences) with citations.",
    bullet_points: "Return 3–5 concise bullets with citations.",
    step_by_step: "Return clear numbered steps. Cite sources for factual steps.",
  }[intent] || "Give a concise, factual answer with inline citations.";

  const history = (conversationHistory || []).slice(-6).map((m) => `${m.role || m.sender}: ${m.content}`).join("\n");

  // Strong instruction: use ONLY the documents below; if missing say "Not in sources"
  const systemPrompt = `
You are a careful assistant. Use ONLY the documents below to answer. Cite facts inline with [n] referencing the document order.
If a fact is not present, explicitly write "Not in sources" for that part.
Return markdown structured as:
**Answer:** (2–4 sentences)
**Key Points:** (3–5 bullets)
**Next Steps:** (up to 3 bullets)
End by listing a JSON block mapping [n] -> {id, title, url} so the UI can associate citations (OPTIONAL).
${formatInstruction}
`;

  const userPrompt = `
CONTEXT:
${docBlock}

QUESTION:
${userQuery}

RECENT_HISTORY:
${history}
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.0,
      max_tokens: 1100,
    });

    const raw = resp?.choices?.[0]?.message?.content || "";

    // Strip trailing JSON if present (so frontend never gets raw JSON in the answer)
    const { answerWithoutJson, parsedJson } = stripTrailingJson(raw);

    // Build deterministic sources list from rankedDocs (server-controlled)
    const sources = rankedDocs.map((d, i) => ({
      id: i + 1,
      title: d.source_title || d.source_file || `Doc ${d.id}`,
      url: d.source_url || null,
      excerpt: (d.content || "").slice(0, 400),
      score: d.score || 0,
    }));

    // Note: if parsedJson existed and contained a source mapping we could (optionally)
    // use it to reorder sources — but to avoid trusting model outputs, we rely on our own sources array.

    return { answer: answerWithoutJson.trim(), sources };
  } catch (err) {
    console.warn("synthesizeRAGAnswer error:", err?.message || err);
    const fallbackText = "Sorry — I couldn't synthesize an answer from the sources.";
    const sources = rankedDocs.map((d, i) => ({
      id: i + 1,
      title: d.source_title || d.source_file || `Doc ${d.id}`,
      url: d.source_url || null,
    }));
    return { answer: fallbackText, sources };
  }
}
