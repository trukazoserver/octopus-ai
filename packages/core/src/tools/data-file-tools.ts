import { open, readFile, realpath, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import type { Database, SqlJsStatic } from "sql.js";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import type { ToolDefinition, ToolErrorCode, ToolResult } from "./registry.js";

const MAX_SQLITE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_ROWS = 100_000;
const MAX_RESULT_ROWS = 1_000;
const MAX_TABLES = 200;
const MAX_CELL_CHARS = 20_000;
const SQLITE_HEADER = "SQLite format 3\0";

type DataFormat = "sqlite" | "csv" | "tsv" | "json";
type JsonObject = Record<string, unknown>;

interface LoadedRows {
	format: "csv" | "tsv" | "json";
	tableRef: string;
	rows: JsonObject[];
	columns: string[];
}

interface PathPolicy {
	resolveInput: (rawPath: string) => Promise<string>;
}

class DataToolError extends Error {
	constructor(
		message: string,
		readonly code: ToolErrorCode = "INVALID_ARGUMENTS",
	) {
		super(message);
	}
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

export function createDataFileTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	const policy = createPathPolicy(allowedPaths, workspaceDir);

	const inspectTool: ToolDefinition = {
		name: "data_inspect",
		description:
			"Inspect a local SQLite, CSV, TSV, or JSON data file without modifying it. Returns schema, counts, samples, and stable table/row references.",
		managesOwnPathPolicy: true,
		parameters: {
			path: {
				type: "string",
				description: "Input data file path",
				required: true,
			},
			limit: {
				type: "number",
				description: "Maximum sample rows, default 20, max 100",
				required: false,
			},
		},
		handler: async (params): Promise<ToolResult> =>
			wrapResult("inspect", async () => {
				const filePath = await policy.resolveInput(
					requiredString(params.path, "path"),
				);
				const size = await checkedFileSize(filePath);
				const format = detectFormat(filePath, await readPrefix(filePath));
				const limit = clampInt(params.limit, 1, 100, 20);

				if (format === "sqlite") {
					assertFileSize(size, MAX_SQLITE_BYTES, "SQLite");
					const buffer = await readFileLimited(filePath, MAX_SQLITE_BYTES);
					return inspectSqlite(filePath, size, buffer, limit);
				}

				assertFileSize(size, MAX_TEXT_BYTES, format.toUpperCase());
				const loaded = await loadRows(filePath, format);
				return {
					schemaVersion: "octopus.data.v1",
					operation: "inspect",
					file: { path: filePath, format, size },
					table: {
						ref: loaded.tableRef,
						rowCount: loaded.rows.length,
						columns: inferColumns(loaded.rows, loaded.columns),
					},
					rows: referencedRows(loaded, loaded.rows.slice(0, limit), 0),
					page: createPage(
						0,
						limit,
						Math.min(limit, loaded.rows.length),
						loaded.rows.length,
					),
				};
			}),
	};

	const queryTool: ToolDefinition = {
		name: "data_query",
		description:
			"Query a local data file read-only. SQLite accepts one safe SELECT, WITH, or read-only PRAGMA statement. CSV, TSV, and JSON accept basic filters, selected columns, offset, and limit.",
		managesOwnPathPolicy: true,
		parameters: {
			path: {
				type: "string",
				description: "Input data file path",
				required: true,
			},
			sql: {
				type: "string",
				description: "SQLite SELECT, WITH, or safe read-only PRAGMA statement",
				required: false,
			},
			params: {
				type: "array",
				description: "Optional positional SQLite bind parameters",
				required: false,
			},
			filters: {
				type: "object",
				description:
					"CSV/TSV/JSON filters. Scalar values mean equality; operators: $eq, $ne, $contains, $gt, $gte, $lt, $lte, $in",
				required: false,
			},
			columns: {
				type: "array",
				description: "Optional CSV/TSV/JSON columns to return",
				required: false,
			},
			offset: {
				type: "number",
				description: "Rows to skip, default 0",
				required: false,
			},
			limit: {
				type: "number",
				description: "Maximum rows, default 100, max 1000",
				required: false,
			},
		},
		handler: async (params): Promise<ToolResult> =>
			wrapResult("query", async () => {
				const filePath = await policy.resolveInput(
					requiredString(params.path, "path"),
				);
				const size = await checkedFileSize(filePath);
				const format = detectFormat(filePath, await readPrefix(filePath));
				const offset = clampInt(params.offset, 0, MAX_SOURCE_ROWS, 0);
				const limit = clampInt(params.limit, 1, MAX_RESULT_ROWS, 100);

				if (format === "sqlite") {
					assertFileSize(size, MAX_SQLITE_BYTES, "SQLite");
					const sql = requiredString(params.sql, "sql");
					const bindParams = parseBindParams(params.params);
					const buffer = await readFileLimited(filePath, MAX_SQLITE_BYTES);
					return querySqlite(
						filePath,
						size,
						buffer,
						sql,
						bindParams,
						offset,
						limit,
					);
				}

				if (params.sql !== undefined) {
					throw new DataToolError("sql is only supported for SQLite files");
				}
				assertFileSize(size, MAX_TEXT_BYTES, format.toUpperCase());
				const loaded = await loadRows(filePath, format);
				const filters = parseFilters(params.filters);
				const columns = parseColumns(params.columns, loaded.columns);
				const matches = loaded.rows
					.map((row, sourceIndex) => ({ row, sourceIndex }))
					.filter(({ row }) => matchesFilters(row, filters));
				const pageRows = matches
					.slice(offset, offset + limit)
					.map(({ row, sourceIndex }) => ({
						ref: `${loaded.tableRef}/row:${sourceIndex + 1}`,
						values: normalizeRow(columns ? selectColumns(row, columns) : row),
					}));
				return {
					schemaVersion: "octopus.data.v1",
					operation: "query",
					file: { path: filePath, format, size },
					tableRef: loaded.tableRef,
					columns: columns ?? loaded.columns,
					rows: pageRows,
					page: createPage(offset, limit, pageRows.length, matches.length),
					filters,
				};
			}),
	};

	return [inspectTool, queryTool];
}

async function inspectSqlite(
	filePath: string,
	size: number,
	buffer: Buffer,
	limit: number,
): Promise<JsonObject> {
	return withSqlite(buffer, async (db) => {
		const entries = db.exec(
			"SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
		)[0];
		const values = entries?.values ?? [];
		if (values.length > MAX_TABLES) {
			throw new DataToolError(
				`SQLite file has more than ${MAX_TABLES} tables/views`,
			);
		}
		const tables = values.map((value) => {
			const name = String(value[0]);
			const type = String(value[1]) as "table" | "view";
			const tableRef = sqliteTableRef(name);
			const columns =
				db.exec(`PRAGMA table_info(${quoteIdentifier(name)})`)[0]?.values ?? [];
			const countResult =
				type === "table"
					? db.exec(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`)
					: [];
			return {
				ref: tableRef,
				name,
				type,
				rowCount:
					type === "table" ? Number(countResult[0]?.values[0]?.[0] ?? 0) : null,
				columns: columns.map((column) => ({
					position: Number(column[0]),
					name: String(column[1]),
					type: String(column[2] ?? ""),
					notNull: Number(column[3]) === 1,
					defaultValue: normalizeValue(column[4]),
					primaryKeyPosition: Number(column[5]),
				})),
				schema: truncateText(String(value[2] ?? "")),
			};
		});

		const samples: JsonObject[] = [];
		for (const table of tables.filter((item) => item.type === "table")) {
			if (samples.length >= limit) break;
			const remaining = limit - samples.length;
			const statement = db.prepare(
				`SELECT * FROM ${quoteIdentifier(String(table.name))} LIMIT ${remaining}`,
			);
			try {
				let rowNumber = 1;
				while (statement.step() && samples.length < limit) {
					samples.push({
						ref: `${String(table.ref)}/row:${rowNumber}`,
						tableRef: table.ref,
						values: normalizeRow(statement.getAsObject()),
					});
					rowNumber += 1;
				}
			} finally {
				statement.free();
			}
		}

		return {
			schemaVersion: "octopus.data.v1",
			operation: "inspect",
			file: { path: filePath, format: "sqlite", size },
			tables,
			summary: {
				tableCount: tables.filter((item) => item.type === "table").length,
				viewCount: tables.filter((item) => item.type === "view").length,
			},
			rows: samples,
		};
	});
}

async function querySqlite(
	filePath: string,
	size: number,
	buffer: Buffer,
	sql: string,
	bindParams: unknown[],
	offset: number,
	limit: number,
): Promise<JsonObject> {
	validateReadOnlySql(sql);
	return withSqlite(buffer, async (db) => {
		const statement = db.prepare(sql);
		try {
			if (bindParams.length > 0) statement.bind(bindParams);
			const columns = (
				statement as unknown as { getColumnNames: () => string[] }
			).getColumnNames();
			const rows: JsonObject[] = [];
			let seen = 0;
			let hasMore = false;
			while (statement.step()) {
				if (seen >= offset && rows.length < limit) {
					rows.push({
						ref: `sqlite:query/row:${seen + 1}`,
						values: normalizeRow(statement.getAsObject()),
					});
				}
				seen += 1;
				if (rows.length >= limit) {
					hasMore = statement.step();
					break;
				}
			}
			return {
				schemaVersion: "octopus.data.v1",
				operation: "query",
				file: { path: filePath, format: "sqlite", size },
				columns,
				rows,
				page: {
					offset,
					limit,
					returned: rows.length,
					hasMore,
				},
			};
		} finally {
			statement.free();
		}
	});
}

async function withSqlite<T>(
	buffer: Buffer,
	fn: (db: Database) => Promise<T>,
): Promise<T> {
	const SQL = await loadSqlJs();
	const db = new SQL.Database(buffer);
	try {
		// Even if validation regresses, SQLite itself rejects writes on this connection.
		db.run("PRAGMA query_only = ON");
		return await fn(db);
	} finally {
		db.close();
	}
}

function loadSqlJs(): Promise<SqlJsStatic> {
	sqlJsPromise ??= import("sql.js").then((module) => module.default());
	return sqlJsPromise;
}

function validateReadOnlySql(sql: string): void {
	if (sql.length > 100_000)
		throw new DataToolError("SQL exceeds the 100000 character limit");
	const scanned = scanSql(sql);
	if (scanned.tokens.length === 0)
		throw new DataToolError("sql must not be empty");
	if (
		scanned.semicolons > 1 ||
		(scanned.semicolons === 1 && scanned.contentAfterSemicolon)
	) {
		throw new DataToolError(
			"Multiple SQL statements are not allowed",
			"SECURITY_BLOCKED",
		);
	}

	const first = scanned.tokens[0];
	if (first !== "SELECT" && first !== "WITH" && first !== "PRAGMA") {
		throw new DataToolError(
			"Only SELECT, WITH, and safe PRAGMA statements are allowed",
			"SECURITY_BLOCKED",
		);
	}

	const forbidden = new Set([
		"ALTER",
		"ANALYZE",
		"ATTACH",
		"BEGIN",
		"COMMIT",
		"CREATE",
		"DELETE",
		"DETACH",
		"DROP",
		"END",
		"INSERT",
		"INTO",
		"LOAD_EXTENSION",
		"PRAGMA",
		"READFILE",
		"REINDEX",
		"RELEASE",
		"REPLACE",
		"ROLLBACK",
		"SAVEPOINT",
		"TRANSACTION",
		"UPDATE",
		"VACUUM",
		"WRITEFILE",
	]);

	if (first === "PRAGMA") {
		validatePragma(scanned);
		return;
	}
	for (const token of scanned.tokens) {
		if (forbidden.has(token)) {
			throw new DataToolError(
				`SQL keyword/function '${token}' is not allowed`,
				"SECURITY_BLOCKED",
			);
		}
	}
}

function validatePragma(scanned: ReturnType<typeof scanSql>): void {
	const allowed = new Set([
		"COLLATION_LIST",
		"COMPILE_OPTIONS",
		"DATABASE_LIST",
		"FOREIGN_KEY_LIST",
		"FUNCTION_LIST",
		"INDEX_INFO",
		"INDEX_LIST",
		"INDEX_XINFO",
		"MODULE_LIST",
		"PRAGMA_LIST",
		"TABLE_INFO",
		"TABLE_XINFO",
	]);
	const name = scanned.tokens[1];
	if (!name || !allowed.has(name) || scanned.hasEquals) {
		throw new DataToolError(
			"This PRAGMA is not allowed in read-only queries",
			"SECURITY_BLOCKED",
		);
	}
}

function scanSql(sql: string): {
	tokens: string[];
	semicolons: number;
	contentAfterSemicolon: boolean;
	hasEquals: boolean;
} {
	const tokens: string[] = [];
	let semicolons = 0;
	let contentAfterSemicolon = false;
	let hasEquals = false;
	let index = 0;
	while (index < sql.length) {
		const char = sql[index] ?? "";
		const next = sql[index + 1] ?? "";
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === "-" && next === "-") {
			index += 2;
			while (index < sql.length && sql[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = sql.indexOf("*/", index + 2);
			if (end < 0) throw new DataToolError("Unterminated SQL comment");
			index = end + 2;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			index = skipSqlQuote(sql, index, char);
			if (semicolons > 0) contentAfterSemicolon = true;
			continue;
		}
		if (char === "[") {
			const end = sql.indexOf("]", index + 1);
			if (end < 0) throw new DataToolError("Unterminated SQL identifier");
			index = end + 1;
			if (semicolons > 0) contentAfterSemicolon = true;
			continue;
		}
		if (char === ";") {
			semicolons += 1;
			index += 1;
			continue;
		}
		if (char === "=") hasEquals = true;
		if (/[A-Za-z_]/.test(char)) {
			const start = index;
			index += 1;
			while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index] ?? ""))
				index += 1;
			tokens.push(sql.slice(start, index).toUpperCase());
			if (semicolons > 0) contentAfterSemicolon = true;
			continue;
		}
		if (semicolons > 0) contentAfterSemicolon = true;
		index += 1;
	}
	return { tokens, semicolons, contentAfterSemicolon, hasEquals };
}

function skipSqlQuote(sql: string, start: number, quote: string): number {
	let index = start + 1;
	while (index < sql.length) {
		if (sql[index] === quote) {
			if (sql[index + 1] === quote) {
				index += 2;
				continue;
			}
			return index + 1;
		}
		index += 1;
	}
	throw new DataToolError("Unterminated SQL string or identifier");
}

async function loadRows(
	filePath: string,
	format: Exclude<DataFormat, "sqlite">,
): Promise<LoadedRows> {
	const buffer = await readFileLimited(filePath, MAX_TEXT_BYTES);
	if (format === "json") return loadJsonRows(buffer);
	return loadDelimitedRows(buffer, format);
}

function loadDelimitedRows(buffer: Buffer, format: "csv" | "tsv"): LoadedRows {
	const records = parse(buffer, {
		bom: true,
		columns: true,
		delimiter: format === "tsv" ? "\t" : ",",
		skip_empty_lines: true,
		relax_column_count: true,
		max_record_size: 1024 * 1024,
		to: MAX_SOURCE_ROWS + 2,
	}) as JsonObject[];
	if (records.length > MAX_SOURCE_ROWS) {
		throw new DataToolError(
			`Data file exceeds the ${MAX_SOURCE_ROWS} row limit`,
		);
	}
	const columns = collectColumns(records);
	return { format, tableRef: `${format}:table:root`, rows: records, columns };
}

function loadJsonRows(buffer: Buffer): LoadedRows {
	let parsed: unknown;
	try {
		parsed = JSON.parse(buffer.toString("utf8"));
	} catch (error) {
		throw new DataToolError(`Invalid JSON: ${errorMessage(error)}`);
	}
	const sourceRows = Array.isArray(parsed) ? parsed : [parsed];
	if (sourceRows.length > MAX_SOURCE_ROWS) {
		throw new DataToolError(`JSON exceeds the ${MAX_SOURCE_ROWS} row limit`);
	}
	const rows = sourceRows.map((value) =>
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as JsonObject)
			: { value },
	);
	return {
		format: "json",
		tableRef: "json:table:root",
		rows,
		columns: collectColumns(rows),
	};
}

function parseFilters(value: unknown): JsonObject {
	if (value === undefined || value === null || value === "") return {};
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch (error) {
			throw new DataToolError(`Invalid filters JSON: ${errorMessage(error)}`);
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new DataToolError("filters must be an object or JSON object string");
	}
	return parsed as JsonObject;
}

function matchesFilters(row: JsonObject, filters: JsonObject): boolean {
	return Object.entries(filters).every(([field, condition]) => {
		const actual = getField(row, field);
		if (
			!condition ||
			typeof condition !== "object" ||
			Array.isArray(condition)
		) {
			return valuesEqual(actual, condition);
		}
		return Object.entries(condition as JsonObject).every(
			([operator, expected]) => matchOperator(actual, operator, expected),
		);
	});
}

function matchOperator(
	actual: unknown,
	operator: string,
	expected: unknown,
): boolean {
	switch (operator) {
		case "$eq":
			return valuesEqual(actual, expected);
		case "$ne":
			return !valuesEqual(actual, expected);
		case "$contains":
			return String(actual ?? "")
				.toLowerCase()
				.includes(String(expected ?? "").toLowerCase());
		case "$gt":
			return compareValues(actual, expected) > 0;
		case "$gte":
			return compareValues(actual, expected) >= 0;
		case "$lt":
			return compareValues(actual, expected) < 0;
		case "$lte":
			return compareValues(actual, expected) <= 0;
		case "$in":
			if (!Array.isArray(expected))
				throw new DataToolError("$in filter requires an array");
			return expected.some((candidate) => valuesEqual(actual, candidate));
		default:
			throw new DataToolError(`Unsupported filter operator: ${operator}`);
	}
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
	if (actual === expected) return true;
	if (
		actual === null ||
		actual === undefined ||
		expected === null ||
		expected === undefined
	)
		return false;
	return String(actual) === String(expected);
}

function compareValues(actual: unknown, expected: unknown): number {
	const leftNumber = Number(actual);
	const rightNumber = Number(expected);
	if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber))
		return leftNumber - rightNumber;
	return String(actual ?? "").localeCompare(String(expected ?? ""));
}

function getField(row: JsonObject, field: string): unknown {
	if (Object.hasOwn(row, field)) return row[field];
	return field.split(".").reduce<unknown>((value, part) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return undefined;
		return (value as JsonObject)[part];
	}, row);
}

function parseColumns(value: unknown, available: string[]): string[] | null {
	if (value === undefined || value === null || value === "") return null;
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			parsed = value.split(",").map((item) => item.trim());
		}
	}
	if (
		!Array.isArray(parsed) ||
		parsed.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new DataToolError("columns must be an array of non-empty strings");
	}
	const columns = [...new Set(parsed as string[])];
	const unknown = columns.filter((column) => !available.includes(column));
	if (unknown.length > 0)
		throw new DataToolError(`Unknown columns: ${unknown.join(", ")}`);
	return columns;
}

function selectColumns(row: JsonObject, columns: string[]): JsonObject {
	return Object.fromEntries(
		columns.map((column) => [column, getField(row, column)]),
	);
}

function referencedRows(
	loaded: LoadedRows,
	rows: JsonObject[],
	offset: number,
): JsonObject[] {
	return rows.map((row, index) => ({
		ref: `${loaded.tableRef}/row:${offset + index + 1}`,
		values: normalizeRow(row),
	}));
}

function inferColumns(
	rows: JsonObject[],
	preferredOrder: string[],
): JsonObject[] {
	return preferredOrder.map((name) => {
		const values = rows
			.map((row) => row[name])
			.filter((value) => value !== null && value !== undefined);
		return { name, type: inferType(values) };
	});
}

function inferType(values: unknown[]): string {
	if (values.length === 0) return "unknown";
	const types = new Set(
		values.slice(0, 1000).map((value) => {
			if (Array.isArray(value)) return "array";
			if (typeof value === "string") {
				if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return "number";
				if (/^(?:true|false)$/i.test(value.trim())) return "boolean";
			}
			return typeof value;
		}),
	);
	return types.size === 1 ? ([...types][0] ?? "unknown") : "mixed";
}

function collectColumns(rows: JsonObject[]): string[] {
	const columns = new Set<string>();
	for (const row of rows.slice(0, 10_000)) {
		for (const key of Object.keys(row)) columns.add(key);
	}
	return [...columns];
}

function normalizeRow(row: JsonObject): JsonObject {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
	);
}

function normalizeValue(value: unknown, depth = 0): unknown {
	if (depth > 20) return "[maximum depth reached]";
	if (value instanceof Uint8Array) {
		const preview = value.subarray(0, 256);
		return {
			type: "blob",
			bytes: value.byteLength,
			base64: Buffer.from(preview).toString("base64"),
			truncated: preview.byteLength < value.byteLength,
		};
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") return truncateText(value);
	if (Array.isArray(value))
		return value.slice(0, 1000).map((item) => normalizeValue(item, depth + 1));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as JsonObject)
				.slice(0, 1000)
				.map(([key, item]) => [key, normalizeValue(item, depth + 1)]),
		);
	}
	return value;
}

function truncateText(value: string): string {
	return value.length <= MAX_CELL_CHARS
		? value
		: `${value.slice(0, MAX_CELL_CHARS)}...`;
}

function sqliteTableRef(name: string): string {
	return `sqlite:table:${encodeURIComponent(name)}`;
}

function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function parseBindParams(value: unknown): unknown[] {
	if (value === undefined || value === null || value === "") return [];
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch (error) {
			throw new DataToolError(`Invalid params JSON: ${errorMessage(error)}`);
		}
	}
	if (!Array.isArray(parsed))
		throw new DataToolError("params must be an array or JSON array string");
	if (parsed.length > 1000)
		throw new DataToolError("params exceeds the 1000 value limit");
	return parsed;
}

function detectFormat(filePath: string, prefix: Buffer): DataFormat {
	if (
		prefix.subarray(0, SQLITE_HEADER.length).toString("binary") ===
		SQLITE_HEADER
	)
		return "sqlite";
	switch (path.extname(filePath).toLowerCase()) {
		case ".db":
		case ".db3":
		case ".sqlite":
		case ".sqlite3":
			throw new DataToolError(
				"File has a SQLite extension but not a valid SQLite header",
			);
		case ".csv":
			return "csv";
		case ".tsv":
		case ".tab":
			return "tsv";
		case ".json":
			return "json";
		default:
			throw new DataToolError(
				"Unsupported data format; expected SQLite, CSV, TSV, or JSON",
			);
	}
}

async function readPrefix(filePath: string): Promise<Buffer> {
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(SQLITE_HEADER.length);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function readFileLimited(
	filePath: string,
	maxBytes: number,
): Promise<Buffer> {
	const buffer = await readFile(filePath);
	if (buffer.byteLength > maxBytes) {
		throw new DataToolError(`File exceeds the ${maxBytes} byte limit`);
	}
	return buffer;
}

async function checkedFileSize(filePath: string): Promise<number> {
	const info = await stat(filePath);
	if (!info.isFile())
		throw new DataToolError("Path must point to a regular file");
	return Number(info.size);
}

function assertFileSize(size: number, maxBytes: number, label: string): void {
	if (size > maxBytes)
		throw new DataToolError(`${label} file exceeds the ${maxBytes} byte limit`);
}

function createPathPolicy(
	allowedPaths: string[],
	workspaceDir: string,
): PathPolicy {
	const roots = allowedPaths.map((root) => path.resolve(expandHome(root)));
	const workspace = path.resolve(expandHome(workspaceDir));
	return {
		resolveInput: async (rawPath) => {
			const expanded = expandHome(rawPath);
			const resolved = path.isAbsolute(expanded)
				? path.resolve(expanded)
				: path.resolve(workspace, expanded);
			if (
				!path.isAbsolute(expanded) &&
				!isPathInsideAny(resolved, [workspace])
			) {
				throw new DataToolError(
					`Relative path escapes workspace: ${rawPath}`,
					"SECURITY_BLOCKED",
				);
			}
			if (!isPathInsideAny(resolved, roots)) {
				throw new DataToolError(
					`Access denied: ${resolved}`,
					"SECURITY_BLOCKED",
				);
			}
			try {
				await assertRealPathInside(resolved, roots);
			} catch (error) {
				throw new DataToolError(errorMessage(error), "SECURITY_BLOCKED");
			}
			try {
				return await realpath(resolved);
			} catch (error) {
				throw new DataToolError(
					`Unable to resolve input file: ${errorMessage(error)}`,
				);
			}
		},
	};
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new DataToolError(`${name} must be a non-empty string`);
	}
	return value.trim();
}

function clampInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	if (value === undefined || value === null || value === "") return fallback;
	const number = Number(value);
	if (!Number.isFinite(number))
		throw new DataToolError("Pagination values must be finite numbers");
	return Math.min(max, Math.max(min, Math.floor(number)));
}

function createPage(
	offset: number,
	limit: number,
	returned: number,
	total: number,
): JsonObject {
	return {
		offset,
		limit,
		returned,
		total,
		nextOffset: offset + returned < total ? offset + returned : null,
	};
}

async function wrapResult(
	operation: string,
	fn: () => Promise<JsonObject>,
): Promise<ToolResult> {
	try {
		const value = await fn();
		return { success: true, output: JSON.stringify(value, null, 2) };
	} catch (error) {
		const message = errorMessage(error);
		const code =
			error instanceof DataToolError ? error.code : "EXECUTION_FAILED";
		return {
			success: false,
			output: JSON.stringify(
				{
					schemaVersion: "octopus.data.v1",
					operation,
					error: { code, message },
				},
				null,
				2,
			),
			error: message,
			errorCode: code,
		};
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
