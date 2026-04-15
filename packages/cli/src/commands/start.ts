import { Command } from "commander";
import chalk from "chalk";
import { bootstrap } from "../bootstrap.js";
import { TransportServer } from "@octopus-ai/core/dist/transport/server.js";
import { MessageType } from "@octopus-ai/core/dist/transport/protocol.js";

export function createStartCommand(): Command {
  return new Command("start")
    .description("Start the Octopus AI server")
    .option("--channel <name>", "Start only a specific channel")
    .action(async (options: { channel?: string }) => {
      console.log(chalk.cyan.bold("\n🐙 Starting Octopus AI Server...\n"));

      let system: Awaited<ReturnType<typeof bootstrap>> | null = null;
      let server: TransportServer | null = null;

      const shutdown = async (signal: string) => {
        console.log(chalk.yellow(`\nReceived ${signal}, shutting down...`));

        if (server) {
          await server.stop();
          console.log(chalk.green("  ✓ Transport server stopped"));
        }

        if (system) {
          await system.shutdown();
          console.log(chalk.green("  ✓ Systems shut down"));
        }

        console.log(chalk.green("\nGoodbye! 👋\n"));
        process.exit(0);
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

      try {
        system = await bootstrap();

        const enabledChannels: string[] = [];
        const channels = system.config.channels;
        for (const [name, ch] of Object.entries(channels)) {
          if (ch.enabled) {
            if (options.channel && options.channel !== name) continue;
            enabledChannels.push(name);
            system.connectionManager.registerChannel(name);
          }
        }

        server = new TransportServer({
          port: system.config.server.port,
          host: system.config.server.host,
        });

        server.onMessage((clientId, message) => {
          void (async () => {
            try {
              const payload = message.payload as { message?: string; channelId?: string };
              if (payload?.message) {
                const response = await system!.agentRuntime.processMessage(
                  payload.message,
                  payload.channelId,
                );
                server!.send(clientId, {
                  id: message.id,
                  type: MessageType.response,
                  channel: message.channel,
                  payload: { response },
                  timestamp: Date.now(),
                });
              }
            } catch {
              server!.send(clientId, {
                id: message.id,
                type: MessageType.error,
                channel: message.channel,
                payload: { error: "Failed to process message" },
                timestamp: Date.now(),
              });
            }
          })();
        });

        await server.start();

        system.connectionManager.startHealthMonitor(async (_channelId: string) => {
          return true;
        });

        console.log(chalk.green("  ✓ Systems initialized"));
        console.log(
          chalk.green("  ✓ Transport server started"),
        );
        console.log(
          chalk.green("  ✓ Health monitoring active"),
        );

        console.log(chalk.cyan("\n  Server Info:"));
        console.log(
          chalk.gray(`    Port:       ${system.config.server.port}`),
        );
        console.log(
          chalk.gray(`    Host:       ${system.config.server.host}`),
        );
        console.log(
          chalk.gray(`    Transport:  ${system.config.server.transport}`),
        );
        console.log(
          chalk.gray(
            `    AI Provider: ${system.config.ai.default}`,
          ),
        );

        if (enabledChannels.length > 0) {
          console.log(
            chalk.gray(
              `    Channels:   ${enabledChannels.join(", ")}`,
            ),
          );
        } else {
          console.log(
            chalk.gray("    Channels:   none enabled"),
          );
        }

        console.log(
          chalk.green(
            `\n  Server running at ws://${system.config.server.host}:${system.config.server.port}`,
          ),
        );
        console.log(
          chalk.gray("  Press Ctrl+C to stop\n"),
        );

        await new Promise(() => {});
      } catch (err) {
        console.error(
          chalk.red("\n✗ Failed to start server:"),
          err instanceof Error ? err.message : String(err),
        );
        if (server) await server.stop();
        if (system) await system.shutdown();
        process.exit(1);
      }
    });
}
