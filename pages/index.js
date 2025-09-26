// pages/index.js — JSON UI (no streaming)
import { useState, useRef, useEffect } from 'react';

export default function ChatPage() {
  const [messages, setMessages] = useState([]); // { role, content, sources? }
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSubmit(e) {
    e?.preventDefault();
    const text = (input || '').trim();
    if (!text) return;

    const userMsg = { role: 'user', content: text };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Status ${resp.status}`);
      }

      const data = await resp.json(); // { answer, sources }
      // Debug line — confirm shape when needed
      // console.log('API JSON:', data);

      const assistant = {
        role: 'assistant',
        content: data.answer || 'No answer',
        sources: Array.isArray(data.sources) ? data.sources : [],
      };
      setMessages((m) => [...m, assistant]);
    } catch (e) {
      console.error('chat error:', e);
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: 'Sorry — something went wrong.' },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function renderSources(sources = []) {
    if (!sources || sources.length === 0) return null;
    return (
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee', background: '#f7fbff' }}>
        <div style={{ fontSize: 12, color: '#556', marginBottom: 6, fontWeight: 600 }}>Sources</div>
        <div>
          {sources.map((s) => (
            <div key={s.id} style={{ fontSize: 13, color: '#1558d6', marginBottom: 4 }}>
              [{s.id}] {' '}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer"
                   style={{ color: '#1558d6', textDecoration: 'underline' }}>
                  {s.title || s.url}
                </a>
              ) : (
                <span style={{ color: '#333' }}>{s.title || 'Untitled Source'}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{ padding: 16, borderBottom: '1px solid #eee', background: '#fff' }}>
        <h2 style={{ margin: 0 }}>Immigration AI Assistant</h2>
        <div style={{ color: '#666', fontSize: 13 }}>Informational only — not legal advice</div>
      </header>

      <main style={{ flex: 1, overflow: 'auto', padding: 20, background: '#fafafa' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          {messages.map((m, idx) => (
            <div key={idx}
                 style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
              <div style={{
                maxWidth: '75%',
                padding: 12,
                borderRadius: 10,
                background: m.role === 'user' ? '#0b63d8' : '#fff',
                color: m.role === 'user' ? '#fff' : '#111',
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                border: m.role === 'assistant' ? '1px solid #eee' : 'none'
              }}>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{m.content}</div>
                {m.role === 'assistant' && renderSources(m.sources)}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </main>

      <footer style={{ padding: 16, borderTop: '1px solid #eee', background: '#fff' }}>
        <form onSubmit={handleSubmit} style={{ maxWidth: 900, margin: '0 auto', display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about U.S. immigration..."
            style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd' }}
            disabled={loading}
          />
          <button type="submit" disabled={loading}
                  style={{ padding: '10px 14px', borderRadius: 8, background: '#0b63d8', color: '#fff', border: 'none' }}>
            {loading ? 'Thinking…' : 'Send'}
          </button>
        </form>
      </footer>
    </div>
  );
}
