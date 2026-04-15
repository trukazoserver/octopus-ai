import React from 'react';

export const Agents: React.FC = () => {
  const agents = [
    { id: '1', name: 'General Assistant', status: 'Active', description: 'Handles general queries and tasks.' },
    { id: '2', name: 'Code Reviewer', status: 'Idle', description: 'Analyzes code for bugs and style issues.' },
    { id: '3', name: 'Data Analyst', status: 'Offline', description: 'Processes and visualizes data sets.' },
  ];

  return (
    <div style={{ padding: '20px' }}>
      <h2>Agent Management</h2>
      <p style={{ color: '#666', marginBottom: '20px' }}>Manage and deploy your AI agents here.</p>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
        {agents.map(agent => (
          <div key={agent.id} style={{ 
            backgroundColor: '#fff', 
            padding: '20px', 
            borderRadius: '8px',
            boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <h3 style={{ margin: '0 0 5px 0' }}>{agent.name}</h3>
              <p style={{ margin: 0, color: '#666', fontSize: '14px' }}>{agent.description}</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
              <span style={{ 
                padding: '5px 10px', 
                borderRadius: '12px', 
                fontSize: '12px',
                fontWeight: 'bold',
                backgroundColor: agent.status === 'Active' ? '#e8f8f5' : agent.status === 'Idle' ? '#fef9e7' : '#fdedec',
                color: agent.status === 'Active' ? '#27ae60' : agent.status === 'Idle' ? '#f39c12' : '#c0392b'
              }}>
                {agent.status}
              </span>
              <button style={{
                padding: '8px 15px',
                borderRadius: '4px',
                border: '1px solid #ddd',
                backgroundColor: '#fff',
                cursor: 'pointer'
              }}>
                Configure
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

