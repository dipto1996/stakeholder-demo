// pages/index.js — simple client chat that calls /api/chat (JSON)
import { useState, useRef, useEffect } from 'react';

export default function ChatPage() {
  const [messages, setMessages] = useState([]); // { id, role, content, sources? }
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage(e) {
    if (e) e.preventDefault();
    const trimmed = (input || '').trim();
    if (!trimmed) return;
    const userMsg = { id: Date.now() + '_u', role: 'user', content: trimmed };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: trimmed }] })
      });
      const data = await resp.json();
      if (!resp.ok) {
        const errText = data?.error || data?.message || 'Server error';
        setMessages(prev => [...prev, { id: Date.now() + '_err', role: 'assistant', content: `Error: ${errText}` }]);
      } else {
        const assistantMsg = { id: Date.now() + '_a', role: 'assistant', content: data.answer || '', sources: data.sources || [] };
        setMessages(prev => [...prev, assistantMsg]);
      }
    } catch (err) {
      console.error('Fetch error:', err);
      setMessages(prev => [...prev, { id: Date.now() + '_err2', role: 'assistant', content: 'Network error. Try again.' }]);
    } finally {
      setIsLoading(false);
    }
  }

  function renderMessage(m) {
    return (
      <div key={m.id} className={'flex ' + (m.role === 'user' ? 'justify-end' : 'justify-start')}>
        <div className={'max-w-xl p-3 rounded-lg shadow-sm ' + (m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white text-neutral-900 border border-neutral-200')}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
          {m.sources && m.sources.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eee', backgroundColor: '#f9fafb' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>Sources</div>
              <div>
                {m.sources.map(s => (
                  <div key={s.id} style={{ fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
                    [{s.id}] {' '}
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }}>
                        {s.title || s.url}
                      </a>
                    ) : (
                      <span>{s.title}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto' }}>
      <header style={{ padding: 16, borderBottom: '1px solid #eee', background: '#fff' }}>
        <h1 style={{ margin: 0 }}>Immigration AI Assistant</h1>
        <div style={{ fontSize: 12, color: '#6b7280' }}>Informational — not legal advice</div>
      </header>

      <main style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 800, margin: '0 auto' }}>
          {messages.map(renderMessage)}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer style={{ padding: 16, borderTop: '1px solid #eee', background: '#fff' }}>
        <form onSubmit={sendMessage} style={{ maxWidth: 800, margin: '0 auto', display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask a question about U.S. immigration..."
            disabled={isLoading}
            style={{ flex: 1, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8 }}
          />
          <button type="submit" disabled={isLoading} style={{ padding: '10px 16px', background: isLoading ? '#9ca3af' : '#2563eb', color: '#fff', borderRadius: 8, border: 'none' }}>
            {isLoading ? 'Thinking...' : 'Send'}
          </button>
        </form>
      </footer>
    </div>
  );
}
