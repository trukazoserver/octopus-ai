import React, { useState, useRef, useEffect, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { apiGet, apiPut } from '../hooks/useApi.js';

const WS_URL = `ws://${window.location.hostname}:18789`;

interface StatusData {
  provider?: string;
  fallback?: string;
  thinking?: string;
  maxTokens?: number;
  channels?: string[];
  memoryEnabled?: boolean;
  skillsEnabled?: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface WsMessage {
  id: string;
  type: string;
  channel: string;
  payload: any;
  timestamp: number;
}

function nanoid(size = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < size; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderMarkdown(text: string): string {
  try {
    const html = marked.parse(text, { async: false, breaks: true, gfm: true }) as string;
    return DOMPurify.sanitize(html);
  } catch {
    return DOMPurify.sanitize(text);
  }
}

export const ChatPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { id: '0', role: 'assistant', content: '¡Hola! Soy **Octopus AI**. ¿En qué puedo ayudarte hoy?', timestamp: Date.now() }
  ]);
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<StatusData | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingIdRef = useRef<string>('');

  useEffect(() => {
    apiGet<StatusData>('/api/status').then(setStatus).catch(() => {});
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setIsConnected(true);
      console.log('WebSocket connected');
    };

    ws.onclose = () => {
      setIsConnected(false);
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);

        if (msg.type === 'pong') return;

        if (msg.type === 'response') {
          const responseText = msg.payload?.response || msg.payload?.text || JSON.stringify(msg.payload);
          const assistantContent = typeof responseText === 'string' ? responseText : JSON.stringify(responseText);

          setMessages(prev => {
            const existing = prev.find(m => m.id === `stream-${msg.id}`);
            if (existing) {
              return prev.map(m => m.id === `stream-${msg.id}` ? { ...m, content: assistantContent, role: 'assistant' as const } : m);
            }
            return [...prev, { id: msg.id, role: 'assistant', content: assistantContent, timestamp: Date.now() }];
          });
          setIsLoading(false);
          pendingIdRef.current = '';
        } else if (msg.type === 'stream') {
          const chunk = msg.payload?.chunk || msg.payload?.text || '';
          const streamId = `stream-${msg.id}`;
          setMessages(prev => {
            const existing = prev.find(m => m.id === streamId);
            if (existing) {
              return prev.map(m => m.id === streamId ? { ...m, content: m.content + chunk } : m);
            }
            return [...prev, { id: streamId, role: 'assistant', content: chunk, timestamp: Date.now() }];
          });
        } else if (msg.type === 'stream_end') {
          setIsLoading(false);
          pendingIdRef.current = '';
        } else if (msg.type === 'error') {
          const errMsg = msg.payload?.error || 'Error desconocido';
          setMessages(prev => [...prev, { id: nanoid(), role: 'assistant', content: `⚠️ Error: ${errMsg}`, timestamp: Date.now() }]);
          setIsLoading(false);
          pendingIdRef.current = '';
        }
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMsg: Message = { id: nanoid(), role: 'user', content: text, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    inputRef.current?.focus();

    const requestId = nanoid();
    pendingIdRef.current = requestId;

    const wsMsg: WsMessage = {
      id: requestId,
      type: 'request',
      channel: 'chat',
      payload: { message: text },
      timestamp: Date.now(),
    };

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(wsMsg));
    } else {
      setMessages(prev => [...prev, { id: nanoid(), role: 'assistant', content: '⚠️ No hay conexión con el servidor. Verifica que el backend esté corriendo.', timestamp: Date.now() }]);
      setIsLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1a1a2e' }}>
      {/* Connection Bar */}
      <div style={{ padding: '8px 16px', background: '#16213e', borderBottom: '1px solid #0f3460', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: isConnected ? '#00e676' : '#ff1744', flexShrink: 0 }} />
        <span style={{ color: '#a0a0b0', fontSize: '0.8rem' }}>
          {isConnected ? 'Conectado' : 'Desconectado'} — ws://{window.location.hostname}:18789
        </span>
        <div style={{ flex: 1 }} />
        {status?.provider && (
          <span style={{ fontSize: '0.75rem', padding: '3px 10px', borderRadius: '8px', background: 'rgba(83,52,131,0.2)', color: '#aaa' }}>
            Modelo: {status.provider}
          </span>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {messages.map((msg) => (
          <div key={msg.id} style={{ marginBottom: '20px', display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {msg.role === 'assistant' && (
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#0f3460', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '10px', flexShrink: 0, fontSize: '14px' }}>
                🐙
              </div>
            )}
            <div style={{ maxWidth: '75%' }}>
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                  background: msg.role === 'user' ? '#533483' : '#16213e',
                  color: msg.role === 'user' ? '#fff' : '#e0e0e0',
                  fontSize: '0.95rem',
                  lineHeight: '1.6',
                  border: msg.role === 'user' ? 'none' : '1px solid #0f3460',
                }}
              >
                {msg.role === 'assistant' ? (
                  <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                ) : (
                  msg.content
                )}
              </div>
              <div style={{ fontSize: '0.7rem', color: '#555', marginTop: '4px', textAlign: msg.role === 'user' ? 'right' : 'left', paddingLeft: msg.role === 'user' ? '0' : '4px' }}>
                {formatTime(msg.timestamp)}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#0f3460', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '10px', fontSize: '14px' }}>
              🐙
            </div>
            <div style={{ padding: '12px 16px', borderRadius: '18px 18px 18px 4px', background: '#16213e', border: '1px solid #0f3460' }}>
              <div style={{ display: 'flex', gap: '4px' }}>
                <span className="dot-animation" style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#533483', animation: 'pulse 1.4s infinite ease-in-out' }} />
                <span className="dot-animation" style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#533483', animation: 'pulse 1.4s infinite ease-in-out 0.2s' }} />
                <span className="dot-animation" style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#533483', animation: 'pulse 1.4s infinite ease-in-out 0.4s' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '16px 20px', background: '#16213e', borderTop: '1px solid #0f3460' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder={isConnected ? 'Escribe un mensaje...' : 'Sin conexión al servidor...'}
            disabled={!isConnected || isLoading}
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: '12px',
              border: '1px solid #0f3460',
              background: '#1a1a2e',
              color: '#e0e0e0',
              fontSize: '0.95rem',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !isConnected || isLoading}
            style={{
              padding: '12px 20px',
              borderRadius: '12px',
              border: 'none',
              background: (!input.trim() || !isConnected || isLoading) ? '#333' : '#533483',
              color: (!input.trim() || !isConnected || isLoading) ? '#666' : '#fff',
              fontSize: '0.95rem',
              cursor: (!input.trim() || !isConnected || isLoading) ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              transition: 'background 0.2s',
            }}
          >
            Enviar
          </button>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        .markdown-body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .markdown-body p { margin: 0 0 8px 0; }
        .markdown-body p:last-child { margin-bottom: 0; }
        .markdown-body code { background: rgba(83, 52, 131, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
        .markdown-body pre { background: rgba(15, 52, 96, 0.5); padding: 12px; border-radius: 8px; overflow-x: auto; margin: 8px 0; }
        .markdown-body pre code { background: none; padding: 0; }
        .markdown-body ul, .markdown-body ol { margin: 4px 0; padding-left: 20px; }
        .markdown-body blockquote { border-left: 3px solid #533483; margin: 8px 0; padding-left: 12px; color: #aaa; }
        .markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 12px 0 6px; }
        .markdown-body a { color: #7c4dff; text-decoration: underline; }
        .markdown-body table { border-collapse: collapse; margin: 8px 0; width: 100%; }
        .markdown-body th, .markdown-body td { border: 1px solid #0f3460; padding: 6px 10px; }
        .markdown-body th { background: rgba(15, 52, 96, 0.3); }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #1a1a2e; }
        ::-webkit-scrollbar-thumb { background: #0f3460; border-radius: 3px; }
      `}</style>
    </div>
  );
};
