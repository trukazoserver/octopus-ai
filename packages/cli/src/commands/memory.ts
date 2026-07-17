import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	ConfigLoader,
	type MemoryCandidate,
	expandTildePath,
} from "@octopus-ai/core";
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

				const serverUrl = await getActiveMemoryServerUrl();
				let indexed = 0;
				if (serverUrl) {
					indexed = await indexMemoryFiles(filePaths, async (payload) => {
						const response = await postJson<MemoryCreateResponse>(
							`${serverUrl}/api/memory/create`,
							payload,
						);
						return response.ok || response.result?.accepted === true;
					});
				} else {
					const system = await bootstrap();
					try {
						indexed = await indexMemoryFiles(filePaths, async (payload) => {
							const write = await system.memoryOrchestrator.write(payload);
							return write.accepted;
						});
					} finally {
						await system.shutdown();
					}
				}

				console.log(
					chalk.green(
						`✓ Indexed ${indexed} chunk(s) from ${filePaths.length} file(s)`,
					),
				);
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
				const serverUrl = await getActiveMemoryServerUrl();
				if (serverUrl) {
					const response = await getJson<MemorySearchResponse>(
						`${serverUrl}/api/memory/search?q=${encodeURIComponent(query)}`,
					);
					printSearchResults(extractMemoryItems(response.results));
					return;
				}

				const system = await bootstrap();
				try {
					const pack = await system.memoryOrchestrator.read(
						query,
						{
							tenantId: "local",
							userId: "owner",
							projectId: process.cwd(),
							agentRole: "cli-memory",
						},
						1500,
					);
					const itemById = new Map(
						pack.memories.map((memory) => [memory.item.id, memory.item]),
					);
					for (const item of await system.ltm.search(
						query,
						system.embedFn,
						{},
					)) {
						itemById.set(item.id, item);
					}
					printSearchResults(Array.from(itemById.values()).slice(0, 50));
				} finally {
					await system.shutdown();
				}
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
				const serverUrl = await getActiveMemoryServerUrl();
				if (serverUrl) {
					const stats = await getJson<MemoryStatsResponse>(
						`${serverUrl}/api/memory/stats`,
					);
					printStats(stats);
					return;
				}

				const system = await bootstrap();
				try {
					const allItems = await system.ltm.listAll(5000);
					const typeCounts: Record<string, number> = {};
					for (const item of allItems) {
						typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
					}
					printStats({
						shortTerm: {
							load: system.stm.getLoad(),
							count: system.stm.getContext().length,
						},
						longTerm: { count: await system.ltm.count() },
						localTypeCounts: typeCounts,
					});
				} finally {
					await system.shutdown();
				}
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
				const serverUrl = await getActiveMemoryServerUrl();
				if (serverUrl) {
					const search = await getJson<MemorySearchResponse>(
						`${serverUrl}/api/memory/search?q=${encodeURIComponent(query)}`,
					);
					const items = extractMemoryItems(search.results);
					if (items.length === 0) {
						console.log(chalk.yellow("No matching memories found"));
						return;
					}
					console.log(
						chalk.cyan(`Found ${items.length} matching item(s), removing...`),
					);
					let removed = 0;
					for (const item of items) {
						await postJson(`${serverUrl}/api/memory/forget`, {
							memoryId: item.id,
							reason: "cli_forget",
						});
						removed++;
					}
					console.log(chalk.green(`✓ Removed ${removed} item(s)`));
					return;
				}

				const system = await bootstrap();
				try {
					const items = await system.ltm.search(query, system.embedFn, {});

					if (items.length === 0) {
						console.log(chalk.yellow("No matching memories found"));
						return;
					}

					console.log(
						chalk.cyan(`Found ${items.length} matching item(s), removing...`),
					);

					let removed = 0;
					for (const item of items) {
						await system.memoryOrchestrator.forget(item.id, "cli_forget");
						removed++;
					}

					console.log(chalk.green(`✓ Removed ${removed} item(s)`));
				} finally {
					await system.shutdown();
				}
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
				const serverUrl = await getActiveMemoryServerUrl();
				if (serverUrl) {
					const response = await getJson<{ memories?: unknown[] }>(
						`${serverUrl}/api/memory/ltm/recent?limit=5000`,
					);
					console.log(JSON.stringify(response.memories ?? [], null, 2));
					return;
				}

				const system = await bootstrap();
				try {
					const items = await system.ltm.listAll(5000);

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
				} finally {
					await system.shutdown();
				}
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	const benchmark = cmd.command("benchmark").description("Import and run memory retrieval benchmarks");
	benchmark
		.command("import <file>")
		.requiredOption("--format <format>", "memops, longmemeval, or beam")
		.option("--name <name>", "Dataset display name")
		.action(async (file: string, options: { format: string; name?: string }) => {
			const format = options.format.toLowerCase();
			if (!["memops", "longmemeval", "beam"].includes(format)) throw new Error("Unsupported benchmark format");
			const expanded = expandTildePath(file);
			const content = fs.readFileSync(expanded, "utf8");
			const source = JSON.parse(content) as unknown;
			const payload = { name: options.name ?? path.basename(expanded), format, sourceName: path.basename(expanded), source };
			const serverUrl = await getActiveMemoryServerUrl();
			if (serverUrl) {
				console.log(JSON.stringify(await postJson(`${serverUrl}/api/memory/benchmarks/datasets`, payload), null, 2));
				return;
			}
			const system = await bootstrap();
			try {
				console.log(JSON.stringify(await system.memoryOrchestrator.importMemoryBenchmark({ ...payload, format: format as "memops" | "longmemeval" | "beam", sourceSha256: createHash("sha256").update(content).digest("hex") }), null, 2));
			} finally {
				await system.shutdown();
			}
		});
	benchmark.command("datasets").action(async () => {
		const serverUrl = await getActiveMemoryServerUrl();
		if (serverUrl) return console.log(JSON.stringify(await getJson(`${serverUrl}/api/memory/benchmarks/datasets`), null, 2));
		const system = await bootstrap();
		try { console.log(JSON.stringify(await system.memoryOrchestrator.listMemoryBenchmarkDatasets(), null, 2)); } finally { await system.shutdown(); }
	});
	benchmark
		.command("run <datasetId>")
		.option("--k <number>", "Retrieval cutoff", "10")
		.option("--condition <condition>", "no-memory, lexical-baseline, or octopus-isolated", "lexical-baseline")
		.action(async (datasetId: string, options: { k: string; condition: string }) => {
			const payload = { datasetId, k: Number(options.k), condition: options.condition };
			const serverUrl = await getActiveMemoryServerUrl();
			if (serverUrl) return console.log(JSON.stringify(await postJson(`${serverUrl}/api/memory/benchmarks/runs`, payload), null, 2));
			const system = await bootstrap();
			try { console.log(JSON.stringify(await system.memoryOrchestrator.createMemoryBenchmarkRun(datasetId, payload), null, 2)); } finally { await system.shutdown(); }
		});
	benchmark.command("runs").action(async () => {
		const serverUrl = await getActiveMemoryServerUrl();
		if (serverUrl) return console.log(JSON.stringify(await getJson(`${serverUrl}/api/memory/benchmarks/runs`), null, 2));
		const system = await bootstrap();
		try { console.log(JSON.stringify(await system.memoryOrchestrator.listMemoryBenchmarkRuns(), null, 2)); } finally { await system.shutdown(); }
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

type MemoryIndexPayload = MemoryCandidate;

type MemoryCreateResponse = {
	ok?: boolean;
	result?: { accepted?: boolean };
};

type CliMemoryItem = {
	id: string;
	type: string;
	content: string;
	importance?: number;
	accessCount?: number;
};

type MemorySearchResponse = {
	results?: unknown[];
};

type MemoryStatsResponse = {
	shortTerm?: { load?: number; count?: number };
	longTerm?: { count?: number };
	localTypeCounts?: Record<string, number>;
};

async function getActiveMemoryServerUrl(): Promise<string | null> {
	try {
		const config = new ConfigLoader().load();
		const host =
			config.server.host === "0.0.0.0" || config.server.host === "::"
				? "127.0.0.1"
				: config.server.host;
		const serverUrl = `http://${host}:${config.server.port}`;
		const response = await fetch(`${serverUrl}/api/status`, {
			signal: AbortSignal.timeout(1200),
		});
		if (!response.ok) return null;
		const status = (await response.json()) as { status?: string };
		return status.status === "running" ? serverUrl : null;
	} catch {
		return null;
	}
}

async function getJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Server request failed ${response.status}: ${text}`);
	}
	return JSON.parse(text) as T;
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15000),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Server request failed ${response.status}: ${text}`);
	}
	return JSON.parse(text) as T;
}

async function indexMemoryFiles(
	filePaths: string[],
	write: (payload: MemoryIndexPayload) => Promise<boolean>,
): Promise<number> {
	let indexed = 0;
	for (const filePath of filePaths) {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			if (content.trim().length === 0) continue;
			const fileStat = fs.statSync(filePath);
			const fileHash = cryptoHash(content);
			const chunks = splitIntoChunks(content, 1000);

			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				const payload = createIndexPayload({
					filePath,
					fileStat,
					fileHash,
					chunk: chunks[chunkIndex],
					chunkIndex,
					chunkCount: chunks.length,
				});
				if (await write(payload)) indexed++;
			}
		} catch {}
	}
	return indexed;
}

function createIndexPayload(args: {
	filePath: string;
	fileStat: fs.Stats;
	fileHash: string;
	chunk: string;
	chunkIndex: number;
	chunkCount: number;
}): MemoryIndexPayload {
	const fileName = path.basename(args.filePath);
	const content = `Source: ${fileName}\n${args.chunk}`;
	const sourceId = `file:${args.fileHash}:${args.chunkIndex}`;
	return {
		type: "semantic",
		content,
		sourceTrust: "external",
		scope: {
			tenantId: "local",
			userId: "owner",
			projectId: process.cwd(),
			sessionId: "cli-memory-index",
		},
		confidence: 0.65,
		importance: 0.5,
		source: {
			sourceId,
			sourceType: "document",
			channelId: "cli-memory-index",
			title: fileName,
			uri: `file://${args.filePath}`,
			quotedEvidence: args.chunk.slice(0, 1200),
			authorityScore: 0.55,
			metadata: {
				filePath: args.filePath,
				fileName,
				size: args.fileStat.size,
				mtime: args.fileStat.mtime.toISOString(),
				chunkIndex: args.chunkIndex,
				chunkCount: args.chunkCount,
				contentHash: args.fileHash,
			},
		},
		metadata: {
			filePath: args.filePath,
			fileName,
			chunkIndex: args.chunkIndex,
			chunkCount: args.chunkCount,
			contentHash: args.fileHash,
			entities: [{ name: fileName, type: "document" }],
		},
		evidence: {
			sourceType: "tool_output",
			sourceId,
			excerpt: args.chunk.slice(0, 1200),
		},
	};
}

function extractMemoryItems(results: unknown[] | undefined): CliMemoryItem[] {
	const items = new Map<string, CliMemoryItem>();
	for (const result of results ?? []) {
		const record = isRecord(result) ? result : undefined;
		const candidate = isRecord(record?.item) ? record.item : record;
		if (!isRecord(candidate)) continue;
		const id = typeof candidate.id === "string" ? candidate.id : undefined;
		const content =
			typeof candidate.content === "string" ? candidate.content : undefined;
		if (!id || !content) continue;
		items.set(id, {
			id,
			type: typeof candidate.type === "string" ? candidate.type : "unknown",
			content,
			importance:
				typeof candidate.importance === "number"
					? candidate.importance
					: undefined,
			accessCount:
				typeof candidate.accessCount === "number"
					? candidate.accessCount
					: undefined,
		});
	}
	return Array.from(items.values()).slice(0, 50);
}

function printSearchResults(items: CliMemoryItem[]): void {
	if (items.length === 0) {
		console.log(chalk.yellow("No results found"));
		return;
	}
	console.log(chalk.cyan(`Found ${items.length} result(s):\n`));
	for (const item of items) {
		console.log(chalk.white(`  [${item.type}] ${item.content.slice(0, 120)}`));
		console.log(
			chalk.gray(
				`    Importance: ${(item.importance ?? 0).toFixed(2)} | Accessed: ${item.accessCount ?? 0} times`,
			),
		);
	}
}

function printStats(stats: MemoryStatsResponse): void {
	console.log(chalk.cyan.bold("\n📊 Memory Statistics\n"));
	console.log(chalk.white("Short-Term Memory:"));
	console.log(
		chalk.gray(`  Load:    ${(stats.shortTerm?.load ?? 0).toFixed(1)}%`),
	);
	console.log(chalk.gray(`  Turns:   ${stats.shortTerm?.count ?? 0}`));
	console.log();
	console.log(chalk.white("Long-Term Memory:"));
	console.log(chalk.gray(`  Total:   ${stats.longTerm?.count ?? 0} items`));

	if (stats.localTypeCounts && Object.keys(stats.localTypeCounts).length > 0) {
		console.log(chalk.gray("  Types:"));
		for (const [type, count] of Object.entries(stats.localTypeCounts)) {
			console.log(chalk.gray(`    ${type}: ${count}`));
		}
	}

	console.log();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cryptoHash(content: string): string {
	return Buffer.from(content).toString("base64url").slice(0, 32);
}
