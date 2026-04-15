import React, { useState, useEffect } from 'react';

interface PluginInfo {
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  tags: string[];
  downloads: number;
  rating: number;
  hasUpdate: boolean;
  latestVersion?: string;
}

type TabView = 'installed' | 'marketplace' | 'updates';

export const Plugins: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabView>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [plugins] = useState<PluginInfo[]>([
    { name: 'Productivity', version: '1.2.0', description: 'Task management and workflows', author: 'OctopusTeam', enabled: true, tags: ['tasks', 'calendar'], downloads: 1540, rating: 4.5, hasUpdate: false },
    { name: 'Coding', version: '2.0.1', description: 'Code generation, review, and refactoring', author: 'OctopusTeam', enabled: true, tags: ['code', 'dev'], downloads: 2310, rating: 4.8, hasUpdate: false },
    { name: 'Research', version: '0.9.5', description: 'Web research and synthesis', author: 'Community', enabled: false, tags: ['search', 'web'], downloads: 890, rating: 4.2, hasUpdate: true, latestVersion: '1.0.0' },
    { name: 'File Manager', version: '1.0.0', description: 'File operations and organization', author: 'OctopusTeam', enabled: false, tags: ['files'], downloads: 670, rating: 4.0, hasUpdate: false },
    { name: 'Sales', version: '1.1.0', description: 'CRM, outreach, and pipeline management', author: 'Community', enabled: false, tags: ['sales', 'crm'], downloads: 340, rating: 3.8, hasUpdate: false },
    { name: 'Customer Support', version: '0.8.0', description: 'Ticket triage and auto-responses', author: 'Community', enabled: false, tags: ['support', 'tickets'], downloads: 520, rating: 4.1, hasUpdate: true, latestVersion: '0.9.0' },
    { name: 'Data Analysis', version: '1.0.2', description: 'SQL queries, dashboards, and analysis', author: 'ThirdParty', enabled: false, tags: ['data', 'sql'], downloads: 780, rating: 4.3, hasUpdate: false },
  ]);

  const [marketplacePlugins] = useState<PluginInfo[]>([
    { name: 'Email Automation', version: '1.3.0', description: 'Automate email workflows and responses', author: 'OctopusTeam', enabled: false, tags: ['email', 'automation'], downloads: 3400, rating: 4.6, hasUpdate: false },
    { name: 'Image Generator', version: '0.5.0', description: 'Generate images from text descriptions', author: 'Community', enabled: false, tags: ['image', 'ai'], downloads: 2100, rating: 4.4, hasUpdate: false },
    { name: 'Database Admin', version: '2.1.0', description: 'Database management and monitoring', author: 'ThirdParty', enabled: false, tags: ['database', 'admin'], downloads: 1800, rating: 4.7, hasUpdate: false },
    { name: 'Social Media', version: '1.0.0', description: 'Social media posting and analytics', author: 'Community', enabled: false, tags: ['social', 'marketing'], downloads: 950, rating: 3.9, hasUpdate: false },
    { name: 'Documentation', version: '1.2.0', description: 'Auto-generate documentation from code', author: 'OctopusTeam', enabled: false, tags: ['docs', 'code'], downloads: 1200, rating: 4.5, hasUpdate: false },
  ]);

  const filteredPlugins = (list: PluginInfo[]) => {
    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.includes(q)),
    );
  };

  const tabStyle = (tab: TabView) => ({
    padding: '10px 20px',
    cursor: 'pointer',
    backgroundColor: activeTab === tab ? '#3498db' : 'transparent',
    color: activeTab === tab ? '#fff' : '#666',
    border: 'none',
    borderBottom: activeTab === tab ? '3px solid #3498db' : '3px solid transparent',
    fontWeight: activeTab === tab ? 'bold' : 'normal',
    fontSize: '14px',
  });

  const updateCount = plugins.filter((p) => p.hasUpdate).length;

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0 }}>Plugin Manager</h2>
          <p style={{ color: '#666', margin: '5px 0 0 0' }}>Extend Octopus AI with plugins from the marketplace.</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            placeholder="Search plugins..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: '8px 12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '14px',
              width: '250px',
            }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '5px', borderBottom: '1px solid #eee', marginBottom: '20px' }}>
        <button style={tabStyle('installed')} onClick={() => setActiveTab('installed')}>
          Installed ({plugins.length})
        </button>
        <button style={tabStyle('marketplace')} onClick={() => setActiveTab('marketplace')}>
          Marketplace
        </button>
        <button style={tabStyle('updates')} onClick={() => setActiveTab('updates')}>
          Updates {updateCount > 0 && `(${updateCount})`}
        </button>
      </div>

      {activeTab === 'installed' && (
        <PluginTable
          plugins={filteredPlugins(plugins)}
          showInstall={false}
          onToggle={(name) => {}}
        />
      )}

      {activeTab === 'marketplace' && (
        <PluginTable
          plugins={filteredPlugins(marketplacePlugins)}
          showInstall={true}
          onInstall={(name) => {}}
        />
      )}

      {activeTab === 'updates' && (
        <div>
          {plugins.filter((p) => p.hasUpdate).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#666' }}>
              <p>All plugins are up to date</p>
            </div>
          ) : (
            <PluginTable
              plugins={plugins.filter((p) => p.hasUpdate)}
              showInstall={false}
              showUpdate={true}
              onUpdate={(name) => {}}
            />
          )}
        </div>
      )}
    </div>
  );
};

interface PluginTableProps {
  plugins: PluginInfo[];
  showInstall?: boolean;
  showUpdate?: boolean;
  onToggle?: (name: string) => void;
  onInstall?: (name: string) => void;
  onUpdate?: (name: string) => void;
}

const PluginTable: React.FC<PluginTableProps> = ({ plugins, showInstall, showUpdate, onToggle, onInstall, onUpdate }) => {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', backgroundColor: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', borderRadius: '8px', overflow: 'hidden' }}>
      <thead style={{ backgroundColor: '#f8f9fa', borderBottom: '2px solid #eee' }}>
        <tr>
          <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600', fontSize: '13px' }}>Plugin</th>
          <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600', fontSize: '13px' }}>Version</th>
          <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600', fontSize: '13px' }}>Author</th>
          <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600', fontSize: '13px' }}>Downloads</th>
          <th style={{ padding: '12px', textAlign: 'left', fontWeight: '600', fontSize: '13px' }}>Rating</th>
          <th style={{ padding: '12px', textAlign: 'right', fontWeight: '600', fontSize: '13px' }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {plugins.map((plugin) => (
          <tr key={plugin.name} style={{ borderBottom: '1px solid #eee' }}>
            <td style={{ padding: '12px' }}>
              <div style={{ fontWeight: '500' }}>{plugin.name}</div>
              <div style={{ color: '#888', fontSize: '12px' }}>{plugin.description}</div>
              <div style={{ marginTop: '4px' }}>
                {plugin.tags.map((tag) => (
                  <span key={tag} style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    backgroundColor: '#e8f4fd',
                    color: '#3498db',
                    borderRadius: '12px',
                    fontSize: '11px',
                    marginRight: '4px',
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            </td>
            <td style={{ padding: '12px', color: '#666', fontSize: '13px' }}>
              v{plugin.version}
              {showUpdate && plugin.latestVersion && (
                <span style={{ color: '#e67e22', fontSize: '11px', marginLeft: '5px' }}>
                  → v{plugin.latestVersion}
                </span>
              )}
            </td>
            <td style={{ padding: '12px', color: '#666', fontSize: '13px' }}>{plugin.author}</td>
            <td style={{ padding: '12px', color: '#666', fontSize: '13px' }}>{plugin.downloads.toLocaleString()}</td>
            <td style={{ padding: '12px', fontSize: '13px' }}>{'⭐'.repeat(Math.round(plugin.rating))} {plugin.rating}</td>
            <td style={{ padding: '12px', textAlign: 'right' }}>
              {showInstall ? (
                <button
                  onClick={() => onInstall?.(plugin.name)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '4px',
                    border: '1px solid #3498db',
                    backgroundColor: '#3498db',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: '500',
                    fontSize: '12px',
                  }}
                >
                  Install
                </button>
              ) : showUpdate ? (
                <button
                  onClick={() => onUpdate?.(plugin.name)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '4px',
                    border: '1px solid #e67e22',
                    backgroundColor: '#e67e22',
                    color: '#fff',
                    cursor: 'pointer',
                    fontWeight: '500',
                    fontSize: '12px',
                  }}
                >
                  Update
                </button>
              ) : (
                <button
                  onClick={() => onToggle?.(plugin.name)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '4px',
                    border: `1px solid ${plugin.enabled ? '#e74c3c' : '#2ecc71'}`,
                    backgroundColor: 'transparent',
                    color: plugin.enabled ? '#e74c3c' : '#2ecc71',
                    cursor: 'pointer',
                    fontWeight: '500',
                    fontSize: '12px',
                  }}
                >
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
