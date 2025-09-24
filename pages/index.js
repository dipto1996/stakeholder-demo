import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  const [parsedSources, setParsedSources] = useState({});
  const [parsedSuggested, setParsedSuggested] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  // useChat must be called after state hooks are declared
  const { messages, input, setInput, handleInputChange, handleSubmit, append, isLoading } = useChat({
    api: '/api/chat',
  });

  // Fetch trending topics on component mount
  useEffect(() => {
    fetch('/trending.json')
      .then(res => res.json())
      .then(data => setTrendingTopics(data))
      .catch(err => console.error("Failed to fetch trending topics:", err));
  }, []);

  // Auto-scroll to the latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Robustly parse sources & suggested prompts whenever messages change
  useEffect(() => {
    if (!messages || messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'assistant') return;

    const text = lastMessage.content || '';
    const sourcesRegex = /SOURCES_JSON:\s*(\[[\s\S]*?\])\s*$/m;
    const suggestedRegex = /SUGGESTED:\s*(\[[\s\S]*?\])\s*$/m;

    const sourcesMatch = text.match(sourcesRegex);
    if (sourcesMatch && sourcesMatch[1]) {
      try {
        const parsed = JSON.parse(sourcesMatch[1]);
        setParsedSources(prev => ({ ...prev, [lastMessage.id]: parsed }));
      } catch (e) {
        console.warn('Failed to parse SOURCES_JSON for message', lastMessage.id, e);
      }
    }

    const suggestedMatch = text.match(suggestedRegex);
    if (suggestedMatch && suggestedMatch[1]) {
        try {
            const parsed = JSON.parse(suggestedMatch[1]);
            setParsedSuggested(prev => ({ ...prev, [lastMessage.id]: parsed }));
        } catch(e) {
            console.warn('Failed to parse SUGGESTED for message', lastMessage.id, e);
        }
    }
  }, [messages]);

  // Helper to safely remove metadata from displayed content
  function stripMetadata(content) {
    if (!content) return '';
    return content
      .replace(/SUGGESTED:\s*(\[[\s\S]*?\])\s*$/m, '')
      .replace(/SOURCES_JSON:\s*(\[[\s\S]*?\])\s*$/m, '')
      .trim();
  }

  // Click a suggested prompt and auto-submit
  function handleSuggestedClick(prompt) {
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
            const cleanedContent = stripMetadata(msg.content);
            const sources = parsedSources[msg.id];
            const suggested = parsedSuggested[msg.id];

            return (
              <div key={msg.id} className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-xl p-3 rounded-lg shadow-sm ' + (msg.role === 'user' ? 'bg-brand-blue text-white' : 'bg-white text-neutral-900 border border-neutral-200')}>
                  <p className="whitespace-pre-wrap text-sm">{cleanedContent}</p>

                  {sources && sources.length > 0 && (
                    <div className="mt-2 border-t border-neutral-200 pt-2">
                      <p className="text-xs font-semibold text-neutral-600 mb-1">Sources:</p>
                      <div className="space-y-1">
                        {sources.map(source => (
                          <div key={source.id} className="text-xs text-neutral-500">
                            [{source.id}] {source.source}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {suggested && Array.isArray(suggested) && (
                    <div className="mt-2 pt-2">
                       <p className="text-xs font-semibold text-neutral-600 mb-1">Suggested Follow-ups:</p>
                      <div className="flex flex-wrap gap-2">
                        {suggested.map((p, idx) => (
                          <button key={idx} onClick={() => handleSuggestedClick(p)} className="px-3 py-1 bg-neutral-200 text-neutral-700 text-sm rounded-full hover:bg-neutral-300 transition-colors">
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
                {trendingTopics.map((topic, index) => (
                  <div key={index} className="p-3 bg-neutral-100 rounded-md border border-neutral-200">
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
                Send
              </button>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
}

