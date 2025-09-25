// pages/index.js
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  // ----- state must be declared BEFORE calling useChat -----
  const [parsedSources, setParsedSources] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  // useChat hook (after state declarations)
  const { messages, input, setInput, handleInputChange, handleSubmit, append, isLoading } = useChat({
    api: '/api/chat',
    // onFinish triggers after a streamed assistant message is complete
    onFinish: (message) => {
      if (!message || message.role !== 'assistant') return;
      const text = message.content || '';

      // non-greedy, multi-line match for SOURCES_JSON preamble at the start
      const sourcesRegex = /^\s*SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/;
      const match = text.match(sourcesRegex);
      if (match && match[1]) {
        try {
          const parsed = JSON.parse(match[1]);
          // store sources keyed by message id
          setParsedSources(prev => ({ ...prev, [message.id]: parsed }));
        } catch (e) {
          console.warn('Failed to parse SOURCES_JSON for message', message.id, e);
        }
      }
    }
  });

  useEffect(() => {
    // scroll to bottom when messages update
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    // load trending topics optionally (static JSON in /public/trending.json)
    fetch('/trending.json')
      .then(r => r.json())
      .then(setTrendingTopics)
      .catch(() => {});
  }, []);

  // Helper to remove SOURCES_JSON preamble when displaying
  function stripPreamble(content) {
    if (!content) return '';
    return content.replace(/^\s*SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/, '').trim();
  }

  // Suggested prompts
  const suggestedPrompts = [
    "What are H-1B qualifications?",
    "What documents do I need for OPT travel?",
    "Explain the F-1 OPT policy."
  ];

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
        <p className="text-sm text-neutral-500">Informational Tool — Not Legal Advice</p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map(msg => {
            const cleaned = stripPreamble(msg.content || '');
            const sources = parsedSources[msg.id] || [];
            const isUser = msg.role === 'user';

            return (
              <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-xl p-3 rounded-lg shadow-sm ${isUser ? 'bg-brand-blue text-white' : 'bg-white text-neutral-900 border border-neutral-200'}`}>
                  <p className="whitespace-pre-wrap text-sm">{cleaned}</p>

                  {Array.isArray(sources) && sources.length > 0 && (
                    <div className="mt-2 border-t border-neutral-200 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Sources</p>
                      <div className="space-y-1">
                        {sources.map(s => (
                          <div key={s.id} className="text-xs text-neutral-500">
                            [{s.id}]&nbsp;
                            {s.url ? (
                              <a href={s.url} target="_blank" rel="noreferrer" className="underline hover:text-brand-blue">
                                {s.title || s.url}
                              </a>
                            ) : (
                              s.title || 'Unknown source'
                            )}
                          </div>
                        ))}
                      </div>
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
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 && trendingTopics.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-neutral-700 mb-2">Trending Topics</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {trendingTopics.map((t, i) => (
                  <div key={i} className="p-3 bg-neutral-100 rounded-md border border-neutral-200">
                    <p className="font-semibold text-sm text-neutral-900">{t.title}</p>
                    <p className="text-xs text-neutral-500">{t.blurb}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {messages.length === 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {suggestedPrompts.map((p, i) => (
                <button key={i} onClick={() => setInput(p)} className="px-3 py-1 bg-neutral-200 text-neutral-700 text-sm rounded-full hover:bg-neutral-300 transition-colors">
                  {p}
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
                className="px-4 py-2 bg-brand-blue text-white font-semibold rounded-md disabled:bg-gray-400 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-brand-blue transition-colors"
              >
                Send
              </button>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
}
