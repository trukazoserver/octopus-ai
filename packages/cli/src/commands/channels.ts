import { Command } from "commander";
import chalk from "chalk";
import { bootstrap } from "../bootstrap.js";
import { ConfigLoader } from "@octopus-ai/core/dist/config/loader.js";

export function createChannelsCommand(): Command {
  const cmd = new Command("channels").description("Manage communication channels");

  cmd
    .command("list")
    .description("List configured channels")
    .action(async () => {
      try {
        const system = await bootstrap();
        const channels = system.config.channels;

        console.log(chalk.cyan.bold("\n📡 Channels\n"));
        for (const [name, ch] of Object.entries(channels)) {
          const isEnabled = (ch as { enabled: boolean }).enabled;
          const status = isEnabled ? chalk.green("enabled") : chalk.gray("disabled");
          console.log(`  ${name.padEnd(15)} ${status}`);
        }
        console.log();
        await system.shutdown();
        process.exit(0);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("status")
    .description("Show channel connection status")
    .action(async () => {
      try {
        const system = await bootstrap();
        const channels = system.config.channels;

        console.log(chalk.cyan.bold("\n📡 Channel Status\n"));
        for (const [name, ch] of Object.entries(channels)) {
          const isEnabled = (ch as { enabled: boolean }).enabled;
          if (!isEnabled) {
            console.log(
              `  ${name.padEnd(15)} ${chalk.gray("disabled").padEnd(12)} ${chalk.gray("—")}`
            );
            continue;
          }

          const managed = system.connectionManager.getChannelStatus(name);
          let isHealthy = false;
          let latency = 0;
          let cbStateStr = "closed";

          if (managed) {
            cbStateStr = managed.circuitBreaker.state;
            const healthStatus = (system.connectionManager as any).healthMonitor?.getStatus(name);
            if (healthStatus) {
              isHealthy = healthStatus.healthy;
              latency = healthStatus.latency;
            }
          }

          const healthStr = isHealthy ? chalk.green("healthy") : chalk.red("unhealthy");
          const latencyStr = `${latency}ms`;
          
          let cbStr = "";
          if (cbStateStr === "open") {
            cbStr = chalk.red("CB: open");
          } else if (cbStateStr === "half-open") {
            cbStr = chalk.yellow("CB: half-open");
          } else {
            cbStr = chalk.gray("CB: closed");
          }

          console.log(
            `  ${name.padEnd(15)} ${chalk.green("enabled").padEnd(12)} ${healthStr.padEnd(18)} Latency: ${latencyStr.padEnd(8)} ${cbStr}`
          );
        }
        console.log();
        await system.shutdown();
        process.exit(0);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("enable <channel>")
    .description("Enable a communication channel")
    .action(async (channel: string) => {
      try {
        const system = await bootstrap();
        const channels = system.config.channels as Record<string, { enabled: boolean }>;

        if (!(channel in channels)) {
          console.error(chalk.red(`Error: Channel '${channel}' not found in configuration.`));
          await system.shutdown();
          process.exit(1);
        }

        channels[channel].enabled = true;
        const loader = new ConfigLoader();
        loader.save(system.config);

        console.log(chalk.green(`✔ Channel '${channel}' enabled.`));
        await system.shutdown();
        process.exit(0);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  cmd
    .command("disable <channel>")
    .description("Disable a communication channel")
    .action(async (channel: string) => {
      try {
        const system = await bootstrap();
        const channels = system.config.channels as Record<string, { enabled: boolean }>;

        if (!(channel in channels)) {
          console.error(chalk.red(`Error: Channel '${channel}' not found in configuration.`));
          await system.shutdown();
          process.exit(1);
        }

        channels[channel].enabled = false;
        const loader = new ConfigLoader();
        loader.save(system.config);

        console.log(chalk.green(`✔ Channel '${channel}' disabled.`));
        await system.shutdown();
        process.exit(0);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  return cmd;
}
