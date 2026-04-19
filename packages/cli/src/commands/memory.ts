import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandTildePath } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

export function createMemoryCommand(): Command {
	const cmd = new Command("memory").description(
		"Manage Octopus AI memory system",
	);

	cmd
		.command("index <path>")
		.description("Index files at path into memory")
		.action(async (inputPath: string) => {
			try {
				const expanded = expandTildePath(inputPath);
				const stat = fs.statSync(expanded);

				const system = await bootstrap();
				const filePaths: string[] = [];

				if (stat.isFile()) {
					filePaths.push(expanded);
				} else if (stat.isDirectory()) {
					const entries = fs.readdirSync(expanded, { recursive: true });
					for (const entry of entries) {
						const fullPath = path.join(expanded, entry.toString());
						if (fs.statSync(fullPath).isFile()) {
							filePaths.push(fullPath);
						}
					}
				}

				console.log(chalk.cyan(`Indexing ${filePaths.length} file(s)...`));

				let indexed = 0;
				for (const filePath of filePaths) {
					try {
						const content = fs.readFileSync(filePath, "utf-8");
						if (content.trim().length === 0) continue;

						const chunks = splitIntoChunks(content, 1000);
						for (const chunk of chunks) {
							const embedding = await system.embedFn(chunk);
							await system.ltm.store({
								id: crypto.randomUUID(),
								type: "semantic",
								content: `Source: ${path.basename(filePath)}\n${chunk}`,
								embedding,
								importance: 0.5,
								accessCount: 0,
								lastAccessed: new Date(),
								createdAt: new Date(),
								associations: [],
								source: {},
								metadata: { filePath, fileName: path.basename(filePath) },
							});
							indexed++;
						}
					} catch {}
				}

				console.log(
					chalk.green(
						`✓ Indexed ${indexed} chunk(s) from ${filePaths.length} file(s)`,
					),
				);
				await system.shutdown();
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	cmd
		.command("search <query>")
		.description("Search memory for relevant content")
		.action(async (query: string) => {
			try {
				const system = await bootstrap();
				const items = await system.ltm.search(query, system.embedFn, {});

				if (items.length === 0) {
					console.log(chalk.yellow("No results found"));
				} else {
					console.log(chalk.cyan(`Found ${items.length} result(s):\n`));
					for (const item of items) {
						console.log(
							chalk.white(`  [${item.type}] ${item.content.slice(0, 120)}`),
						);
						console.log(
							chalk.gray(
								`    Importance: ${item.importance.toFixed(2)} | Accessed: ${item.accessCount} times`,
							),
						);
					}
				}

				await system.shutdown();
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	cmd
		.command("stats")
		.description("Show memory statistics")
		.action(async () => {
			try {
				const system = await bootstrap();
				const stmLoad = system.stm.getLoad();
				const stmTurns = system.stm.getContext().length;
				const ltmCount = await system.ltm.count();

				const allItems = await system.ltm.search("", system.embedFn, {});
				const typeCounts: Record<string, number> = {};
				for (const item of allItems) {
					typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
				}

				console.log(chalk.cyan.bold("\n📊 Memory Statistics\n"));
				console.log(chalk.white("Short-Term Memory:"));
				console.log(chalk.gray(`  Load:    ${stmLoad.toFixed(1)}%`));
				console.log(chalk.gray(`  Turns:   ${stmTurns}`));
				console.log();
				console.log(chalk.white("Long-Term Memory:"));
				console.log(chalk.gray(`  Total:   ${ltmCount} items`));

				if (Object.keys(typeCounts).length > 0) {
					console.log(chalk.gray("  Types:"));
					for (const [type, count] of Object.entries(typeCounts)) {
						console.log(chalk.gray(`    ${type}: ${count}`));
					}
				}

				console.log();
				await system.shutdown();
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	cmd
		.command("consolidate")
		.description("Force STM to LTM consolidation")
		.action(async () => {
			try {
				const system = await bootstrap();
				console.log(chalk.cyan("Running consolidation..."));
				const result = await system.memoryConsolidator.consolidate(system.stm);

				console.log(chalk.green("\n✓ Consolidation complete"));
				console.log(chalk.gray(`  Stored:       ${result.stored}`));
				console.log(chalk.gray(`  Updated:      ${result.updated}`));
				console.log(chalk.gray(`  Compressed:   ${result.compressed}`));
				console.log(chalk.gray(`  Forgotten:    ${result.forgotten}`));
				console.log(chalk.gray(`  Associations: ${result.associations}`));
				console.log();

				await system.shutdown();
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	cmd
		.command("forget <query>")
		.description("Remove memories matching a query")
		.action(async (query: string) => {
			try {
				const system = await bootstrap();
				const items = await system.ltm.search(query, system.embedFn, {});

				if (items.length === 0) {
					console.log(chalk.yellow("No matching memories found"));
					await system.shutdown();
					return;
				}

				console.log(
					chalk.cyan(`Found ${items.length} matching item(s), removing...`),
				);

				let removed = 0;
				for (const item of items) {
					await system.ltm.forget(item.id);
					removed++;
				}

				console.log(chalk.green(`✓ Removed ${removed} item(s)`));
				await system.shutdown();
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	cmd
		.command("export")
		.description("Export all memories as JSON to stdout")
		.action(async () => {
			try {
				const system = await bootstrap();
				const items = await system.ltm.search("", system.embedFn, {});

				const exportData = items.map((item) => ({
					id: item.id,
					type: item.type,
					content: item.content,
					importance: item.importance,
					accessCount: item.accessCount,
					lastAccessed: item.lastAccessed.toISOString(),
					createdAt: item.createdAt.toISOString(),
					associations: item.associations,
					source: item.source,
					metadata: item.metadata,
				}));

				console.log(JSON.stringify(exportData, null, 2));
				await system.shutdown();
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

function splitIntoChunks(text: string, maxChunkSize: number): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	let current = "";

	for (const line of lines) {
		if (current.length + line.length + 1 > maxChunkSize && current.length > 0) {
			chunks.push(current.trim());
			current = "";
		}
		current += `${line}\n`;
	}

	if (current.trim().length > 0) {
		chunks.push(current.trim());
	}

	return chunks;
}
