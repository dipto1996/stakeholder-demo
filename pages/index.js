// pages/index.js — Client-only + robust rendering + sources block
import dynamic from 'next/dynamic';
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import AuthButtons from '../components/AuthButtons';

function ChatPageInner() {
  const { data: session, status } = useSession();
  const [parsedSources, setParsedSources] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  // useChat for streaming chat UI
  const {
    messages = [],
    input = '',
    setInput,
    handleInputChange = () => {},
    handleSubmit = () => {},
    isLoading = false,
  } = useChat({
    api: '/api/chat',
    onFinish: (message) => {
      // Parse SOURCES_JSON from the model text (your current working format)
      try {
        const text = message?.content ?? '';
        const m = text.match(/SOURCES_JSON:\s*(\[[\s\S]*?\])\s*$/m);
        if (m && m[1]) {
          const sources = JSON.parse(m[1]);
          setParsedSources((prev) => ({ ...prev, [message.id]: sources }));
        }
      } catch (e) {
        console.warn('SOURCES_JSON parse failed:', e);
      }
    },
  });

  // Fetch trending topics (non-blocking)
  useEffect(() => {
    let alive = true;
    fetch('/trending.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (alive) setTrendingTopics(Array.isArray(data) ? data : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Remove metadata tail from display
  const stripMetadata = (content) =>
    (content || '').replace(/SOURCES_JSON:\s*(\[[\s\S]*?\])\s*$/m, '').trim();

  // Loading session (don’t blank screen)
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center h-screen text-neutral-600">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
            <p className="text-sm text-neutral-500">Informational Tool — Not Legal Advice</p>
          </div>
          <AuthButtons />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {/* If not signed in, still allow chat, just no history — your preference */}
          {messages.map((msg) => {
            const cleaned = stripMetadata(msg.content);
            const sources = parsedSources[msg.id];

            return (
              <div
                key={msg.id}
                className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={
                    'max-w-xl p-3 rounded-lg shadow-sm ' +
                    (msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-neutral-900 border border-neutral-200')
                  }
                >
                  <div className="prose prose-sm max-w-none">
                    <p className="whitespace-pre-wrap">{cleaned}</p>
                  </div>

                  {/* Sources block */}
                  {sources && Array.isArray(sources) && sources.length > 0 && (
                    <div className="mt-3 rounded-md border border-blue-100 bg-blue-50 p-2">
                      <p className="text-xs font-semibold text-blue-800 mb-1">Sources</p>
                      <ul className="space-y-1">
                        {sources.map((s) => (
                          <li key={s.id} className="text-xs text-blue-700">
                            <span className="font-mono">[{s.id}] </span>
                            {s.url ? (
                              <a
                                className="underline"
                                href={s.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {s.title || 'Source'}
                              </a>
                            ) : (
                              <span>{s.title || 'Source'}</span>
                            )}
                          </li>
                        ))}
                      </ul>
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
          {messages.length === 0 && (
            <>
              {trendingTopics.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-neutral-700 mb-2">Trending Topics</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {trendingTopics.map((t, i) => (
                      <div
                        key={i}
                        className="p-3 bg-neutral-100 rounded-md border border-neutral-200"
                      >
                        <p className="font-semibold text-sm text-neutral-900">{t.title}</p>
                        <p className="text-xs text-neutral-500">{t.blurb}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <form
            onSubmit={(e) => {
              try {
                handleSubmit(e);
              } catch (err) {
                console.error('submit error', err);
              }
            }}
          >
            <div className="flex space-x-2">
              <input
                value={input}
                onChange={handleInputChange}
                placeholder="Ask a question about U.S. immigration…"
                className="flex-1 p-2 border border-neutral-200 rounded-md focus:ring-2 focus:ring-blue-600 focus:outline-none"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading}
                className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-md disabled:bg-gray-400 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600 transition-colors"
              >
                {isLoading ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
}

// IMPORTANT: disable SSR to avoid hydration/Edge mismatches after auth integration
const ChatPage = dynamic(() => Promise.resolve(ChatPageInner), { ssr: false });
export default ChatPage;
