import React, { useState } from 'react';

export const ChatPage: React.FC = () => {
  const [messages, setMessages] = useState<{ role: 'user' | 'ai'; content: string }[]>([
    { role: 'ai', content: 'Hello! I am Octopus AI. How can I assist you today?' }
  ]);
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input.trim()) return;
    
    setMessages(prev => [...prev, { role: 'user', content: input }]);
    setInput('');
    
    // Simulate AI response
    setTimeout(() => {
      setMessages(prev => [...prev, { role: 'ai', content: 'This is a simulated response from Octopus AI.' }]);
    }, 1000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
        {messages.map((msg, idx) => (
          <div key={idx} style={{ marginBottom: '16px', textAlign: msg.role === 'user' ? 'right' : 'left' }}>
            <div style={{
              display: 'inline-block',
              padding: '10px 16px',
              borderRadius: '8px',
              backgroundColor: msg.role === 'user' ? '#007bff' : '#f1f1f1',
              color: msg.role === 'user' ? '#fff' : '#333',
              maxWidth: '70%',
            }}>
              {msg.content}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: '20px', borderTop: '1px solid #eee', display: 'flex', gap: '10px' }}>
        <input 
          type="text" 
          value={input}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleSend()}
          placeholder="Type a message..."
          style={{ flex: 1, padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }}
        />
        <button 
          onClick={handleSend}
          style={{ padding: '10px 20px', backgroundColor: '#007bff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          Send
        </button>
      </div>
    </div>
  );
};
