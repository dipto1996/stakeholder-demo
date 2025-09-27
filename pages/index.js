// pages/index.js
import { useState, useRef, useEffect } from "react";

function simpleMarkdownToHtml(md = "") {
  // Very small markdown-ish renderer:
  // - **bold**
  // - "- " lists
  // - line breaks
  let s = md || "";
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  const lines = s.split("\n");
  let out = [];
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s+/.test(line)) {
      if (!inList) {
        out.push("<ul style='margin-top:6px;margin-bottom:6px;'>");
        inList = true;
      }
      out.push("<li>" + line.replace(/^\s*-\s+/, "") + "</li>");
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(line.replace(/\n/g, "<br/>"));
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

export default function ChatPage() {
  const [messages, setMessages] = useState([]); // [{ role, content, path, sources?, fallbackLinks? }]
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedSourcesFor, setExpandedSourcesFor] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
      console.log("API /api/chat response:", data); // debug: remove later

      if (!resp.ok) {
        throw new Error(data?.error || resp.statusText || "API error");
      }

      // Normalize the possible response shapes:
      // 1) { rag: {answer, sources}, path: "rag" }
      // 2) { answer, sources: [], fallback_links, path: "fallback" }
      // 3) { rag: {answer}, path: "greet" }
      // 4) legacy: { answer, sources }
      if (data.path === "rag" && data.rag) {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: data.rag.answer || "",
            path: "rag",
            sources: data.rag.sources || [],
          },
        ]);
      } else if (data.path === "greet" && data.rag) {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: data.rag.answer || "",
            path: "greet",
            sources: data.rag.sources || [],
          },
        ]);
      } else if (data.path === "fallback") {
        // fallback-only shape: map backend fallback_links -> message.fallbackLinks
        const fallbackLinks = data.fallback_links || data.fallbackLinks || [];
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: data.answer || "",
            path: "fallback",
            fallbackLinks: Array.isArray(fallbackLinks) ? fallbackLinks : [],
          },
        ]);
      } else if (data.answer && Array.isArray(data.sources)) {
        // legacy shape
        const path = data.sources && data.sources.length > 0 ? "rag" : "fallback";
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: data.answer || "",
            path,
            sources: data.sources || [],
            fallbackLinks: data.fallback_links || [],
          },
        ]);
      } else {
        // unknown shape - show raw response
        setMessages((m) => [
          ...m,
          { role: "assistant", content: JSON.stringify(data), path: "fallback" },
        ]);
      }
    } catch (err) {
      console.error("chat error:", err);
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Sorry — something went wrong.", path: "fallback" },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function toggleSources(idx) {
    setExpandedSourcesFor((s) => (s === idx ? null : idx));
  }

  function renderSources(sources = [], msgIdx) {
    if (!sources || sources.length === 0) return null;
    const expanded = expandedSourcesFor === msgIdx;
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #eee", background: "#f7fbff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "#2a4365", fontWeight: 700 }}>Sources</div>
          <button onClick={() => toggleSources(msgIdx)} style={{ fontSize: 12, color: "#1558d6", background: "transparent", border: "none", cursor: "pointer" }}>
            {expanded ? "Hide" : "Show"}
          </button>
        </div>

        {expanded && (
          <div style={{ marginTop: 8 }}>
            {sources.map((s) => (
              <div key={s.id || s.url || Math.random()} style={{ fontSize: 13, marginBottom: 8 }}>
                <div>
                  <span style={{ color: "#556", marginRight: 6 }}>[{s.id || "•"}]</span>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: "#1558d6", textDecoration: "underline" }}>
                      {s.title || s.url}
                    </a>
                  ) : (
                    <span style={{ color: "#333" }}>{s.title || s.source_file || "Source"}</span>
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

  function renderFallbackLinks(links = []) {
    if (!links || links.length === 0) return null;
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #eee", background: "#fff8f0" }}>
        <div style={{ fontSize: 12, color: "#8a4b00", fontWeight: 700 }}>Links</div>
        <div style={{ marginTop: 8 }}>
          {links.map((l) => (
            <div key={l.url} style={{ fontSize: 13, marginBottom: 6 }}>
              <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "#b56b00", textDecoration: "underline" }}>
                {l.url}
              </a>{" "}
              <span style={{ fontSize: 12, color: l.ok ? "#2b6" : "#b33" }}>({l.status || (l.ok ? "OK" : "failed")})</span>
            </div>
          ))}
        </div>
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
            <div style={{ fontSize: 12, color: "#8a4b00", marginBottom: 8 }}>
              <strong>Note:</strong> This answer is based on general knowledge and not verified sources.
            </div>
          )}

          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }} dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(m.content || "") }} />

          {!isUser && m.path === "rag" && m.sources && m.sources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ fontSize: 12, color: "#215", fontWeight: 700 }}>Verified (RAG)</div>
                <button onClick={() => toggleSources(idx)} style={{ fontSize: 12, color: "#1558d6", background: "transparent", border: "none", cursor: "pointer" }}>
                  {expandedSourcesFor === idx ? "Hide sources" : "Show sources"}
                </button>
              </div>
              {renderSources(m.sources, idx)}
            </div>
          )}

          {!isUser && m.path === "fallback" && m.fallbackLinks && m.fallbackLinks.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ fontSize: 12, color: "#8a4b00", fontWeight: 700 }}>Links</div>
              </div>
              {renderFallbackLinks(m.fallbackLinks)}
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
