// pages/index.js
import { useChat } from "ai/react";
import { useRef, useEffect, useState } from "react";

export default function ChatPage() {
  const [parsedSources, setParsedSources] = useState({}); // messageId -> sources array
  const [pendingSourcesQueue, setPendingSourcesQueue] = useState([]); // FIFO queue of sources arrays
  const pendingRef = useRef([]); // mutable queue used across async calls
  const messagesEndRef = useRef(null);
  const [trendingTopics, setTrendingTopics] = useState([]);

  // useChat hook with onFinish that consumes pendingRef queue
  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading, append } =
    useChat({
      api: "/api/chat",
      onFinish: (message) => {
        // When a streaming message finishes, pop the next queued sources and attach
        const next = pendingRef.current.shift(); // FIFO
        if (next) {
          setParsedSources((prev) => ({ ...prev, [message.id]: next }));
        }
      },
    });

  // Keep pendingRef in sync with state queue
  useEffect(() => {
    pendingRef.current = [...pendingSourcesQueue];
  }, [pendingSourcesQueue]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    fetch("/trending.json")
      .then((r) => r.json())
      .then((d) => setTrendingTopics(d))
      .catch(() => {});
  }, []);

  // Intercept submit: fetch canonical sources first, queue them, then call handleSubmit
  async function onSubmit(e) {
    e.preventDefault();
    const q = (input || "").trim();
    if (!q) return;

    try {
      // fetch canonical sources (fast)
      const res = await fetch("/api/chat-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, topK: 6 }),
      });
      let sources = [];
      if (res.ok) {
        const j = await res.json();
        sources = j?.sources || [];
      } else {
        console.warn("chat-sources failed", await res.text());
      }
      // push to pending queue (frontend state)
      setPendingSourcesQueue((prev) => [...prev, sources]);

      // now call useChat's handleSubmit to stream the model result
      // handleSubmit expects the event; pass the original submit event.
      // if your handleSubmit implementation prevents default, we already did it; safe to call.
      await handleSubmit(e);
    } catch (err) {
      console.error("submit error:", err);
      // still call handleSubmit to attempt fallback streaming without sources
      await handleSubmit(e);
    }
  }

  // Helper to strip SUGGESTED metadata (the model will append SUGGESTED: [...])
  function stripSuggested(content) {
    if (!content) return "";
    return content.replace(/SUGGESTED:\s*\[[\s\S]*?\]\s*$/m, "").trim();
  }

  // parse suggested prompts from message content for UI chips (optional)
  function parseSuggested(content) {
    if (!content) return [];
    const m = content.match(/SUGGESTED:\s*(\[[\s\S]*?\])\s*$/m);
    if (m?.[1]) {
      try {
        return JSON.parse(m[1]);
      } catch (e) {
        return [];
      }
    }
    return [];
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
        <p className="text-sm text-neutral-500">Informational Tool — Not Legal Advice</p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((msg) => {
            const sources = parsedSources[msg.id] || [];
            const cleaned = stripSuggested(msg.content);

            return (
              <div key={msg.id} className={"flex " + (msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className={"max-w-xl p-3 rounded-lg shadow-sm " + (msg.role === "user" ? "bg-brand-blue text-white" : "bg-white text-neutral-900 border border-neutral-200")}>
                  <p className="whitespace-pre-wrap text-sm">{cleaned}</p>

                  {sources && sources.length > 0 && (
                    <div className="mt-2 border-t border-neutral-200 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Sources:</p>
                      <div className="space-y-1">
                        {sources.map((s) => (
                          <div key={s.id} className="text-xs text-neutral-500">
                            [{s.id}]{" "}
                            {s.url ? (
                              <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-brand-blue">
                                {s.title}
                              </a>
                            ) : (
                              s.title
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Suggested follow-ups from model (optional) */}
                  {parseSuggested(msg.content).length > 0 && (
                    <div className="mt-2 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Suggested follow-ups:</p>
                      <div className="flex flex-wrap gap-2">
                        {parseSuggested(msg.content).map((p, idx) => (
                          <button key={idx} onClick={() => append({ role: "user", content: p })} className="px-3 py-1 bg-neutral-200 text-neutral-700 text-sm rounded-full hover:bg-neutral-300 transition-colors">
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="p-4 border-t bg-white">
        <div className="max-w-3xl mx-auto">
          <form onSubmit={onSubmit}>
            <div className="flex space-x-2">
              <input value={input} onChange={handleInputChange} placeholder="Ask a question about U.S. immigration..." className="flex-1 p-2 border border-neutral-200 rounded-md focus:ring-2 focus:ring-brand-blue focus:outline-none" disabled={isLoading} />
              <button type="submit" disabled={isLoading} className="px-4 py-2 bg-brand-blue text-white font-semibold rounded-md disabled:bg-gray-400 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-brand-blue transition-colors">
                Send
              </button>
            </div>
          </form>

          {/* Trending & suggested prompts when empty */}
          {messages.length === 0 && trendingTopics.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-neutral-700 mb-2">Trending</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {trendingTopics.map((t, i) => (
                  <div key={i} className="p-3 bg-neutral-100 rounded-md border border-neutral-200">
                    <p className="font-semibold text-sm text-neutral-900">{t.title}</p>
                    <p className="text-xs text-neutral-500">{t.blurb}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
