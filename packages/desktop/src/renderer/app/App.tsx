import React, { useState } from 'react';
import { Chat } from '../pages/chat.js';
import { Agents } from '../pages/agents.js';
import { Memory } from '../pages/memory.js';
import { Plugins } from '../pages/plugins.js';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('chat');

  const renderContent = () => {
    switch (activeTab) {
      case 'chat':
        return <Chat />;
      case 'agents':
        return <Agents />;
      case 'memory':
        return <Memory />;
      case 'plugins':
        return <Plugins />;
      case 'settings':
        return <div style={{ padding: '20px' }}><h2>Settings</h2><p>Settings coming soon...</p></div>;
      default:
        return <Chat />;
    }
  };

  const navItemStyle = (tabId: string) => ({
    padding: '12px 20px',
    cursor: 'pointer',
    backgroundColor: activeTab === tabId ? '#34495e' : 'transparent',
    color: '#fff',
    border: 'none',
    width: '100%',
    textAlign: 'left' as const,
    fontSize: '16px',
    outline: 'none',
  });

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Sidebar */}
      <div style={{ width: '250px', backgroundColor: '#2c3e50', color: '#fff', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px', fontSize: '24px', fontWeight: 'bold', borderBottom: '1px solid #34495e' }}>
          Octopus AI
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: '10px' }}>
          <button style={navItemStyle('chat')} onClick={() => setActiveTab('chat')}>Chat</button>
          <button style={navItemStyle('agents')} onClick={() => setActiveTab('agents')}>Agents</button>
          <button style={navItemStyle('memory')} onClick={() => setActiveTab('memory')}>Memory</button>
          <button style={navItemStyle('plugins')} onClick={() => setActiveTab('plugins')}>Skills/Plugins</button>
          <div style={{ flex: 1 }}></div>
          <button style={navItemStyle('settings')} onClick={() => setActiveTab('settings')}>Settings</button>
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, backgroundColor: '#ecf0f1', overflow: 'auto' }}>
        {renderContent()}
      </div>
    </div>
  );
};

