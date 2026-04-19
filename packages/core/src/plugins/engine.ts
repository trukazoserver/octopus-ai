import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import type { PluginRegistry } from "./registry.js";
import type { ConversationContext, Plugin, PluginManifest } from "./types.js";

export class PluginEngine {
	private registry: PluginRegistry;

	constructor(registry: PluginRegistry) {
		this.registry = registry;
	}

	public async load(pluginPath: string): Promise<Plugin> {
		const manifestPath = path.join(pluginPath, "plugin.json");
		const manifestContent = await fs.readFile(manifestPath, "utf-8");
		const manifest = JSON.parse(manifestContent) as PluginManifest;

		const indexPath = path.join(pluginPath, "index.js");
		const indexUrl = url.pathToFileURL(indexPath).href;

		const module = await import(indexUrl);

		const plugin: Plugin = {
			manifest,
			commands: module.commands,
			mcpServers: module.mcpServers,
			onLoad: module.onLoad,
			onUnload: module.onUnload,
		};

		if (plugin.onLoad) {
			await plugin.onLoad();
		}

		this.registry.register(plugin);
		return plugin;
	}

	public async install(name: string): Promise<Plugin> {
		const homedir = os.homedir();
		const pluginDir = path.join(homedir, ".octopus", "plugins", name);
		return await this.load(pluginDir);
	}

	public resolveForContext(context: ConversationContext): Plugin[] {
		return this.registry.getAll();
	}
}
