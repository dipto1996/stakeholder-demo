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
      if (!r.ok) throw new Error(`List failed (${r.status})`);
      const d = await r.json();
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
    // reload on refreshKey change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return (
    <div
      style={{
        width: 260,
        borderRight: "1px solid #eee",
        padding: 12,
        boxSizing: "border-box",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#fbfcfe",
      }}
    >
      {/* Top header: Chats + New */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Chats</div>
        <div>
          <button
            onClick={async () => {
              if (typeof onNewConversation === "function") {
                await onNewConversation();
              } else {
                window.location.href = "/";
              }
            }}
            style={{
              fontSize: 12,
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: "pointer",
            }}
            title="Save current chat and start a new one"
          >
            New
          </button>
        </div>
      </div>

      {/* Chat history list (immediately below header) */}
      <div style={{ flex: 1, overflow: "auto", paddingRight: 6 }}>
        {loading && <div style={{ color: "#777", fontSize: 13 }}>Loading...</div>}
        {error && <div style={{ color: "#b33", fontSize: 13, marginBottom: 8 }}>Error: {error}</div>}
        {!loading && convos.length === 0 && <div style={{ color: "#777", fontSize: 13 }}>No saved conversations</div>}
        {!loading &&
          convos.map((c) => (
            <div key={c.id || c.title || Math.random()} style={{ marginBottom: 8 }}>
              <button
                onClick={() => onSelectConversation && onSelectConversation(c)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #eee",
                  background: "#fff",
                  cursor: "pointer",
                  boxShadow: "0 1px 0 rgba(0,0,0,0.02)",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: "#111" }}>
                  {c.title || (c.messages && c.messages[0]?.content?.slice(0, 40)) || "Conversation"}
                </div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 6 }}>
                  {c.created_at ? new Date(c.created_at).toLocaleString() : ""}
                </div>
              </button>
            </div>
          ))}
      </div>

      {/* Bottom action group anchored to bottom */}
      <div style={{ marginTop: 12, borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <Link href="/vault">
            <a style={{ display: "inline-block", color: "#1558d6", textDecoration: "none", fontWeight: 600 }}>Vault</a>
          </Link>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Know Your Visa (Beta)</div>
          <Link href="/kyv">
            <a style={{ display: "inline-block", padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", textDecoration: "none", cursor: "pointer" }}>
              Open
            </a>
          </Link>
        </div>

        {/* Profile link anchored at bottom */}
        <div style={{ marginTop: 18, paddingTop: 12, borderTop: "1px solid #f7f7f7" }}>
          <Link href="/profile">
            <a style={{ display: "inline-block", color: "#333", textDecoration: "none", fontWeight: 600 }}>Profile</a>
          </Link>
        </div>
      </div>
    </div>
  );
}
