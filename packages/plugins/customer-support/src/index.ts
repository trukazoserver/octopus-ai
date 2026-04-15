import type { Plugin } from '@octopus-ai/core';

export const customerSupportPlugin: Plugin = {
  manifest: {
    name: 'Customer Support Plugin',
    version: '1.0.0',
    description: 'Provides customer support ticket triage tools.',
    author: 'Octopus'
  },
  commands: [
    {
      name: 'ticket-triage',
      description: 'Triage support tickets.',
      execute: async (args: string[]) => {
        return 'Triage support tickets.';
      }
    }
  ],
  onLoad: async () => {
    console.log('Customer Support plugin loaded.');
  }
};

export default customerSupportPlugin;
