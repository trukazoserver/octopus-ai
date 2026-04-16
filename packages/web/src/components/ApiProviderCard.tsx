import React, { useState } from 'react';
import { apiPut } from '../hooks/useApi.js';

interface ApiProviderCardProps {
  name: string;
  label: string;
  icon: string;
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  onSaved?: () => void;
}

export const ApiProviderCard: React.FC<ApiProviderCardProps> = ({ name, label, icon, apiKey, baseUrl, models, onSaved }) => {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(baseUrl ?? '');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const configured = apiKey && apiKey.length > 8;
  const displayKey = configured ? apiKey : '';

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      if (name === 'local') {
        if (url) {
          await apiPut(`/api/config/ai.providers.${name}.baseUrl`, url);
          setMsg('Guardado'); onSaved?.();
        }
      } else if (key) {
        await apiPut(`/api/config/ai.providers.${name}.apiKey`, key);
        setMsg('Guardado'); setKey(''); onSaved?.();
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(''), 3000);
    }
  };

  return (
    <div style={{ background: '#1a1a2e', borderRadius: '8px', border: '1px solid #0f3460', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '1.3rem' }}>{icon}</span>
          <span style={{ fontWeight: 600, color: '#e0e0e0' }}>{label}</span>
        </div>
        <span style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: '10px', background: configured ? 'rgba(0,230,118,0.15)' : 'rgba(255,255,255,0.05)', color: configured ? '#00e676' : '#555' }}>
          {configured ? 'Configurado' : 'Sin configurar'}
        </span>
      </div>

      {name === 'local' ? (
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="http://localhost:11434"
          style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #0f3460', background: '#16213e', color: '#e0e0e0', fontSize: '0.85rem', outline: 'none' }}
        />
      ) : (
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder={displayKey || 'sk-...'}
            style={{ flex: 1, padding: '8px 12px', borderRadius: '6px', border: '1px solid #0f3460', background: '#16213e', color: '#e0e0e0', fontSize: '0.85rem', outline: 'none' }}
          />
          <button
            onClick={() => setShowKey(!showKey)}
            style={{ padding: '8px', background: '#0f3460', border: 'none', borderRadius: '6px', color: '#aaa', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            {showKey ? '🙈' : '👁'}
          </button>
        </div>
      )}

      {models && models.length > 0 && (
        <div style={{ fontSize: '0.75rem', color: '#666' }}>
          Modelos: {models.join(', ')}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onClick={handleSave}
          disabled={saving || (name !== 'local' && !key)}
          style={{
            padding: '6px 14px', borderRadius: '6px', border: 'none',
            background: (saving || (name !== 'local' && !key)) ? '#333' : '#533483',
            color: (saving || (name !== 'local' && !key)) ? '#666' : '#fff',
            cursor: (saving || (name !== 'local' && !key)) ? 'not-allowed' : 'pointer',
            fontSize: '0.82rem', fontWeight: 600,
          }}
        >
          {saving ? '...' : 'Guardar'}
        </button>
        {msg && <span style={{ fontSize: '0.8rem', color: msg === 'Guardado' ? '#00e676' : '#ff5252' }}>{msg}</span>}
      </div>
    </div>
  );
};
