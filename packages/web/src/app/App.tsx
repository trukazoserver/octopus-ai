import React, { useState } from 'react';
import { ChatPage } from '../pages/chat.js';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('chat');

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#fff' }}>
      {/* Sidebar */}
      <div style={{ width: '250px', borderRight: '1px solid #eee', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px', fontSize: '1.2rem', fontWeight: 'bold', borderBottom: '1px solid #eee' }}>
          Octopus AI
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', padding: '10px 0' }}>
          <button 
            onClick={() => setActiveTab('chat')}
            style={{ 
              padding: '12px 20px', 
              textAlign: 'left', 
              border: 'none', 
              backgroundColor: activeTab === 'chat' ? '#f5f5f5' : 'transparent',
              cursor: 'pointer',
              fontSize: '1rem'
            }}
          >
            Chat
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            style={{ 
              padding: '12px 20px', 
              textAlign: 'left', 
              border: 'none', 
              backgroundColor: activeTab === 'settings' ? '#f5f5f5' : 'transparent',
              cursor: 'pointer',
              fontSize: '1rem'
            }}
          >
            Settings
          </button>
        </nav>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'chat' && <ChatPage />}
        {activeTab === 'settings' && (
          <div style={{ padding: '20px' }}>
            <h2>Settings</h2>
            <p>Settings panel implementation goes here.</p>
          </div>
        )}
      </div>
    </div>
  );
};
