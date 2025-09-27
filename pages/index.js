// pages/index.js
import { useState, useRef, useEffect } from "react";

export default function ChatPage() {
  const [messages, setMessages] = useState([]); // { role: 'user'|'assistant', content, sources?:[], path?:'rag'|'fallback' }
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSourcesFor, setShowSourcesFor] = useState(null); // message index to expand sources
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function handleSubmit(e) {
    e?.preventDefault();
    const text = (input || "").trim();
    if (!text) return;
    const userMsg = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || resp.statusText);

      // detect if fallback (no sources)
      const pathIsFallback = !Array.isArray(data.sources) || data.sources.length === 0;
      const assistantMsg = {
        role: "assistant",
        content: data.answer || "No answer",
        sources: data.sources || [],
        path: pathIsFallback ? "fallback" : "rag",
      };
      setMessages((m) => [...m, assistantMsg]);
    } catch (err) {
      console.error("chat error:", err);
      setMessages((m) => [...m, { role: "assistant", content: "Sorry — something went wrong." }]);
    } finally {
      setLoading(false);
    }
  }

  function toggleSources(idx) {
    setShowSourcesFor((s) => (s === idx ? null : idx));
  }

  function renderSources(sources = [], idx) {
    if (!sources || sources.length === 0) return null;
    const collapsed = showSourcesFor !== idx;
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #eee", background: "#f7fbff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "#2a4365", fontWeight: 700 }}>Sources</div>
          <button onClick={() => toggleSources(idx)} style={{ fontSize: 12, color: "#1558d6", background: "transparent", border: "none", cursor: "pointer" }}>
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>

        {!collapsed && (
          <div style={{ marginTop: 8 }}>
            {sources.map((s) => (
              <div key={s.id} style={{ fontSize: 13, marginBottom: 8 }}>
                <div>
                  <span style={{ color: "#556", marginRight: 6 }}>[{s.id}]</span>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: "#1558d6", textDecoration: "underline" }}>
                      {s.title || s.url}
                    </a>
                  ) : (
                    <span style={{ color: "#333" }}>{s.title}</span>
                  )}
                </div>
                {s.excerpt && <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>{s.excerpt.slice(0, 300)}{s.excerpt.length > 300 ? "…" : ""}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderMessage(m, idx) {
    const isUser = m.role === "user";
    return (
      <div key={idx} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 12 }}>
        <div style={{
          maxWidth: "75%",
          padding: 12,
          borderRadius: 8,
          background: isUser ? "#0b63d8" : "#fff",
          color: isUser ? "#fff" : "#111",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          border: isUser ? "none" : "1px solid #eee",
        }}>
          {!isUser && m.path === "fallback" && (
            <div style={{ fontSize: 12, color: "#744", marginBottom: 8 }}>
              <strong>Note:</strong> This answer is based on general knowledge, not verified sources.
            </div>
          )}

          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{m.content}</div>

          {!isUser && m.sources && m.sources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ fontSize: 12, color: "#315", fontWeight: 600 }}>
                  {m.path === "rag" ? "Verified (RAG)" : "General"}
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(m.content);
                  }}
                  style={{ fontSize: 12, color: "#1558d6", background: "transparent", border: "none", cursor: "pointer" }}
                >
                  Copy
                </button>
                <button
                  onClick={() => toggleSources(idx)}
                  style={{ fontSize: 12, color: "#1558d6", background: "transparent", border: "none", cursor: "pointer" }}
                >
                  {showSourcesFor === idx ? "Hide sources" : "Show sources"}
                </button>
              </div>
              {renderSources(m.sources, idx)}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "Inter, system-ui, sans-serif" }}>
      <header style={{ position: "relative", padding: 16, borderBottom: "1px solid #eee", background: "#fff" }}>
        <h2 style={{ margin: 0 }}>Immigration AI Assistant</h2>
        <div style={{ color: "#666", fontSize: 13 }}>Informational Tool — Not Legal Advice</div>
        <div style={{ position: "absolute", right: 16, top: 12 }}>
          <a href="/login" style={{ padding: "8px 12px", background: "#0b63d8", color: "#fff", borderRadius: 8, textDecoration: "none" }}>
            Sign in / Sign up
          </a>
        </div>
      </header>

      <main style={{ flex: 1, overflow: "auto", padding: 20 }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          {messages.map((m, idx) => renderMessage(m, idx))}
          <div ref={endRef} />
        </div>
      </main>

      <footer style={{ padding: 16, borderTop: "1px solid #eee", background: "#fff" }}>
        <form onSubmit={handleSubmit} style={{ maxWidth: 900, margin: "0 auto", display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about U.S. immigration..."
            style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #ddd" }}
            disabled={loading}
          />
          <button type="submit" disabled={loading} style={{ padding: "10px 14px", borderRadius: 8, background: "#0b63d8", color: "#fff", border: "none" }}>
            {loading ? "Thinking..." : "Send"}
          </button>
        </form>
      </footer>
    </div>
  );
}
