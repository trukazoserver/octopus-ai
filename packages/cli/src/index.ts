#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { createAgentCommand } from "./commands/agent.js";
import { createChannelsCommand } from "./commands/channels.js";
import { createChatCommand } from "./commands/chat.js";
import { createConfigCommand } from "./commands/config.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createMemoryCommand } from "./commands/memory.js";
import { createPluginsCommand } from "./commands/plugins.js";
import { createKanbanCommand } from "./commands/kanban.js";
import { createProvidersCommand } from "./commands/providers.js";
import { createSetupCommand } from "./commands/setup.js";
import { createSkillsCommand } from "./commands/skills.js";
import { createStartCommand, runStart } from "./commands/start.js";
import { createVertexCommand } from "./commands/vertex.js";

const program = new Command();

program
	.name("octopus")
	.description(
		"🐙 Octopus AI - Intelligent AI assistant with memory and skills",
	)
	.version("0.1.0")
	.option("--web", "Start or attach to Octopus and open the web dashboard")
	.option("--console", "Start or attach to Octopus and open the console TUI");

program.addCommand(createSetupCommand());
program.addCommand(createStartCommand());
program.addCommand(createChatCommand());
program.addCommand(createConfigCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createMemoryCommand());
program.addCommand(createSkillsCommand());
program.addCommand(createAgentCommand());
program.addCommand(createChannelsCommand());
program.addCommand(createPluginsCommand());
program.addCommand(createKanbanCommand());
program.addCommand(createVertexCommand());
program.addCommand(createProvidersCommand());

program.action(async (options: { web?: boolean; console?: boolean }) => {
	await runStart({
		open: options.web,
		console: !options.web,
		choice: false,
	});
});

program.exitOverride();

try {
	await program.parseAsync(process.argv);
} catch (err) {
	const error = err as { exitCode?: number };
	if (error.exitCode === 0) {
		process.exit(0);
	}
	console.error(
		chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`),
	);
	process.exit(1);
}
