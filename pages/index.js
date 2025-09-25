// index.js — Stable Frontend with Citations
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  const [parsedSources, setParsedSources] = useState({});
  const messagesEndRef = useRef(null);

  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
    onFinish: (msg) => {
      const match = msg.content.match(/^SOURCES_JSON:(\[[\s\S]*?\])\s*\n\n/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          setParsedSources(prev => ({ ...prev, [msg.id]: parsed }));
        } catch (e) {
          console.warn("Failed to parse sources", e);
        }
      }
    }
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function stripMeta(text) {
    return text.replace(/^SOURCES_JSON:(\[[\s\S]*?\])\s*\n\n/, '').trim();
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
        <p className="text-sm text-neutral-500">Not Legal Advice</p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map(msg => {
            const content = stripMeta(msg.content);
            const sources = parsedSources[msg.id] || [];
            return (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-xl p-3 rounded-lg shadow-sm ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white text-neutral-900 border'}`}>
                  <p className="whitespace-pre-wrap text-sm">{content}</p>

                  {sources.length > 0 && (
                    <div className="mt-2 border-t pt-2">
                      <p className="text-xs font-semibold text-neutral-600">Sources:</p>
                      {sources.map(s => (
                        <div key={s.id} className="text-xs text-neutral-500">
                          [{s.id}] {s.url ? (
                            <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-600">
                              {s.title}
                            </a>
                          ) : s.title}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="p-4 border-t bg-white">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex space-x-2">
          <input
            value={input}
            onChange={handleInputChange}
            placeholder="Ask about U.S. immigration..."
            className="flex-1 p-2 border rounded-md"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading}
            className="px-4 py-2 bg-blue-600 text-white rounded-md"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
