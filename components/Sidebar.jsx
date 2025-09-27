// components/Sidebar.jsx
import { useEffect, useState } from "react";
import Link from "next/link";

export default function Sidebar({ onSelectConversation }) {
  const [convos, setConvos] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch("/api/conversations/list");
        const d = await r.json();
        // Expecting { conversations: [...] } or similar; if different, pass through
        setConvos(d.conversations || d || []);
      } catch (err) {
        console.error("Sidebar: could not load conversations", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div style={{ width: 260, borderRight: "1px solid #eee", padding: 12, boxSizing: "border-box", height: "100vh", overflow: "auto", background: "#fbfcfe" }}>
      <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 700 }}>Chats</div>
        <Link href="/"><a style={{ fontSize: 12 }}>New</a></Link>
      </div>

      <div style={{ marginBottom: 12 }}>
        <Link href="/profile"><a style={{ marginRight: 8 }}>Profile</a></Link>
        <Link href="/vault"><a style={{ marginLeft: 8 }}>Vault</a></Link>
        <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>Know Your Visa (Beta): <Link href="/kyv"><a>Open</a></Link></div>
      </div>

      <div style={{ marginTop: 8 }}>
        {loading && <div style={{ color: "#777", fontSize: 13 }}>Loading...</div>}
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
