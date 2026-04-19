import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Plugin } from "@octopus-ai/core";

interface DataRecord {
	[key: string]: string | number | boolean | null;
}

interface DatasetMeta {
	name: string;
	rowCount: number;
	columns: string[];
	types: Record<string, string>;
}

const datasets: Map<string, DataRecord[]> = new Map();
const workspacePath = join(process.cwd(), ".data-workspace");

async function ensureWorkspace(): Promise<void> {
	try {
		await mkdir(workspacePath, { recursive: true });
	} catch {}
}

function parseCSV(text: string): DataRecord[] {
	const lines = text.trim().split("\n");
	if (lines.length < 2) return [];
	const headers = lines[0]
		.split(",")
		.map((h) => h.trim().replace(/^"|"$/g, ""));
	const records: DataRecord[] = [];
	for (let i = 1; i < lines.length; i++) {
		const values = lines[i]
			.split(",")
			.map((v) => v.trim().replace(/^"|"$/g, ""));
		const record: DataRecord = {};
		headers.forEach((h, idx) => {
			const raw = values[idx] ?? "";
			const num = Number(raw);
			record[h] = raw === "" ? null : Number.isNaN(num) ? raw : num;
		});
		records.push(record);
	}
	return records;
}

function inferTypes(records: DataRecord[]): Record<string, string> {
	if (records.length === 0) return {};
	const types: Record<string, string> = {};
	const keys = Object.keys(records[0]);
	for (const key of keys) {
		const vals = records.map((r) => r[key]).filter((v) => v !== null);
		if (vals.every((v) => typeof v === "number")) {
			types[key] = "number";
		} else if (vals.every((v) => typeof v === "boolean")) {
			types[key] = "boolean";
		} else {
			types[key] = "string";
		}
	}
	return types;
}

function computeStats(records: DataRecord[], column: string): string {
	const values = records
		.map((r) => r[column])
		.filter((v) => v !== null && typeof v === "number") as number[];
	if (values.length === 0) return `Column "${column}" has no numeric values.`;
	const sum = values.reduce((a, b) => a + b, 0);
	const mean = sum / values.length;
	const sorted = [...values].sort((a, b) => a - b);
	const median =
		sorted.length % 2 === 0
			? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
			: sorted[Math.floor(sorted.length / 2)];
	const min = sorted[0];
	const max = sorted[sorted.length - 1];
	const variance =
		values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
	const stddev = Math.sqrt(variance);
	const q1 = sorted[Math.floor(sorted.length * 0.25)];
	const q3 = sorted[Math.floor(sorted.length * 0.75)];

	return `Statistics for "${column}" (${values.length} values)
  Count:    ${values.length}
  Sum:      ${sum.toFixed(2)}
  Mean:     ${mean.toFixed(4)}
  Median:   ${median.toFixed(2)}
  Min:      ${min}
  Max:      ${max}
  Std Dev:  ${stddev.toFixed(4)}
  Variance: ${variance.toFixed(4)}
  Q1:       ${q1}
  Q3:       ${q3}
  IQR:      ${(q3 - q1).toFixed(2)}`;
}

function filterRecords(records: DataRecord[], filters: string[]): DataRecord[] {
	let filtered = records;
	for (const f of filters) {
		const match = f.match(/^(\w+)(==|!=|>=|<=|>|<)(.+)$/);
		if (!match) continue;
		const [, col, op, rawVal] = match;
		const numVal = Number(rawVal);
		const val = Number.isNaN(numVal) ? rawVal : numVal;
		filtered = filtered.filter((r) => {
			const v = r[col];
			if (v === null || v === undefined) return false;
			switch (op) {
				case "==":
					return v === null ? val === null : v === val;
				case "!=":
					return v === null ? val !== null : v !== val;
				case ">":
					return typeof v === "number" && typeof val === "number" && v > val;
				case "<":
					return typeof v === "number" && typeof val === "number" && v < val;
				case ">=":
					return typeof v === "number" && typeof val === "number" && v >= val;
				case "<=":
					return typeof v === "number" && typeof val === "number" && v <= val;
				default:
					return true;
			}
		});
	}
	return filtered;
}

function formatTable(records: DataRecord[], maxRows = 20): string {
	if (records.length === 0) return "No records.";
	const keys = Object.keys(records[0]);
	const colWidths = keys.map((k) =>
		Math.max(
			k.length,
			...records.slice(0, maxRows).map((r) => String(r[k] ?? "null").length),
		),
	);
	const header = keys.map((k, i) => k.padEnd(colWidths[i])).join(" | ");
	const sep = colWidths.map((w) => "-".repeat(w)).join("-+-");
	const rows = records
		.slice(0, maxRows)
		.map((r) =>
			keys
				.map((k, i) => String(r[k] ?? "null").padEnd(colWidths[i]))
				.join(" | "),
		);
	let output = `${header}\n${sep}\n${rows.join("\n")}`;
	if (records.length > maxRows)
		output += `\n... and ${records.length - maxRows} more rows`;
	return output;
}

const plugin: Plugin = {
	manifest: {
		name: "data",
		version: "1.0.0",
		description:
			"Data analysis, CSV import/export, statistics, filtering, and SQL-like queries",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/data-import",
			description:
				"Import a CSV file or inline CSV data. Usage: /data-import <name> <csv-data-or-filepath>",
			execute: async (args: string[]) => {
				const name = args[0];
				if (!name)
					return "Usage: /data-import <dataset-name> <csv-data-or-filepath>";
				const rest = args.slice(1).join(" ").trim();
				if (!rest)
					return "Usage: /data-import <dataset-name> <csv-data-or-filepath>";

				let csvText: string;
				try {
					const fileStat = await stat(rest);
					if (fileStat.isFile()) {
						csvText = await readFile(rest, "utf-8");
					} else {
						return `Path is not a file: ${rest}`;
					}
				} catch {
					csvText = rest;
				}

				const records = parseCSV(csvText);
				if (records.length === 0)
					return "No valid records found. Ensure first line is headers.";
				datasets.set(name, records);
				const types = inferTypes(records);
				const meta: DatasetMeta = {
					name,
					rowCount: records.length,
					columns: Object.keys(records[0]),
					types,
				};

				return `Dataset "${name}" imported successfully
Rows: ${meta.rowCount}
Columns: ${meta.columns.join(", ")}
Types: ${Object.entries(types)
					.map(([k, v]) => `${k}(${v})`)
					.join(", ")}
Preview:
${formatTable(records, 5)}`;
			},
		},
		{
			name: "/data-list",
			description: "List all loaded datasets. Usage: /data-list",
			execute: async () => {
				if (datasets.size === 0)
					return "No datasets loaded. Use /data-import to load one.";
				return Array.from(datasets.entries())
					.map(([name, records]) => {
						const types = inferTypes(records);
						return `[${name}] ${records.length} rows, columns: ${Object.keys(records[0]).join(", ")}\n  Types: ${Object.entries(
							types,
						)
							.map(([k, v]) => `${k}(${v})`)
							.join(", ")}`;
					})
					.join("\n\n");
			},
		},
		{
			name: "/data-stats",
			description:
				"Compute statistics for a numeric column. Usage: /data-stats <dataset> <column>",
			execute: async (args: string[]) => {
				const name = args[0];
				const column = args[1];
				if (!name || !column) return "Usage: /data-stats <dataset> <column>";
				const records = datasets.get(name);
				if (!records)
					return `Dataset "${name}" not found. Use /data-list to see available datasets.`;
				if (!records[0] || !(column in records[0]))
					return `Column "${column}" not found. Available: ${Object.keys(records[0]).join(", ")}`;
				return computeStats(records, column);
			},
		},
		{
			name: "/data-query",
			description:
				"Query dataset with filters. Usage: /data-query <dataset> [col==val] [col>val] ...",
			execute: async (args: string[]) => {
				const name = args[0];
				if (!name)
					return "Usage: /data-query <dataset> [filter1] [filter2] ...";
				const records = datasets.get(name);
				if (!records)
					return `Dataset "${name}" not found. Use /data-list to see available datasets.`;
				const filters = args.slice(1);
				const filtered =
					filters.length > 0 ? filterRecords(records, filters) : records;
				if (filtered.length === 0) return "No records match the filters.";
				return `Query results (${filtered.length} of ${records.length} records):\n${formatTable(filtered)}`;
			},
		},
		{
			name: "/data-export",
			description:
				"Export dataset as CSV. Usage: /data-export <dataset> [--save <filepath>]",
			execute: async (args: string[]) => {
				const name = args[0];
				if (!name) return "Usage: /data-export <dataset> [--save <filepath>]";
				const records = datasets.get(name);
				if (!records)
					return `Dataset "${name}" not found. Use /data-list to see available datasets.`;
				if (records.length === 0) return "Dataset is empty.";

				const keys = Object.keys(records[0]);
				const header = keys.join(",");
				const rows = records.map((r) =>
					keys
						.map((k) => {
							const v = r[k];
							const s = String(v ?? "");
							return s.includes(",") || s.includes('"')
								? `"${s.replace(/"/g, '""')}"`
								: s;
						})
						.join(","),
				);
				const csv = `${header}\n${rows.join("\n")}`;

				const saveIdx = args.indexOf("--save");
				if (saveIdx !== -1 && args[saveIdx + 1]) {
					const filePath = args[saveIdx + 1];
					await ensureWorkspace();
					const fullPath =
						filePath.startsWith("/") || filePath.includes(":")
							? filePath
							: join(workspacePath, filePath);
					await writeFile(fullPath, csv, "utf-8");
					return `Exported ${records.length} rows to ${fullPath}`;
				}
				return `CSV Export (${records.length} rows):\n${csv.slice(0, 3000)}${csv.length > 3000 ? "\n... truncated" : ""}`;
			},
		},
		{
			name: "/data-summary",
			description:
				"Get a full summary of a dataset with stats for all numeric columns. Usage: /data-summary <dataset>",
			execute: async (args: string[]) => {
				const name = args[0];
				if (!name) return "Usage: /data-summary <dataset>";
				const records = datasets.get(name);
				if (!records)
					return `Dataset "${name}" not found. Use /data-list to see available datasets.`;
				if (records.length === 0) return "Dataset is empty.";

				const types = inferTypes(records);
				const keys = Object.keys(records[0]);
				let output = `Dataset: ${name}\nRows: ${records.length}\nColumns: ${keys.length}\n\n`;

				for (const key of keys) {
					if (types[key] === "number") {
						output += `${computeStats(records, key)}\n\n`;
					} else {
						const vals = records
							.map((r) => r[key])
							.filter((v) => v !== null) as string[];
						const unique = new Set(vals);
						output += `Column "${key}" (string): ${vals.length} values, ${unique.size} unique\n`;
						if (unique.size <= 10) {
							output += `  Values: ${Array.from(unique).join(", ")}\n`;
						} else {
							const topVals = vals.reduce<Record<string, number>>((acc, v) => {
								acc[String(v)] = (acc[String(v)] || 0) + 1;
								return acc;
							}, {});
							const top = Object.entries(topVals)
								.sort((a, b) => b[1] - a[1])
								.slice(0, 5);
							output += `  Top 5: ${top.map(([v, c]) => `${v}(${c})`).join(", ")}\n`;
						}
						output += "\n";
					}
				}
				return output.trim();
			},
		},
		{
			name: "/data-correlation",
			description:
				"Compute Pearson correlation between two numeric columns. Usage: /data-correlation <dataset> <col1> <col2>",
			execute: async (args: string[]) => {
				const name = args[0];
				const col1 = args[1];
				const col2 = args[2];
				if (!name || !col1 || !col2)
					return "Usage: /data-correlation <dataset> <col1> <col2>";
				const records = datasets.get(name);
				if (!records) return `Dataset "${name}" not found.`;

				const pairs = records
					.map((r) => [Number(r[col1]), Number(r[col2])])
					.filter(([a, b]) => !Number.isNaN(a) && !Number.isNaN(b)) as [
					number,
					number,
				][];
				if (pairs.length < 2)
					return "Not enough numeric pairs to compute correlation.";

				const n = pairs.length;
				const meanX = pairs.reduce((s, [x]) => s + x, 0) / n;
				const meanY = pairs.reduce((s, [, y]) => s + y, 0) / n;
				let num = 0;
				let denX = 0;
				let denY = 0;
				for (const [x, y] of pairs) {
					const dx = x - meanX;
					const dy = y - meanY;
					num += dx * dy;
					denX += dx * dx;
					denY += dy * dy;
				}
				const corr =
					denX === 0 || denY === 0 ? 0 : num / Math.sqrt(denX * denY);
				const strength =
					Math.abs(corr) >= 0.8
						? "strong"
						: Math.abs(corr) >= 0.5
							? "moderate"
							: "weak";
				const direction = corr >= 0 ? "positive" : "negative";
				return `Correlation: ${col1} vs ${col2}
Pearson r: ${corr.toFixed(4)}
Strength:  ${strength} ${direction} correlation
Pairs:     ${n}`;
			},
		},
	],
	onLoad: async () => {
		await ensureWorkspace();
	},
};

export default plugin;
