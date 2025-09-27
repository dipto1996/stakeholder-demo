// pages/index.js
import { useState, useRef, useEffect } from "react";
import Sidebar from "../components/Sidebar";

/* ---------------------------
   Small markdown-ish renderer
   - **bold**
   - "- " lists
   - simple tables that start with "|"
   - newline -> <br/>
   --------------------------- */

function simpleMarkdownToHtml(md = "") {
  if (!md) return "";

  // escape HTML
  let s = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // bold
  s = s.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  // split into lines and parse blocks (tables, lists, plain lines)
  const lines = s.split("\n");
  let i = 0;
  const out = [];

  while (i < lines.length) {
    const line = lines[i];

    // table block: contiguous lines starting with '|'
    if (/^\s*\|/.test(line)) {
      const tbl = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tbl.push(lines[i].trim());
        i++;
      }
      out.push(markdownTableToHtml(tbl));
      continue;
    }

    // list block: contiguous lines starting with '- '
    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, "").trim());
        i++;
      }
      const lis = items.map(item => `<li>${item}</li>`).join("");
      out.push(`<ul style="margin-top:6px;margin-bottom:6px;">${lis}</ul>`);
      continue;
    }

    // normal text line
    out.push(line.replace(/\n/g, "<br/>"));
    i++;
  }

  return out.join("\n");
}

function markdownTableToHtml(tblLines = []) {
  if (!tblLines || tblLines.length === 0) return "";

  // parse rows
  const rows = tblLines.map(line => {
    const trimmed = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
    return trimmed.split("|").map(cell => cell.trim());
  });

  let header = rows[0] || [];
  let body = rows.slice(1);

  // skip separator row if present (---)
  if (body.length > 0 && body[0].every(cell => /^:?-{2,}:?$/.test(cell))) {
    body = body.slice(1);
  }

  const thead = `<thead><tr>${header.map(h => `<th style="text-align:left;padding:8px;border-bottom:1px solid #eee">${h}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map(r => `<tr>${r.map(c => `<td style="padding:8px;border-bottom:1px solid #f5f7fb">${c}</td>`).join("")}</tr>`).join("")}</tbody>`;

  return `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;margin:8px 0 8px 0">${thead}${tbody}</table></div>`;
}

/* ---------------------------
   React Component
   --------------------------- */

export default function ChatPage() {
  const [messages, setMessages] = useState([]); // { role, content, path, sources? }
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedSourcesFor, setExpandedSourcesFor] = useState(null);
  const [sidebarConversation, setSidebarConversation] = useState(null); // new: holds selected conv meta
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Maximum number of messages (turns) to send to backend (keeps token usage bounded)
  const MAX_HISTORY_TURNS = 8;

  async function handleSubmit(e) {
    e?.preventDefault();
    const text = (input || "").trim();
    if (!text) return;

    // Build the new message object
    const userMsg = { role: "user", content: text };

    // Build payload messages: take the last MAX_HISTORY_TURNS turns from current messages,
    // then append the new user message. This ensures backend sees conversation history.
    const recent = (messages || []).slice(-MAX_HISTORY_TURNS);
    const payloadMessages = [...recent, userMsg];

    // Echo the user's message into UI immediately
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);

    try {
      // Debug: inspect the outgoing payload (remove in production)
      console.log("Sending to /api/chat payloadMessages:", payloadMessages);

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payloadMessages }),
      });

      // attempt to parse JSON
      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        // If server returned non-JSON error, try to present a friendly message
        const errMsg = (data && data.error) ? data.error : `Status ${resp.status} - ${resp.statusText}`;
        throw new Error(errMsg);
      }

      // Normalize backend shapes (rag / fallback / greet / legacy)
      if (data.path === "rag" && data.rag) {
        setMessages((m) => [...m, { role: "assistant", content: data.rag.answer || "", path: "rag", sources: data.rag.sources || [] }]);
      } else if (data.path === "greet" && data.rag) {
        setMessages((m) => [...m, { role: "assistant", content: data.rag.answer || "", path: "greet", sources: data.rag.sources || [] }]);
      } else if (data.path === "fallback") {
        // Map fallback_links or sources -> sources array for UI
        const fromSources = data.sources && Array.isArray(data.sources) && data.sources.length > 0;
        const links = fromSources ? data.sources : (data.fallback_links || data.fallbackLinks || []);
        const sources = Array.isArray(links)
          ? links.map((l, idx) => {
              if (!l) return null;
              if (typeof l === "string") return { id: idx + 1, title: l, url: l };
              return { id: idx + 1, title: l.title || l.url || l, url: l.url || null, ok: l.ok, status: l.status, excerpt: l.excerpt };
            }).filter(Boolean)
          : [];

        setMessages((m) => [...m, { role: "assistant", content: data.answer || "", path: "fallback", sources }]);
      } else if (data.answer && Array.isArray(data.sources)) {
        const path = data.sources && data.sources.length > 0 ? "rag" : "fallback";
        setMessages((m) => [...m, { role: "assistant", content: data.answer || "", path, sources: data.sources || [] }]);
      } else {
        // Unknown shape — show raw
        setMessages((m) => [...m, { role: "assistant", content: JSON.stringify(data), path: "fallback", sources: [] }]);
      }
    } catch (err) {
      console.error("chat error:", err);
      setMessages((m) => [...m, { role: "assistant", content: "Sorry — something went wrong.", path: "fallback", sources: [] }]);
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
              <div key={s.id || s.url || Math.random()} style={{ fontSize: 13, marginBottom: 10 }}>
                <div>
                  <span style={{ color: "#556", marginRight: 8 }}>[{s.id || "•"}]</span>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: "#1558d6", textDecoration: "underline" }}>
                      {s.title || s.url}
                    </a>
                  ) : (
                    <span style={{ color: "#333" }}>{s.title || s.source_file || "Source"}</span>
                  )}
                </div>
                {s.excerpt && (
                  <div style={{ fontSize: 12, color: "#444", marginTop: 6 }}>
                    {s.excerpt.length > 280 ? s.excerpt.slice(0, 280) + "…" : s.excerpt}
                  </div>
                )}
                {typeof s.ok !== "undefined" && (
                  <div style={{ fontSize: 11, color: s.ok ? "#2b6" : "#b33", marginTop: 6 }}>
                    {s.ok ? "Link reachable" : "Link check failed"} {s.status ? `(${s.status})` : ""}
                  </div>
                )}
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
        <div
          style={{
            maxWidth: "75%",
            padding: 12,
            borderRadius: 8,
            background: isUser ? "#0b63d8" : "#fff",
            color: isUser ? "#fff" : "#111",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            border: isUser ? "none" : "1px solid #eee",
          }}
        >
          {/* Fallback disclaimer */}
          {!isUser && m.path === "fallback" && (
            <div style={{ fontSize: 12, color: "#8a4b00", marginBottom: 8 }}>
              <strong>Note:</strong> This answer is based on general knowledge and not verified sources.
            </div>
          )}

          {/* Message content */}
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }} dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(m.content || "") }} />

          {/* Sources (works for both RAG and fallback) */}
          {!isUser && m.sources && m.sources.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ fontSize: 12, color: "#215", fontWeight: 700 }}>{m.path === "rag" ? "Verified (RAG)" : "Sources"}</div>
                <button onClick={() => toggleSources(idx)} style={{ fontSize: 12, color: "#1558d6", background: "transparent", border: "none", cursor: "pointer" }}>
                  {expandedSourcesFor === idx ? "Hide sources" : "Show sources"}
                </button>
              </div>
              {renderSources(m.sources, idx)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // New: load a conversation when selected in sidebar
  async function onSelectConversation(conv) {
    if (!conv) return;
    // If conv already has messages, use them
    if (conv.messages && Array.isArray(conv.messages)) {
      setMessages(conv.messages);
      return;
    }
    // Otherwise try to fetch the conversation by id
    try {
      const id = conv.id;
      if (!id) {
        alert("Selected conversation has no id");
        return;
      }
      const r = await fetch(`/api/conversations/get?id=${encodeURIComponent(id)}`);
      if (!r.ok) {
        console.warn("Could not fetch conversation, status:", r.status);
        alert("Could not load saved conversation (server returned " + r.status + ").");
        return;
      }
      const d = await r.json();
      const msgs = d.conversation?.messages || d.messages || d;
      if (Array.isArray(msgs)) {
        setMessages(msgs);
      } else {
        alert("Saved conversation did not contain messages.");
      }
    } catch (err) {
      console.error("Load conversation error:", err);
      alert("Could not load conversation. See console for details.");
    }
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Sidebar on the left (new) */}
      <Sidebar onSelectConversation={onSelectConversation} />

      {/* Main chat area (existing UI preserved) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
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
    </div>
  );
}
