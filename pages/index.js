// pages/index.js
import { useState, useRef, useEffect } from "react";
import { useSession } from "next-auth/react";
import AuthButton from "../components/AuthButton";
import ProtectedContent from "../components/ProtectedContent";

export default function ChatPage() {
  const { data: session } = useSession();
  const [messages, setMessages] = useState([]); // { role: 'user'|'assistant', content, sources? }
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e) {
    e?.preventDefault();
    const text = (input || "").trim();
    if (!text) return;
    // append user message immediately
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

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Unknown" }));
        throw new Error(err.error || `Status ${resp.status}`);
      }

      const data = await resp.json();
      // data: { answer: string, sources: [{id,title,url}] }
      const assistantMsg = { role: "assistant", content: data.answer || "No answer", sources: data.sources || [] };
      setMessages((m) => [...m, assistantMsg]);
    } catch (e) {
      console.error("chat error:", e);
      setMessages((m) => [...m, { role: "assistant", content: "Sorry — something went wrong." }]);
    } finally {
      setLoading(false);
    }
  }

  // Presentational helpers
  function renderSources(sources = []) {
    if (!sources || sources.length === 0) return null;
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #eee", background: "#f7fbff" }}>
        <div style={{ fontSize: 12, color: "#556", marginBottom: 6, fontWeight: 600 }}>Sources</div>
        <div>
          {sources.map((s) => (
            <div key={s.id} style={{ fontSize: 13, color: "#1558d6", marginBottom: 4 }}>
              [{s.id}]{" "}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: "#1558d6", textDecoration: "underline" }}>
                  {s.title || s.url}
                </a>
              ) : (
                <span style={{ color: "#333" }}>{s.title}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "Inter, sans-serif" }}>
      <header style={{ padding: 16, borderBottom: "1px solid #eee", background: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Immigration AI Assistant</h2>
          <div style={{ color: "#666", fontSize: 13 }}>Informational only — not legal advice</div>
        </div>
        <AuthButton />
      </header>

      <main style={{ flex: 1, overflow: "auto", padding: 20 }}>
        <ProtectedContent 
          fallback={
            <div style={{ maxWidth: 900, margin: "0 auto", textAlign: "center", padding: "40px 20px" }}>
              <h3 style={{ fontSize: "24px", marginBottom: "16px", color: "#333" }}>
                Welcome to Immigration AI Assistant
              </h3>
              <p style={{ color: "#666", marginBottom: "24px", lineHeight: 1.6 }}>
                Please sign in with your Google account to start asking questions about U.S. immigration.
              </p>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <AuthButton />
              </div>
            </div>
          }
        >
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
            {session && (
              <div style={{ marginBottom: "20px", padding: "12px", background: "#f0f9ff", borderRadius: "8px", border: "1px solid #bae6fd" }}>
                <div style={{ fontSize: "14px", color: "#0369a1", fontWeight: "500" }}>
                  Welcome back, {session.user.name || session.user.email}! 
                </div>
                <div style={{ fontSize: "12px", color: "#0284c7", marginTop: "4px" }}>
                  You can now ask questions about U.S. immigration policies and procedures.
                </div>
              </div>
            )}
            {messages.map((m, idx) => (
              <div key={idx} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 12 }}>
                <div style={{
                  maxWidth: "75%",
                  padding: 12,
                  borderRadius: 8,
                  background: m.role === "user" ? "#0b63d8" : "#fff",
                  color: m.role === "user" ? "#fff" : "#111",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                  border: m.role === "assistant" ? "1px solid #eee" : "none"
                }}>
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{m.content}</div>
                  {m.role === "assistant" && renderSources(m.sources)}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </ProtectedContent>
      </main>

      <footer style={{ padding: 16, borderTop: "1px solid #eee", background: "#fff" }}>
        <ProtectedContent>
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
        </ProtectedContent>
      </footer>
    </div>
  );
}
