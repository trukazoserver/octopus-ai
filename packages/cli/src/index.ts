#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { createSetupCommand } from "./commands/setup.js";
import { createStartCommand } from "./commands/start.js";
import { createChatCommand } from "./commands/chat.js";
import { createConfigCommand } from "./commands/config.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createMemoryCommand } from "./commands/memory.js";
import { createSkillsCommand } from "./commands/skills.js";
import { createAgentCommand } from "./commands/agent.js";
import { createChannelsCommand } from "./commands/channels.js";
import { createPluginsCommand } from "./commands/plugins.js";

const program = new Command();

program
  .name("octopus-ai")
  .description("🐙 Octopus AI - Intelligent AI assistant with memory and skills")
  .version("0.1.0");

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

program.action(() => {
  program.help();
});

program.exitOverride();

try {
  program.parse(process.argv);
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
