import React, { useState, useEffect } from 'react';
import { apiGet } from '../hooks/useApi.js';

interface SkillsData {
  enabled: boolean;
  autoCreate: boolean;
  autoImprove: boolean;
  builtinSkills: string[];
  dbSkills: any[];
}

export const SkillsPage: React.FC = () => {
  const [skills, setSkills] = useState<SkillsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<SkillsData>('/api/skills')
      .then((s) => { setSkills(s); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  if (loading) return <div style={{ padding: 40, color: '#666' }}>Cargando skills...</div>;
  if (error) return <div style={{ padding: 40, color: '#ff1744' }}>Error: {error}</div>;

  return (
    <div style={{ padding: '20px', maxWidth: 900, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '1.3rem' }}>⚡ Skills (Habilidades)</h2>

      {/* Status */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginBottom: 20 }}>
        <StatCard icon="⚡" title="Skills Habilitadas" value={skills?.enabled ? 'Sí' : 'No'} color={skills?.enabled ? '#00e676' : '#ff1744'} />
        <StatCard icon="🤖" title="Auto-crear" value={skills?.autoCreate ? 'Activado' : 'Desactivado'} />
        <StatCard icon="📈" title="Auto-mejorar" value={skills?.autoImprove ? 'Activado' : 'Desactivado'} />
        <StatCard icon="📦" title="Builtin Skills" value={skills?.builtinSkills?.length ?? 0} />
        <StatCard icon="🗄️" title="Skills en BD" value={skills?.dbSkills?.length ?? 0} />
      </div>

      {/* Builtin Skills */}
      <div style={{ background: '#16213e', borderRadius: 8, border: '1px solid #0f3460', padding: 16, marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}>📦 Skills Incluidas</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
          {(skills?.builtinSkills ?? []).map((name) => {
            const desc = getSkillDesc(name);
            return (
              <div key={name} style={{ padding: 12, borderRadius: 8, background: '#1a1a2e', border: '1px solid #0f3460' }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#e0e0e0', marginBottom: 4 }}>{name}</div>
                <div style={{ fontSize: '0.78rem', color: '#888' }}>{desc}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* DB Skills */}
      {skills?.dbSkills && skills.dbSkills.length > 0 && (
        <div style={{ background: '#16213e', borderRadius: 8, border: '1px solid #0f3460', padding: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}>🗄️ Skills Auto-generadas</h3>
          {skills.dbSkills.map((skill: any, i: number) => (
            <div key={i} style={{ padding: 12, borderRadius: 8, background: '#1a1a2e', border: '1px solid #0f3460', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, color: '#e0e0e0' }}>{skill.name ?? `Skill ${i + 1}`}</div>
                  <div style={{ fontSize: '0.78rem', color: '#888' }}>{skill.description ?? ''}</div>
                </div>
                {skill.successRate !== undefined && (
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.78rem', color: '#888' }}>Tasa de éxito</div>
                    <div style={{ fontSize: '1rem', fontWeight: 600, color: skill.successRate >= 0.7 ? '#00e676' : skill.successRate >= 0.4 ? '#ffc107' : '#ff1744' }}>
                      {Math.round(skill.successRate * 100)}%
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function getSkillDesc(name: string): string {
  const descs: Record<string, string> = {
    'general-reasoning': 'Razonamiento general y resolución de problemas',
    'code-generation': 'Generación, revisión y refactorización de código',
    'writing': 'Escritura asistida: emails, documentos, creativa',
    'research': 'Investigación, búsqueda y síntesis de información',
  };
  return descs[name] ?? 'Habilidad personalizada';
}

const StatCard: React.FC<{ icon: string; title: string; value: string | number; color?: string }> = ({ icon, title, value, color = '#e0e0e0' }) => (
  <div style={{ padding: 14, borderRadius: 8, background: '#16213e', border: '1px solid #0f3460', textAlign: 'center' }}>
    <div style={{ fontSize: '1.4rem', marginBottom: 4 }}>{icon}</div>
    <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: 4 }}>{title}</div>
    <div style={{ fontSize: '1.1rem', fontWeight: 600, color }}>{value}</div>
  </div>
);
