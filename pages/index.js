// pages/index.js
import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  const [parsedSources, setParsedSources] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  // Note: useChat must be called after hooks (we keep it simple)
  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading, append } = useChat({
    api: '/api/chat' // streaming endpoint (must be a pure model stream)
  });

  // Fetch trending topics on mount
  useEffect(() => {
    fetch('/trending.json')
      .then(res => res.json())
      .then(data => setTrendingTopics(data))
      .catch(() => {});
  }, []);

  // autoscroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Parse metadata (SOURCES_JSON) after message finalizes
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'assistant' || !last.content) return;

    // look for a SOURCES_JSON preamble in the assistant message content
    const sourcesRegex = /SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/;
    const match = last.content.match(sourcesRegex);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1]);
        setParsedSources(prev => ({ ...prev, [last.id]: parsed }));
      } catch (e) {
        console.warn('Failed to parse SOURCES_JSON', e);
      }
    }
  }, [messages]);

  // Strip the SOURCES preamble when displaying messages
  function stripPreamble(content = '') {
    return content.replace(/SOURCES_JSON:\s*(\[[\s\S]*?\])\s*\n\n/, '').trim();
  }

  // NEW: wrapper submit that first requests sources (fast), then triggers handleSubmit for streaming
  async function submitWrapper(e) {
    e.preventDefault();
    const userText = (input || '').trim();
    if (!userText) return;

    // 1) Optimistically append user's message so UI updates immediately
    // append will add a user message to messages array (useChat)
    append({ role: 'user', content: userText });
    setInput(''); // clear input immediately

    // 2) Request citations/sources first
    try {
      // send minimal body to chat-sources; adapt to whatever your endpoint expects
      const srcResp = await fetch('/api/chat-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: userText }] })
      });
      // We do not require the sources to proceed; but store them for later display
      if (srcResp.ok) {
        const data = await srcResp.json();
        // store under a temporary key so you can show them once assistant arrives
        // data.sources expected to be [{ id, title, url, excerpt }, ...]
        // we won't render them now; we'll attach to the assistant message when it arrives
        // Save under a "pending" key (use timestamp)
        const pendingKey = `pending-${Date.now()}`;
        setParsedSources(prev => ({ ...prev, [pendingKey]: data.sources }));
        // Optionally pass this pendingKey to your chat endpoint via hidden field or cookie (not required)
      } else {
        console.warn('chat-sources returned non-200', await srcResp.text());
      }
    } catch (err) {
      console.warn('chat-sources fetch failed', err);
    }

    // 3) Trigger streaming LLM call using useChat's handler (this posts to /api/chat and streams)
    // Important: let useChat do its normal streaming flow so the frontend receives partial tokens
    // Call handleSubmit with a synthetic event so useChat behaves normally
    // Since we've already appended the user message, pass empty input so useChat won't duplicate it
    // Some versions of useChat rely on the form event to gather the input; the easiest is to call handleSubmit directly:
    // Create a fake event object with preventDefault to satisfy handleSubmit signature
    const fakeEvent = { preventDefault() {} };
    // For safety, wait a tick so UI has appended the user message
    setTimeout(() => {
      handleSubmit(fakeEvent);
    }, 50);
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-50 font-sans">
      <header className="p-4 border-b bg-white shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">Immigration AI Assistant</h1>
        <p className="text-sm text-neutral-500">Informational Tool - Not Legal Advice</p>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map(msg => {
            const cleaned = stripPreamble(msg.content || '');
            const sources = parsedSources[msg.id] || null;
            return (
              <div key={msg.id} className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-xl p-3 rounded-lg shadow-sm ' + (msg.role === 'user' ? 'bg-brand-blue text-white' : 'bg-white text-neutral-900 border border-neutral-200')}>
                  <p className="whitespace-pre-wrap text-sm">{cleaned}</p>

                  {sources && sources.length > 0 && (
                    <div className="mt-2 border-t border-neutral-200 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Sources:</p>
                      <div className="space-y-1">
                        {sources.map(s => (
                          <div key={s.id} className="text-xs text-neutral-500">
                            [{s.id}] {' '}
                            {s.url ? (
                              <a href={s.url} target="_blank" rel="noreferrer" className="underline hover:text-brand-blue">{s.title || s.url}</a>
                            ) : (
                              s.title || s.url || 'Untitled Source'
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
                {trendingTopics.map((topic, index) => (
                  <div key={index} className="p-3 bg-neutral-100 rounded-md border border-neutral-200">
                    <p className="font-semibold text-sm text-neutral-900">{topic.title}</p>
                    <p className="text-xs text-neutral-500">{topic.blurb}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={submitWrapper}>
            <div className="flex space-x-2">
              <input
                value={input}
                onChange={handleInputChange}
                placeholder="Ask a question about U.S. immigration..."
                className="flex-1 p-2 border border-neutral-200 rounded-md focus:ring-2 focus:ring-brand-blue focus:outline-none"
                disabled={isLoading}
              />
              <button type="submit" disabled={isLoading} className="px-4 py-2 bg-brand-blue text-white font-semibold rounded-md disabled:bg-gray-400 hover:bg-blue-600">
                Send
              </button>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
}
