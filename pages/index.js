// pages/index.js — Frontend chat UI (full file)
// - Parses SOURCES_JSON in onFinish
// - Strips metadata for visible output
// - Renders sources as blue underlined links inside a shaded box
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  const [parsedSources, setParsedSources] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
    onFinish: (message) => {
      // parse SOURCES_JSON exactly once after stream completes
      const text = message.content || '';
      const sourcesRegex = /SOURCES_JSON:\s*(\[[\s\S]*?\])\s*$/m;
      const match = text.match(sourcesRegex);
      if (match && match[1]) {
        try {
          const parsed = JSON.parse(match[1]);
          setParsedSources(prev => ({ ...prev, [message.id]: parsed }));
        } catch (e) {
          console.warn('Failed to parse SOURCES_JSON', e);
        }
      }
    }
  });

  // Trending / sample prompts
  useEffect(() => {
    fetch('/trending.json')
      .then(res => res.json())
      .then(data => setTrendingTopics(data))
      .catch(() => {});
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Remove metadata blocks (SOURCES_JSON or SUGGESTED) from visible content
  function stripMetadata(content) {
    if (!content) return '';
    return content
      .replace(/SOURCES_JSON:\s*(\[[\s\S]*?\])\s*$/m, '')
      .replace(/SUGGESTED:\s*(\[[\s\S]*?\])\s*$/m, '')
      .trim();
  }

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
          {messages.map((msg) => {
            const cleaned = stripMetadata(msg.content);
            const sources = parsedSources[msg.id] || [];

            return (
              <div key={msg.id} className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-xl p-4 rounded-lg shadow-sm ' + (msg.role === 'user' ? 'bg-brand-blue text-white' : 'bg-white text-neutral-900 border border-neutral-200')}>
                  <div className="whitespace-pre-wrap text-sm" dangerouslySetInnerHTML={{ __html: formatMarkdownSafe(cleaned) }} />

                  {/* Sources box: subtle shade, small text, blue underlined links */}
                  {sources.length > 0 && (
                    <div className="mt-3 p-3 rounded-md bg-neutral-50 border border-neutral-100">
                      <p className="text-xs font-semibold text-neutral-600 mb-2">Sources</p>
                      <div className="space-y-1">
                        {sources.map(src => (
                          <div key={src.id} className="text-xs text-neutral-600">
                            [{src.id}] {' '}
                            {src.url ? (
                              <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                                {src.title || src.url}
                              </a>
                            ) : (
                              <span className="text-neutral-700">{src.title}</span>
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
              {suggestedPrompts.map((p, idx) => (
                <button key={idx} onClick={() => setInput(p)} className="px-3 py-1 bg-neutral-200 text-neutral-700 text-sm rounded-full hover:bg-neutral-300">
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
              <button type="submit" disabled={isLoading} className="px-4 py-2 bg-brand-blue text-white font-semibold rounded-md disabled:bg-gray-400">
                Send
              </button>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
}

/**
 * Minimal, safe markdown-ish formatter for display:
 * - Converts simple **bold** and bullet lines into HTML
 * - Keeps text safe (very lightweight). If you use a markdown library, swap here.
 */
function formatMarkdownSafe(text) {
  if (!text) return '';
  // escape HTML characters
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  // basic transformations
  const lines = esc(text).split('\n');
  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith('- ')) {
      out.push(`<li>${line.trim().slice(2)}</li>`);
    } else {
      // bold **text**
      const bolded = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      out.push(`<p>${bolded}</p>`);
    }
  }
  // wrap consecutive <li> into a <ul>
  const html = out.join('');
  // quick combine adjacent <li> into UL groups
  return html.replace(/(<li>.*?<\/li>)+/gs, (m) => `<ul class="ml-4 list-disc">${m}</ul>`);
}
