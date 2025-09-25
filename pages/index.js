import { useChat } from 'ai/react';
import { useRef, useEffect, useState } from 'react';

export default function ChatPage() {
  const [parsedSources, setParsedSources] = useState({});
  const [trendingTopics, setTrendingTopics] = useState([]);
  const messagesEndRef = useRef(null);

  const { messages, input, setInput, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
    // CORRECTED: Use onFinish to reliably parse metadata after the stream is complete
    onFinish: (message) => {
      const text = message.content || '';
      const sourcesRegex = /SOURCES_JSON:\s*(\[[\s\S]*?\])/;
      const sourcesMatch = text.match(sourcesRegex);
      if (sourcesMatch && sourcesMatch[1]) {
        try {
          const parsed = JSON.parse(sourcesMatch[1]);
          setParsedSources(prev => ({ ...prev, [message.id]: parsed }));
        } catch (e) {
          console.warn('Failed to parse SOURCES_JSON for message', message.id, e);
        }
      }
    }
  });

  useEffect(() => {
    fetch('/trending.json')
      .then(res => res.json())
      .then(data => setTrendingTopics(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function stripMetadata(content) {
    if (!content) return '';
    return content.replace(/SOURCES_JSON:\s*(\
