# Plugin System

## Plugin Structure

A plugin is a directory with:

```
my-plugin/
├── plugin.json    # Manifest
└── index.js       # Entry point (ESM)
```

## Manifest (plugin.json)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "Your Name",
  "dependencies": []
}
```

## Plugin API

```typescript
import type { Plugin } from '@octopus-ai/core';

const plugin: Plugin = {
  manifest: {
    name: 'my-plugin',
    version: '1.0.0',
    description: 'My custom plugin',
    author: 'developer',
  },
  commands: [
    {
      name: '/my-command',
      description: 'Does something useful',
      execute: async (args) => {
        return `Result: ${args.join(' ')}`;
      },
    },
  ],
  mcpServers: [
    {
      command: 'node',
      args: ['mcp-server.js'],
    },
  ],
  onLoad: async () => {
    console.log('Plugin loaded');
  },
  onUnload: async () => {
    console.log('Plugin unloaded');
  },
};

export default plugin;
```

## Marketplace

```bash
# Search
octopus-ai plugins search "database"

# Install
octopus-ai plugins install my-plugin

# Update
octopus-ai plugins update my-plugin

# Uninstall
octopus-ai plugins uninstall my-plugin
```
