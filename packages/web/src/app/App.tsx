import React, { useState } from 'react';
import { ChatPage } from '../pages/chat.js';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('chat');

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#1a1a2e', color: '#e0e0e0' }}>
      {/* Sidebar */}
      <div style={{ width: '260px', background: '#16213e', borderRight: '1px solid #0f3460', display: 'flex', flexDirection: 'column' }}>
        {/* Logo */}
        <div style={{ padding: '20px', borderBottom: '1px solid #0f3460', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: '#533483', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>
            🐙
          </div>
          <div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>Octopus AI</div>
            <div style={{ fontSize: '0.7rem', color: '#666' }}>v0.1.0</div>
          </div>
        </div>

        {/* Navigation */}
        <nav style={{ display: 'flex', flexDirection: 'column', padding: '8px', gap: '2px', flex: 1 }}>
          {[
            { id: 'chat', icon: '💬', label: 'Chat' },
            { id: 'memory', icon: '🧠', label: 'Memoria' },
            { id: 'skills', icon: '⚡', label: 'Skills' },
            { id: 'settings', icon: '⚙️', label: 'Configuración' },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              style={{
                padding: '10px 14px',
                textAlign: 'left',
                border: 'none',
                borderRadius: '8px',
                background: activeTab === item.id ? 'rgba(83, 52, 131, 0.3)' : 'transparent',
                color: activeTab === item.id ? '#fff' : '#888',
                cursor: 'pointer',
                fontSize: '0.9rem',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                transition: 'all 0.15s',
                fontWeight: activeTab === item.id ? 600 : 400,
              }}
            >
              <span style={{ fontSize: '1.1rem' }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: '16px', borderTop: '1px solid #0f3460', fontSize: '0.75rem', color: '#555', textAlign: 'center' }}>
          Octopus AI — Autoalojado
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {activeTab === 'chat' && <ChatPage />}
        {activeTab === 'memory' && (
          <PlaceholderPage icon="🧠" title="Memoria" description="Aquí podrás ver y buscar en los recuerdos de Octopus AI (hechos, eventos, procedimientos)." />
        )}
        {activeTab === 'skills' && (
          <PlaceholderPage icon="⚡" title="Skills" description="Gestiona las habilidades de Octopus AI. Habilita, deshabilita o crea nuevas skills." />
        )}
        {activeTab === 'settings' && (
          <PlaceholderPage icon="⚙️" title="Configuración" description="Cambia el modelo de IA, configura API keys, ajusta la memoria y los canales de mensajería." />
        )}
      </div>
    </div>
  );
};

const PlaceholderPage: React.FC<{ icon: string; title: string; description: string }> = ({ icon, title, description }) => (
  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#666', gap: '12px' }}>
    <div style={{ fontSize: '3rem' }}>{icon}</div>
    <h2 style={{ margin: 0, color: '#e0e0e0', fontSize: '1.4rem' }}>{title}</h2>
    <p style={{ margin: 0, maxWidth: '400px', textAlign: 'center', lineHeight: 1.6 }}>{description}</p>
    <p style={{ margin: '12px 0 0', fontSize: '0.8rem', color: '#444' }}>Próximamente disponible</p>
  </div>
);
