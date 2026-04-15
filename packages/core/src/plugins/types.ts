export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SlashCommand {
  name: string;
  description: string;
  execute: (args: string[]) => Promise<string>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  dependencies?: string[];
}

export interface Plugin {
  manifest: PluginManifest;
  commands?: SlashCommand[];
  mcpServers?: MCPServerConfig[];
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
}

export interface ConversationContext {
  channelId: string;
  activeTask?: string;
  keywords: string[];
}
