import React from 'react';

export const ConfigSection: React.FC<{
  title: string;
  icon: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, icon, description, defaultOpen = false, children }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div style={{ marginBottom: '8px', borderRadius: '8px', background: '#16213e', border: '1px solid #0f3460', overflow: 'hidden' }}>
      <button onClick={() => setOpen(!open)} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', background: 'transparent', border: 'none', color: '#e0e0e0', cursor: 'pointer', fontSize: '0.95rem', fontWeight: 600, textAlign: 'left' }}>
        <span style={{ fontSize: '1.2rem' }}>{icon}</span>
        <span style={{ flex: 1 }}>{title}</span>
        <span style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', color: '#666' }}>▸</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px' }}>
          {description && <p style={{ margin: '0 0 12px', color: '#888', fontSize: '0.82rem' }}>{description}</p>}
          {children}
        </div>
      )}
    </div>
  );
};

export const Toggle: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void; description?: string }> = ({ label, value, onChange, description }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
    <div>
      <div style={{ fontSize: '0.9rem', color: '#e0e0e0' }}>{label}</div>
      {description && <div style={{ fontSize: '0.75rem', color: '#666' }}>{description}</div>}
    </div>
    <div onClick={() => onChange(!value)} style={{ width: '44px', height: '24px', borderRadius: '12px', cursor: 'pointer', background: value ? '#533483' : '#333', position: 'relative', transition: 'background 0.2s' }}>
      <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: '#fff', position: 'absolute', top: '3px', left: value ? '23px' : '3px', transition: 'left 0.2s' }} />
    </div>
  </div>
);

export const Field: React.FC<{ label: string; value: string | number; onChange: (v: string) => void; type?: string; placeholder?: string; description?: string }> = ({ label, value, onChange, type = 'text', placeholder, description }) => (
  <div style={{ marginBottom: '12px' }}>
    <label style={{ display: 'block', fontSize: '0.82rem', color: '#aaa', marginBottom: '4px' }}>{label}</label>
    {description && <div style={{ fontSize: '0.72rem', color: '#555', marginBottom: '4px' }}>{description}</div>}
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #0f3460', background: '#1a1a2e', color: '#e0e0e0', fontSize: '0.9rem', outline: 'none', fontFamily: type === 'password' ? 'monospace' : 'inherit' }} />
  </div>
);

export const Select: React.FC<{ label: string; value: string; options: string[]; onChange: (v: string) => void; description?: string }> = ({ label, value, options, onChange, description }) => (
  <div style={{ marginBottom: '12px' }}>
    <label style={{ display: 'block', fontSize: '0.82rem', color: '#aaa', marginBottom: '4px' }}>{label}</label>
    {description && <div style={{ fontSize: '0.72rem', color: '#555', marginBottom: '4px' }}>{description}</div>}
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #0f3460', background: '#1a1a2e', color: '#e0e0e0', fontSize: '0.9rem', outline: 'none' }}>
      {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
    </select>
  </div>
);

export const SaveButton: React.FC<{ onClick: () => void; saving?: boolean; label?: string }> = ({ onClick, saving, label = 'Guardar' }) => (
  <button onClick={onClick} disabled={saving} style={{ padding: '10px 24px', borderRadius: '8px', border: 'none', background: saving ? '#333' : '#533483', color: saving ? '#666' : '#fff', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
    {saving ? 'Guardando...' : label}
  </button>
);

export const StatusBadge: React.FC<{ ok: boolean; text: string }> = ({ ok, text }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '10px', fontSize: '0.72rem', background: ok ? 'rgba(0,230,118,0.15)' : 'rgba(255,255,255,0.08)', color: ok ? '#00e676' : '#666' }}>
    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: ok ? '#00e676' : '#444' }} />
    {text}
  </span>
);
