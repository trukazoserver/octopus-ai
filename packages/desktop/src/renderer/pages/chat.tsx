import React, { useState } from 'react';

export const Chat: React.FC = () => {
  const [messages, setMessages] = useState([{ id: 1, text: 'Hello! I am Octopus AI. How can I help you today?', sender: 'ai' }]);
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (!input.trim()) return;
    
    const newUserMessage = { id: Date.now(), text: input, sender: 'user' };
    setMessages([...messages, newUserMessage]);
    setInput('');
    
    // Simulate AI response
    setTimeout(() => {
      setMessages(prev => [...prev, { id: Date.now() + 1, text: 'I received your message: ' + newUserMessage.text, sender: 'ai' }]);
    }, 1000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '20px', borderBottom: '1px solid #ddd', backgroundColor: '#fff' }}>
        <h2 style={{ margin: 0 }}>Chat</h2>
      </div>
      
      <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
        {messages.map(msg => (
          <div key={msg.id} style={{ 
            marginBottom: '10px', 
            textAlign: msg.sender === 'user' ? 'right' : 'left' 
          }}>
            <div style={{ 
              display: 'inline-block', 
              padding: '10px 15px', 
              borderRadius: '20px', 
              backgroundColor: msg.sender === 'user' ? '#3498db' : '#fff',
              color: msg.sender === 'user' ? '#fff' : '#333',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
            }}>
              {msg.text}
            </div>
          </div>
        ))}
      </div>
      
      <div style={{ padding: '20px', backgroundColor: '#fff', borderTop: '1px solid #ddd', display: 'flex' }}>
        <input 
          type="text" 
          value={input}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleSend()}
          placeholder="Type a message..." 
          style={{ 
            flex: 1, 
            padding: '12px 15px', 
            borderRadius: '24px', 
            border: '1px solid #ccc',
            marginRight: '10px',
            fontSize: '16px',
            outline: 'none'
          }} 
        />
        <button 
          onClick={handleSend}
          style={{ 
            padding: '10px 20px', 
            borderRadius: '24px', 
            backgroundColor: '#2ecc71', 
            color: '#fff', 
            border: 'none', 
            cursor: 'pointer',
            fontSize: '16px',
            fontWeight: 'bold'
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
};

