// pages/index.js
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  // store parsed metadata keyed by assistant message id
  const [parsedSources, setParsedSources] = useState({});
  const [parsedSuggested, setParsedSuggested] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  // useChat must be declared after hooks
  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading, append } = useChat({
    api: '/api/chat',
    // onFinish fires after streaming completes and message is persisted
    onFinish: (message) => {
      if (!message || !message.content) return;
      // non-greedy JSON capture for SOURCES_JSON at start
      const sourcesRegex = /^SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/;
      const suggestedRegex = /SUGGESTED:\s*(\[[\s\S]*?\])\s*$/m;

      const sMatch = message.content.match(sourcesRegex);
      if (sMatch && sMatch[1]) {
        try {
          const parsed = JSON.parse(sMatch[1]);
          setParsedSources(prev => ({ ...prev, [message.id]: parsed }));
        } catch (e) {
          console.warn('Failed to parse SOURCES_JSON', e);
        }
      }

      const sugMatch = message.content.match(suggestedRegex);
      if (sugMatch && sugMatch[1]) {
        try {
          const parsed = JSON.parse(sugMatch[1]);
          setParsedSuggested(prev => ({ ...prev, [message.id]: parsed }));
        } catch (e) {
          console.warn('Failed to parse SUGGESTED', e);
        }
      }
    }
  });

  useEffect(() => {
    fetch('/trending.json')
      .then(r => r.json())
      .then(data => setTrendingTopics(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // remove SOURCES_JSON preamble and SUGGESTED line for display
  function stripMetadata(content = '') {
    if (!content) return '';
    // strip preamble at start
    content = content.replace(/^SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/, '');
    // strip trailing suggested JSON line
    content = content.replace(/\n?SUGGESTED:\s*(\[[\s\S]*?\])\s*$/m, '');
    return content.trim();
  }

  function handleSuggestedClick(prompt) {
    // append the user message and submit quickly
    append({ role: 'user', content: prompt });
  }

  const defaultSuggestedPrompts = [
    "What are H-1B qualifications?",
    "What documents do I need for OPT travel?",
    "Explain the F-1 OPT policy.",
  ];

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
        <p className="text-sm text-neutral-500">Informational Tool - Not Legal Advice</p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((msg) => {
            const sources = parsedSources[msg.id];
            const suggested = parsedSuggested[msg.id];
            const cleaned = stripMetadata(msg.content);

            return (
              <div key={msg.id} className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-xl p-3 rounded-lg shadow-sm ' + (msg.role === 'user' ? 'bg-brand-blue text-white' : 'bg-white text-neutral-900 border border-neutral-200')}>
                  <p className="whitespace-pre-wrap text-sm">{cleaned}</p>

                  {sources && sources.length > 0 && (
                    <div className="mt-2 border-t border-neutral-200 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Sources</p>
                      <div className="space-y-1">
                        {sources.map(source => (
                          <div key={source.id} className="text-xs text-neutral-500">
                            [{source.id}] {' '}
                            {source.url ? (
                              <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-brand-blue">
                                {source.title || source.url}
                              </a>
                            ) : (
                              <span>{source.title || 'Untitled Source'}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {suggested && Array.isArray(suggested) && suggested.length > 0 && (
                    <div className="mt-2 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Suggested Follow-ups</p>
                      <div className="flex flex-wrap gap-2">
                        {suggested.map((s, i) => (
                          <button key={i} onClick={() => handleSuggestedClick(s)} className="px-3 py-1 bg-neutral-200 text-neutral-700 text-sm rounded-full hover:bg-neutral-300 transition-colors">
                            {s}
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
                {trendingTopics.map((topic, idx) => (
                  <div key={idx} className="p-3 bg-neutral-100 rounded-md border border-neutral-200">
                    <p className="font-semibold text-sm text-neutral-900">{topic.title}</p>
                    <p className="text-xs text-neutral-500">{topic.blurb}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {messages.length === 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {defaultSuggestedPrompts.map((prompt, index) => (
                <button key={index} onClick={() => setInput(prompt)} className="px-3 py-1 bg-neutral-200 text-neutral-700 text-sm rounded-full hover:bg-neutral-300 transition-colors">
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
                className="flex-1 p-2 border border-neutral-200 rounded-md focus:ring-2 focus:ring-brand-blue focus:outline-none"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading}
                className="px-4 py-2 bg-brand-blue text-white font-semibold rounded-md disabled:bg-gray-400 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-brand-blue transition-colors"
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
