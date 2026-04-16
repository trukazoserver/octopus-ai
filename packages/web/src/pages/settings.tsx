import React, { useState, useEffect } from 'react';
import { apiGet, apiPut } from '../hooks/useApi.js';
import { ConfigSection, Toggle, Field, Select, StatusBadge } from '../components/ConfigSection.js';

interface ProviderConfig { apiKey?: string; baseUrl?: string; mode?: string; models?: string[] }
interface ConfigData {
  ai?: { default?: string; fallback?: string; thinking?: string; maxTokens?: number; providers?: Record<string, ProviderConfig> };
  channels?: Record<string, { enabled: boolean }>;
  memory?: { enabled?: boolean; shortTerm?: any; longTerm?: any; consolidation?: any; retrieval?: any };
  skills?: { enabled?: boolean; autoCreate?: boolean; autoImprove?: boolean; forge?: any; improvement?: any; loading?: any; registry?: any };
  plugins?: { directories?: string[]; builtin?: string[] };
  server?: { port?: number; host?: string; transport?: string };
  connection?: any;
  storage?: { backend?: string; path?: string };
  security?: { encryptionKey?: string; allowedPaths?: string[]; sandboxCommands?: boolean };
}

const PROVIDERS = [
  { key: 'zhipu', name: 'Z.ai / ZhipuAI', icon: '🇨🇳', url: 'https://open.bigmodel.cn/', hasMode: true },
  { key: 'openai', name: 'OpenAI', icon: '🟢', url: 'https://platform.openai.com/api-keys' },
  { key: 'anthropic', name: 'Anthropic (Claude)', icon: '🟠', url: 'https://console.anthropic.com/' },
  { key: 'google', name: 'Google (Gemini)', icon: '🔵', url: 'https://aistudio.google.com/' },
  { key: 'deepseek', name: 'DeepSeek', icon: '🐋', url: 'https://platform.deepseek.com/' },
  { key: 'mistral', name: 'Mistral', icon: '🌀', url: 'https://console.mistral.ai/' },
  { key: 'xai', name: 'xAI (Grok)', icon: '⚡', url: 'https://console.x.ai/' },
  { key: 'cohere', name: 'Cohere', icon: '🔶', url: 'https://dashboard.cohere.com/' },
  { key: 'openrouter', name: 'OpenRouter', icon: '🌐', url: 'https://openrouter.ai/keys' },
  { key: 'local', name: 'Ollama (Local)', icon: '🦙', url: 'https://ollama.com/', isLocal: true },
];

export const SettingsPage: React.FC = () => {
  const [config, setConfig] = useState<ConfigData>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    apiGet<ConfigData>('/api/config').then((c) => { setConfig(c); setLoading(false); }).catch((e) => { setMsg({ text: e.message, ok: false }); setLoading(false); });
  }, []);

  const save = async (key: string, value: unknown) => {
    setMsg(null);
    try {
      await apiPut(`/api/config/${key}`, value);
      setMsg({ text: `✓ ${key} guardado`, ok: true });
    } catch (e) {
      setMsg({ text: `✗ ${e instanceof Error ? e.message : String(e)}`, ok: false });
    }
  };

  if (loading) return <div style={{ padding: 40, color: '#666' }}>Cargando configuración...</div>;

  const ai = config.ai ?? {};
  const providers = ai.providers ?? {};
  const allModels: string[] = [];
  for (const [, p] of Object.entries(providers)) { if (p.models) allModels.push(...p.models); }

  return (
    <div style={{ padding: '20px', maxWidth: 900, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '1.3rem' }}>⚙️ Configuración</h2>
      {msg && <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 12, background: msg.ok ? 'rgba(0,230,118,0.1)' : 'rgba(255,23,68,0.1)', color: msg.ok ? '#00e676' : '#ff1744', fontSize: '0.85rem' }}>{msg.text}</div>}

      <ConfigSection title="Proveedores de IA" icon="🤖" description="Escribe tu API Key y pulsa Enter para guardar." defaultOpen={true}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, marginBottom: 16 }}>
          {PROVIDERS.map((p) => {
            const prov = providers[p.key] ?? {};
            const hasKey = p.isLocal ? !!(prov as any).baseUrl : !!(prov as any).apiKey && (prov as any).apiKey !== '' && !(prov as any).apiKey?.includes('...');
            return (
              <div key={p.key} style={{ padding: 14, borderRadius: 8, background: '#1a1a2e', border: '1px solid #0f3460' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{p.icon} {p.name}</span>
                  <StatusBadge ok={hasKey} text={hasKey ? 'OK' : '—'} />
                </div>
                {p.isLocal ? (
                  <Field label="URL Base" value={(prov as any).baseUrl ?? 'http://localhost:11434'} onChange={(v) => save(`ai.providers.${p.key}.baseUrl`, v)} />
                ) : (
                  <div>
                    <input type="password" data-provider={p.key} placeholder={hasKey ? '••••...••••' : 'API Key'} onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value; if (v) save(`ai.providers.${p.key}.apiKey`, v); } }} style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #0f3460', background: '#111', color: '#e0e0e0', fontSize: '0.85rem', outline: 'none', fontFamily: 'monospace', marginBottom: 6, boxSizing: 'border-box' }} />
                    <button onClick={() => { const inp = document.querySelector(`[data-provider="${p.key}"]`) as HTMLInputElement; if (inp?.value) save(`ai.providers.${p.key}.apiKey`, inp.value); }} style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: '#533483', color: '#fff', fontSize: '0.78rem', cursor: 'pointer' }}>Guardar</button>
                  </div>
                )}
                {p.hasMode && <div style={{ marginTop: 8 }}><Select label="Modo" value={(prov as any).mode ?? 'coding-plan'} options={['api', 'coding-plan', 'coding-global', 'global']} onChange={(v) => save(`ai.providers.${p.key}.mode`, v)} /></div>}
                <div style={{ marginTop: 6 }}><a href={p.url} target="_blank" rel="noopener" style={{ fontSize: '0.72rem', color: '#7c4dff', textDecoration: 'none' }}>Obtener Key →</a></div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Select label="Modelo por defecto" value={ai.default ?? 'zhipu/glm-5.1'} options={allModels.length > 0 ? allModels : ['zhipu/glm-5.1', 'openai/gpt-4o', 'anthropic/claude-sonnet-4-6', 'google/gemini-2.5-pro', 'local/llama3.1']} onChange={(v) => save('ai.default', v)} />
          <Select label="Modelo respaldo" value={ai.fallback ?? ''} options={['(ninguno)', ...(allModels.length > 0 ? allModels : ['openai/gpt-4o'])]} onChange={(v) => save('ai.fallback', v === '(ninguno)' ? '' : v)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
          <Select label="Razonamiento" value={ai.thinking ?? 'medium'} options={['none', 'low', 'medium', 'high']} onChange={(v) => save('ai.thinking', v)} />
          <Field label="Max tokens" value={ai.maxTokens ?? 16384} type="number" onChange={(v) => save('ai.maxTokens', parseInt(v) || 16384)} />
        </div>
      </ConfigSection>

      <ConfigSection title="Canales de Mensajería" icon="📡">
        {config.channels && Object.entries(config.channels).map(([name, ch]) => (
          <Toggle key={name} label={name.charAt(0).toUpperCase() + name.slice(1)} value={ch.enabled} onChange={(v) => save(`channels.${name}.enabled`, v)} />
        ))}
      </ConfigSection>

      <ConfigSection title="Memoria" icon="🧠">
        <Toggle label="Habilitada" value={config.memory?.enabled ?? true} onChange={(v) => save('memory.enabled', v)} />
        {config.memory?.shortTerm && <Field label="STM Max tokens" value={config.memory.shortTerm.maxTokens ?? 8192} type="number" onChange={(v) => save('memory.shortTerm.maxTokens', parseInt(v))} />}
        {config.memory?.longTerm && <>
          <Field label="Umbral importancia" value={config.memory.longTerm.importanceThreshold ?? 0.5} type="number" onChange={(v) => save('memory.longTerm.importanceThreshold', parseFloat(v))} />
          <Field label="Max items" value={config.memory.longTerm.maxItems ?? 100000} type="number" onChange={(v) => save('memory.longTerm.maxItems', parseInt(v))} />
        </>}
        {config.memory?.retrieval && <>
          <Field label="Resultados max" value={config.memory.retrieval.maxResults ?? 10} type="number" onChange={(v) => save('memory.retrieval.maxResults', parseInt(v))} />
          <Field label="Relevancia min" value={config.memory.retrieval.minRelevance ?? 0.6} type="number" onChange={(v) => save('memory.retrieval.minRelevance', parseFloat(v))} />
        </>}
      </ConfigSection>

      <ConfigSection title="Skills" icon="⚡">
        <Toggle label="Habilitadas" value={config.skills?.enabled ?? true} onChange={(v) => save('skills.enabled', v)} />
        <Toggle label="Auto-crear" value={config.skills?.autoCreate ?? true} onChange={(v) => save('skills.autoCreate', v)} />
        <Toggle label="Auto-mejorar" value={config.skills?.autoImprove ?? true} onChange={(v) => save('skills.autoImprove', v)} />
        {config.skills?.registry?.builtinSkills && <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>{config.skills.registry.builtinSkills.map((s: string) => <span key={s} style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(83,52,131,0.2)', fontSize: '0.8rem', color: '#aaa' }}>{s}</span>)}</div>}
      </ConfigSection>

      <ConfigSection title="Servidor" icon="🖥️" description="⚠️ Requiere reiniciar el servidor.">
        <Field label="Puerto" value={config.server?.port ?? 18789} type="number" onChange={(v) => save('server.port', parseInt(v))} />
        <Field label="Host" value={config.server?.host ?? '127.0.0.1'} onChange={(v) => save('server.host', v)} />
        <Select label="Transporte" value={config.server?.transport ?? 'auto'} options={['auto', 'stdio', 'sse', 'streamable-http']} onChange={(v) => save('server.transport', v)} />
      </ConfigSection>

      <ConfigSection title="Conexión" icon="🌐">
        <Toggle label="Auto proxy" value={config.connection?.autoProxy ?? true} onChange={(v) => save('connection.autoProxy', v)} />
        <Toggle label="Preferir IPv4" value={config.connection?.preferIPv4 ?? true} onChange={(v) => save('connection.preferIPv4', v)} />
        <Field label="Reintentos max" value={config.connection?.retryMaxAttempts ?? 5} type="number" onChange={(v) => save('connection.retryMaxAttempts', parseInt(v))} />
        <Field label="Cola offline" value={config.connection?.offlineQueueSize ?? 1000} type="number" onChange={(v) => save('connection.offlineQueueSize', parseInt(v))} />
      </ConfigSection>

      <ConfigSection title="Seguridad" icon="🔒">
        <Toggle label="Sandbox" value={config.security?.sandboxCommands ?? true} onChange={(v) => save('security.sandboxCommands', v)} />
        <div style={{ marginTop: 8 }}><div style={{ fontSize: '0.82rem', color: '#aaa', marginBottom: 4 }}>Rutas permitidas:</div><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{(config.security?.allowedPaths ?? []).map((p, i) => <span key={i} style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(83,52,131,0.15)', fontSize: '0.8rem', color: '#aaa' }}>{p}</span>)}</div></div>
      </ConfigSection>

      <ConfigSection title="Almacenamiento" icon="💾">
        <Field label="Motor" value={config.storage?.backend ?? 'sqlite'} onChange={(v) => save('storage.backend', v)} />
        <Field label="Ruta BD" value={config.storage?.path ?? '~/.octopus/data/octopus.db'} onChange={(v) => save('storage.path', v)} />
      </ConfigSection>

      <ConfigSection title="Plugins" icon="🧩">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(config.plugins?.builtin ?? []).map((p) => <span key={p} style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(83,52,131,0.2)', fontSize: '0.8rem', color: '#aaa' }}>{p}</span>)}</div>
      </ConfigSection>
    </div>
  );
};
