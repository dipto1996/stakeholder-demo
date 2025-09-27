// components/Sidebar.jsx
import { useEffect, useState } from "react";
import Link from "next/link";

export default function Sidebar({ onSelectConversation, onNewConversation, refreshKey }) {
  const [convos, setConvos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/conversations/list");
      if (!r.ok) {
        throw new Error(`List failed (${r.status})`);
      }
      const d = await r.json();
      // Accept server shapes: { conversations: [...] } or raw array
      const list = d.conversations || d || [];
      setConvos(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error("Sidebar load error:", err);
      setError(err.message || "Could not load");
      setConvos([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]); // reload when refreshKey changes

  return (
    <div style={{ width: 260, borderRight: "1px solid #eee", padding: 12, boxSizing: "border-box", height: "100vh", overflow: "auto", background: "#fbfcfe" }}>
      <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 700 }}>Chats</div>
        <div>
          <button
            onClick={async () => {
              if (typeof onNewConversation === "function") {
                await onNewConversation();
              } else {
                // fallback: navigate to root
                window.location.href = "/";
              }
            }}
            style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
            title="Save current chat and start a new one"
          >
            New
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Link href="/profile"><a style={{ display: "inline-block", marginRight: 8 }}>Profile</a></Link>
        <Link href="/vault"><a style={{ display: "inline-block" }}>Vault</a></Link>
        <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>Know Your Visa (Beta): <Link href="/kyv"><a>Open</a></Link></div>
      </div>

      <div style={{ marginTop: 8 }}>
        {loading && <div style={{ color: "#777", fontSize: 13 }}>Loading...</div>}
        {error && <div style={{ color: "#b33", fontSize: 13, marginBottom: 8 }}>Error: {error}</div>}
        {!loading && convos.length === 0 && <div style={{ color: "#777", fontSize: 13 }}>No saved conversations</div>}
        {!loading && convos.map((c) => (
          <div key={c.id || c.title || Math.random()} style={{ marginBottom: 8 }}>
            <button
              onClick={() => onSelectConversation && onSelectConversation(c)}
              style={{ width: "100%", textAlign: "left", padding: 8, borderRadius: 6, border: "1px solid #eee", background: "#fff", cursor: "pointer" }}
            >
              <div style={{ fontSize: 14, fontWeight: 600 }}>{c.title || (c.messages && c.messages[0]?.content?.slice(0,40)) || "Conversation"}</div>
              <div style={{ fontSize: 12, color: "#666" }}>{c.created_at ? new Date(c.created_at).toLocaleString() : ""}</div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
