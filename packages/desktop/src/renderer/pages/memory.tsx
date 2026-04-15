import React from 'react';

export const Memory: React.FC = () => {
  return (
    <div style={{ padding: '20px', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <h2>Memory Explorer</h2>
      <p style={{ color: '#666', marginBottom: '20px' }}>View and manage the AI's short-term and long-term memory.</p>
      
      <div style={{ display: 'flex', gap: '20px', flex: 1 }}>
        {/* Short-Term Memory */}
        <div style={{ 
          flex: 1, 
          backgroundColor: '#fff', 
          borderRadius: '8px', 
          padding: '20px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <h3 style={{ marginTop: 0, borderBottom: '1px solid #eee', paddingBottom: '10px' }}>Short-Term Memory (STM)</h3>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{ padding: '10px', backgroundColor: '#f9f9f9', borderRadius: '4px', marginBottom: '10px' }}>
              <strong style={{ display: 'block', fontSize: '12px', color: '#888' }}>Context Window</strong>
              <span style={{ fontSize: '14px' }}>Recent conversation about setting up the React app...</span>
            </div>
            <div style={{ padding: '10px', backgroundColor: '#f9f9f9', borderRadius: '4px', marginBottom: '10px' }}>
              <strong style={{ display: 'block', fontSize: '12px', color: '#888' }}>Current Goal</strong>
              <span style={{ fontSize: '14px' }}>Implement basic UI components.</span>
            </div>
          </div>
        </div>

        {/* Long-Term Memory */}
        <div style={{ 
          flex: 1, 
          backgroundColor: '#fff', 
          borderRadius: '8px', 
          padding: '20px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <h3 style={{ marginTop: 0, borderBottom: '1px solid #eee', paddingBottom: '10px' }}>Long-Term Memory (LTM)</h3>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{ padding: '10px', backgroundColor: '#f9f9f9', borderRadius: '4px', marginBottom: '10px' }}>
              <strong style={{ display: 'block', fontSize: '12px', color: '#888' }}>User Preference</strong>
              <span style={{ fontSize: '14px' }}>Prefers concise answers and inline CSS for early prototyping.</span>
            </div>
            <div style={{ padding: '10px', backgroundColor: '#f9f9f9', borderRadius: '4px', marginBottom: '10px' }}>
              <strong style={{ display: 'block', fontSize: '12px', color: '#888' }}>Fact</strong>
              <span style={{ fontSize: '14px' }}>Project is located at D:\Aplicaciones Visual Estudio code\octopus-ai</span>
            </div>
            <button style={{ 
              width: '100%', 
              padding: '10px', 
              marginTop: '10px', 
              backgroundColor: '#3498db', 
              color: '#fff', 
              border: 'none', 
              borderRadius: '4px',
              cursor: 'pointer'
            }}>
              Search Vector Database
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

