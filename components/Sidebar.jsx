// components/Sidebar.jsx
import { useEffect, useState } from "react";
import Link from "next/link";

export default function Sidebar({ onSelectConversation }) {
  const [convos, setConvos] = useState([]);

  useEffect(() => {
    fetch("/api/conversations/list")
      .then((r) => r.json())
      .then((d) => setConvos(d.conversations || []))
      .catch(console.error);
  }, []);

  return (
    <div style={{ width: 280, borderRight: "1px solid #eee", padding: 12, boxSizing: "border-box", height: "100vh", overflow: "auto" }}>
      <div style={{ marginBottom: 12 }}>
        <Link href="/"><a style={{ fontWeight: 700 }}>New Chat</a></Link>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Link href="/profile"><a>Profile</a></Link> · <Link href="/vault"><a>Vault</a></Link> · <Link href="/kyv"><a>Know Your Visa</a></Link>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>Conversations</div>
        {convos.length === 0 && <div style={{ color: "#777" }}>No saved conversations</div>}
        {convos.map((c) => (
          <div key={c.id} style={{ marginBottom: 8 }}>
            <button
              onClick={() => onSelectConversation(c)}
              style={{ width: "100%", textAlign: "left", padding: 8, borderRadius: 6, border: "1px solid #eee", background: "#fff" }}
            >
              <div style={{ fontSize: 14, fontWeight: 600 }}>{c.title || "Chat"}</div>
              <div style={{ fontSize: 12, color: "#666" }}>{new Date(c.created_at).toLocaleString()}</div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
