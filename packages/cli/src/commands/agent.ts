import chalk from "chalk";
import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

export function createAgentCommand(): Command {
	return new Command("agent")
		.description("Send a message directly to the agent")
		.option("-m, --message <message>", "Message to send to the agent")
		.option("--model <model>", "Override the default model")
		.option("--stream", "Stream the response")
		.action(
			async (options: {
				message?: string;
				model?: string;
				stream?: boolean;
			}) => {
				if (!options.message) {
					console.error(chalk.red("Error: --message is required"));
					process.exit(1);
				}

				try {
					const system = await bootstrap();

					if (options.stream) {
						process.stdout.write(chalk.gray("Streaming response...\n"));
						for await (const chunk of system.agentRuntime.processMessageStream(
							options.message,
						)) {
							process.stdout.write(chunk);
						}
						console.log();
					} else {
						const response = await system.agentRuntime.processMessage(
							options.message,
						);
						console.log(response);
					}

					await system.shutdown();
				} catch (err) {
					console.error(
						chalk.red("Error:"),
						err instanceof Error ? err.message : String(err),
					);
					process.exit(1);
				}
			},
		);
}
