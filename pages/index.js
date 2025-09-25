// pages/index.js
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  // IMPORTANT: `data` is the per-message metadata array from useChat (keeps sync with messages)
  // Make sure your ai/react version supports returning `data` for messages.
  const {
    messages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    data, // <-- metadata array aligned with messages
  } = useChat({
    api: '/api/chat',
  });

  useEffect(() => {
    fetch('/trending.json')
      .then(res => res.json())
      .then(d => setTrendingTopics(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function renderSourcesForIndex(idx) {
    // data is aligned with messages; each entry may be undefined or contain { sources: [...] }
    const meta = data?.[idx];
    const sources = meta?.sources ?? [];
    if (!sources || sources.length === 0) return null;

    return (
      <div className="mt-2 border-t border-neutral-200 pt-2 bg-neutral-50 px-2 py-1 rounded">
        <p className="text-xs font-semibold text-neutral-600 mb-1">Sources</p>
        <div className="space-y-1">
          {sources.map(src => (
            <div key={src.id} className="text-xs text-neutral-700">
              [{src.id}] {' '}
              {src.url ? (
                <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                  {src.title}
                </a>
              ) : (
                <span className="text-neutral-700">{src.title}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const suggestedPrompts = [
    "What are H-1B qualifications?",
    "Explain OPT travel rules.",
    "How do I apply for a green card?"
  ];

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
        <p className="text-sm text-neutral-500">Informational Tool - Not Legal Advice</p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((msg, i) => (
            <div key={msg.id} className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={'max-w-xl p-3 rounded-lg shadow-sm ' + (msg.role === 'user' ? 'bg-brand-blue text-white' : 'bg-white text-neutral-900 border border-neutral-200')}>
                <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                {renderSourcesForIndex(i)}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="p-4 border-t bg-white">
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 && (
            <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-2">
              {suggestedPrompts.map((s, idx) => (
                <button key={idx} onClick={() => setInput(s)} className="px-3 py-2 bg-neutral-100 rounded-md text-sm">
                  {s}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="flex space-x-2">
              <input
                value={input}
                onChange={handleInputChange}
                placeholder="Ask a question about U.S. immigration..."
                className="flex-1 p-2 border border-neutral-200 rounded-md focus:ring-2 focus:ring-brand-blue focus:outline-none"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading}
                className="px-4 py-2 bg-brand-blue text-white font-semibold rounded-md disabled:bg-gray-400 hover:bg-blue-600"
              >
                {isLoading ? 'Thinking…' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
}
