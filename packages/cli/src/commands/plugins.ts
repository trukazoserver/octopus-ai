import { Command } from "commander";
import chalk from "chalk";
import * as os from "os";
import * as path from "path";
import { bootstrap } from "../bootstrap.js";

export function createPluginsCommand(): Command {
  const cmd = new Command("plugins").description("Manage Octopus AI plugins");

  cmd
    .command("list")
    .description("List installed plugins")
    .action(async () => {
      try {
        const system = await bootstrap();
        const plugins = system.pluginRegistry.getAll();

        console.log(chalk.cyan.bold("\n🔌 Installed Plugins\n"));

        if (plugins.length === 0) {
          console.log(chalk.yellow("  No plugins installed"));
        } else {
          for (const plugin of plugins) {
            const commands = plugin.commands?.map((c) => c.name).join(", ") || "none";
            console.log(chalk.white(`  ${plugin.manifest.name}`) + chalk.gray(` v${plugin.manifest.version}`));
            console.log(chalk.gray(`    ${plugin.manifest.description}`));
            console.log(chalk.gray(`    Author: ${plugin.manifest.author} | Commands: ${commands}`));
          }
        }

        const config = system.config;
        console.log(chalk.white("\n  Builtin:"));
        for (const name of config.plugins.builtin) {
          console.log(chalk.green(`    ✓ ${name}`));
        }

        console.log();
        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("search <query>")
    .description("Search available plugins in the marketplace")
    .option("-l, --limit <number>", "Max results", "20")
    .action(async (query: string, opts: { limit: string }) => {
      try {
        const system = await bootstrap();
        const results = await system.pluginMarketplace.search(query, {
          limit: parseInt(opts.limit, 10),
        });

        console.log(chalk.cyan.bold(`\n🔍 Plugin Search: "${query}"\n`));

        if (results.plugins.length === 0) {
          console.log(chalk.yellow("  No plugins found"));
        } else {
          for (const plugin of results.plugins) {
            const installed = system.pluginRegistry.get(plugin.name) ? chalk.green(" [installed]") : "";
            console.log(chalk.white(`  ${plugin.name}`) + chalk.gray(` v${plugin.version}`) + installed);
            console.log(chalk.gray(`    ${plugin.description}`));
            console.log(chalk.gray(`    Author: ${plugin.author} | Downloads: ${plugin.downloads} | Rating: ${plugin.rating.toFixed(1)}⭐`));
            if (plugin.tags.length > 0) {
              console.log(chalk.gray(`    Tags: ${plugin.tags.join(", ")}`));
            }
          }
        }

        console.log(chalk.gray(`\n  Showing ${results.plugins.length} of ${results.total} results\n`));
        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("install <name>")
    .description("Install a plugin from the marketplace")
    .option("-v, --version <version>", "Specific version to install")
    .action(async (name: string, opts: { version?: string }) => {
      try {
        const system = await bootstrap();
        console.log(chalk.cyan(`Installing plugin '${name}'...`));

        const result = await system.pluginMarketplace.install(name, opts.version);

        if (result.success) {
          console.log(chalk.green(`\n✓ ${result.message}`));
        } else {
          console.log(chalk.red(`\n✗ ${result.message}`));
        }

        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("uninstall <name>")
    .description("Uninstall a plugin")
    .action(async (name: string) => {
      try {
        const system = await bootstrap();
        console.log(chalk.cyan(`Uninstalling plugin '${name}'...`));

        const result = await system.pluginMarketplace.uninstall(name);

        if (result.success) {
          console.log(chalk.green(`\n✓ ${result.message}`));
        } else {
          console.log(chalk.red(`\n✗ ${result.message}`));
        }

        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("update [name]")
    .description("Update a plugin or all plugins")
    .action(async (name?: string) => {
      try {
        const system = await bootstrap();

        if (name) {
          console.log(chalk.cyan(`Updating plugin '${name}'...`));
          const result = await system.pluginMarketplace.update(name);
          if (result.success) {
            console.log(chalk.green(`\n✓ ${result.message}`));
          } else {
            console.log(chalk.yellow(`\n  ${result.message}`));
          }
        } else {
          console.log(chalk.cyan("Checking for plugin updates...\n"));
          const updates = await system.pluginMarketplace.getInstalledWithUpdates();
          const withUpdates = updates.filter((u) => u.hasUpdate);

          if (withUpdates.length === 0) {
            console.log(chalk.green("  All plugins are up to date"));
          } else {
            for (const u of withUpdates) {
              console.log(chalk.white(`  ${u.name}: ${u.installed} → ${u.latest}`));
              const result = await system.pluginMarketplace.update(u.name);
              console.log(result.success ? chalk.green(`    ✓ Updated`) : chalk.red(`    ✗ ${result.message}`));
            }
          }
        }

        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("info <name>")
    .description("Show detailed plugin information")
    .action(async (name: string) => {
      try {
        const system = await bootstrap();
        const info = await system.pluginMarketplace.info(name);

        if (!info) {
          console.log(chalk.yellow(`Plugin '${name}' not found in marketplace`));
          await system.shutdown();
          return;
        }

        console.log(chalk.cyan.bold(`\n📦 Plugin: ${info.name}\n`));
        console.log(chalk.white("  Version:    "), chalk.gray(info.version));
        console.log(chalk.white("  Author:     "), chalk.gray(info.author));
        console.log(chalk.white("  Description:"), chalk.gray(info.description));
        console.log(chalk.white("  Downloads:  "), chalk.gray(String(info.downloads)));
        console.log(chalk.white("  Rating:     "), chalk.gray(`${info.rating.toFixed(1)} / 5.0`));
        console.log(chalk.white("  Size:       "), chalk.gray(info.size));
        console.log(chalk.white("  Updated:    "), chalk.gray(info.updatedAt));
        if (info.tags.length > 0) {
          console.log(chalk.white("  Tags:       "), chalk.gray(info.tags.join(", ")));
        }

        const installed = system.pluginRegistry.get(name);
        if (installed) {
          console.log(chalk.green(`\n  ✓ Installed (v${installed.manifest.version})`));
        }

        console.log();
        await system.shutdown();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  return cmd;
}
