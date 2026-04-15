import type { Plugin } from '@octopus-ai/core';

export const salesPlugin: Plugin = {
  manifest: {
    name: 'Sales Plugin',
    version: '1.0.0',
    description: 'Provides sales prospecting and management tools.',
    author: 'Octopus'
  },
  commands: [
    {
      name: 'prospect',
      description: 'Sales prospecting initialized.',
      execute: async (args: string[]) => {
        return 'Sales prospecting initialized.';
      }
    }
  ],
  onLoad: async () => {
    console.log('Sales plugin loaded.');
  }
};

export default salesPlugin;
