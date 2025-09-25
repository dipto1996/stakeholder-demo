// index.js — Full-featured Chat UI with sources, suggestions, trending topics
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  const [parsedSources, setParsedSources] = useState({});
  const [parsedSuggested, setParsedSuggested] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  const { messages, input, setInput, handleInputChange, handleSubmit, append, isLoading } = useChat({
    api: '/api/chat',
    onFinish: (message) => {
      const text = message.content || '';
      // Sources
      const sourcesRegex = /^SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/;
      const sourcesMatch = text.match(sourcesRegex);
      if (sourcesMatch && sourcesMatch[1]) {
        try {
          const parsed = JSON.parse(sourcesMatch[1]);
          setParsedSources(prev => ({ ...prev, [message.id]: parsed }));
        } catch (e) {
          console.warn('Failed to parse SOURCES_JSON:', e);
        }
      }
      // Suggested
      const suggestedRegex = /SUGGESTED:\s*(\[[\s\S]*?\])$/m;
      const suggestedMatch = text.match(suggestedRegex);
      if (suggestedMatch && suggestedMatch[1]) {
        try {
          const parsed = JSON.parse(suggestedMatch[1]);
          setParsedSuggested(prev => ({ ...prev, [message.id]: parsed }));
        } catch (e) {
          console.warn('Failed to parse SUGGESTED:', e);
        }
      }
    }
  });

  // Fetch trending
  useEffect(() => {
    fetch('/trending.json')
      .then(res => res.json())
      .then(data => setTrendingTopics(data))
      .catch(() => {});
  }, []);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Strip metadata
  function stripMetadata(content) {
    return (content || '')
      .replace(/^SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/, '')
      .replace(/SUGGESTED:\s*(\[[\s\S]*?\])$/m, '')
      .trim();
  }

  // Handle suggested click
  function handleSuggestedClick(prompt) {
    append({ role: 'user', content: prompt });
  }

  const defaultSuggested = [
    "What are H-1B qualifications?",
    "What documents do I need for OPT travel?",
    "Explain F-1 OPT policy."
  ];

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
        <p className="text-sm text-neutral-500">Informational Tool — Not Legal Advice</p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((msg) => {
            const cleaned = stripMetadata(msg.content);
            const sources = parsedSources[msg.id];
            const suggested = parsedSuggested[msg.id];

            return (
              <div key={msg.id} className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-xl p-3 rounded-lg shadow-sm ' + (msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-neutral-900 border border-neutral-200')}>
                  
                  <p className="whitespace-pre-wrap text-sm">{cleaned}</p>

                  {sources && sources.length > 0 && (
                    <div className="mt-2 border-t border-neutral-200 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Sources:</p>
                      <div className="space-y-1">
                        {sources.map(s => (
                          <div key={s.id} className="text-xs text-neutral-500">
                            [{s.id}] {' '}
                            {s.url ? (
                              <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-600">
                                {s.title}
                              </a>
                            ) : (
                              s.title
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {suggested && Array.isArray(suggested) && suggested.length > 0 && (
                    <div className="mt-2 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Suggested Follow-ups:</p>
                      <div className="flex flex-wrap gap-2">
                        {suggested.map((p, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleSuggestedClick(p)}
                            className="px-3 py-1 bg-neutral-200 text-neutral-700 text-xs rounded-full hover:bg-neutral-300 transition-colors"
                          >
                            {p}
                          </button>
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
                {trendingTopics.map((topic, i) => (
                  <div key={i} className="p-3 bg-neutral-100 rounded-md border border-neutral-200">
                    <p className="font-semibold text-sm text-neutral-900">{topic.title}</p>
                    <p className="text-xs text-neutral-500">{topic.blurb}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {messages.length === 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {defaultSuggested.map((prompt, i) => (
                <button key={i} onClick={() => setInput(prompt)} className="px-3 py-1 bg-neutral-200 text-neutral-700 text-sm rounded-full hover:bg-neutral-300 transition-colors">
                  {prompt}
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
                className="flex-1 p-2 border border-neutral-200 rounded-md focus:ring-2 focus:ring-blue-600 focus:outline-none"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading}
                className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-md disabled:bg-gray-400 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors"
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
