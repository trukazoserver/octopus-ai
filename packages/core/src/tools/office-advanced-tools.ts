import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import { ArtifactIndex, type ArtifactUnit } from "./artifact-index.js";
import { PdfReader } from "./pdf-reader.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const OFFICE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="10" cy="14" r="3"/><path d="m12.2 16.2 2.3 2.3"/></svg>`;
const MAX_INSPECT_ITEMS = 2000;
const MAX_SEARCH_UNITS = 200_000;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

type OfficeKind = "docx" | "pptx" | "xlsx" | "pdf" | "text" | "legacy";
type JsonObject = Record<string, unknown>;

interface OfficeUnit {
	ref: string;
	kind: "paragraph" | "slideText" | "cell" | "page" | "line" | "block";
	text: string;
	part?: string;
	paragraph?: number;
	slide?: number;
	sheet?: string;
	cell?: string;
	page?: number;
	formula?: string;
	ocrUsed?: boolean;
}

interface Inspection {
	kind: OfficeKind;
	properties: JsonObject;
	units: OfficeUnit[];
	warnings: string[];
}

interface PathPolicy {
	resolve: (rawPath: string) => string;
	input: (resolved: string) => Promise<void>;
	output: (resolved: string) => Promise<void>;
}

export function createOfficeAdvancedTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
	cacheDir: string = path.join(os.homedir(), ".octopus", "cache", "artifact-index"),
): ToolDefinition[] {
	const policy = createPathPolicy(allowedPaths, workspaceDir);
	const artifactIndex = new ArtifactIndex({
		cacheDir,
		maxUnits: MAX_SEARCH_UNITS,
		maxTotalTextChars: 100_000_000,
	});

	const inspectTool: ToolDefinition = {
		name: "office_inspect",
		description:
			"Inspect DOCX, PPTX, XLSX, PDF, legacy Office, text, code, CSV, JSON, HTML, XML, YAML, and similar files. Returns structural units with verifiable paragraph, slide, sheet/cell, page, or line references. Use before editing or when understanding file structure.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Input file path", required: true },
			pages: { type: "string", description: "Optional PDF page range", required: false },
			offset: { type: "number", description: "Result offset, default 0", required: false },
			limit: { type: "number", description: "Maximum units, default 200, max 2000", required: false },
			maxTextChars: { type: "number", description: "Maximum text per unit, default 1000", required: false },
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const filePath = policy.resolve(requiredString(params.path, "path"));
			await policy.input(filePath);
			const inspection = await inspectOfficeFile(filePath, {
				pages: optionalString(params.pages),
				maxUnits: MAX_SEARCH_UNITS,
			});
			const info = await stat(filePath);
			const offset = clampInt(params.offset, 0, inspection.units.length, 0);
			const limit = clampInt(params.limit, 1, MAX_INSPECT_ITEMS, 200);
			const maxTextChars = clampInt(params.maxTextChars, 80, 10_000, 1000);
			const units = inspection.units.slice(offset, offset + limit).map((unit) => ({
				...unit,
				text: truncate(unit.text, maxTextChars),
			}));
			const output = {
				schemaVersion: "octopus.office.v1",
				operation: "inspect",
				file: {
					path: filePath,
					kind: inspection.kind,
					size: info.size,
					sha256: sha256(await readFile(filePath)),
				},
				properties: inspection.properties,
				summary: summarizeUnits(inspection.units),
				items: units,
				page: {
					offset,
					limit,
					returned: units.length,
					total: inspection.units.length,
					nextOffset: offset + units.length < inspection.units.length ? offset + units.length : null,
				},
				warnings: inspection.warnings,
			};
			return {
				output: JSON.stringify(output, null, 2),
				metadata: {
					kind: inspection.kind,
					totalItems: inspection.units.length,
					returned: units.length,
				},
			};
		}),
	};

	const searchTool: ToolDefinition = {
		name: "office_search",
		description:
			"Search inside DOCX, PPTX, XLSX, PDF, text, code, CSV, JSON, HTML, XML, YAML, and legacy Office files. Returns precise paragraph, slide, sheet/cell, page, or line references and compact snippets without loading the entire file into chat.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Input file path", required: true },
			query: { type: "string", description: "Text or phrase to search", required: true },
			pages: { type: "string", description: "Optional PDF page range", required: false },
			caseSensitive: { type: "boolean", description: "Case-sensitive search, default false", required: false },
			wholeWord: { type: "boolean", description: "Whole-word search, default false", required: false },
			includeFormulas: { type: "boolean", description: "Search XLSX formulas too, default true", required: false },
			maxResults: { type: "number", description: "Maximum results, default 20, max 100", required: false },
			contextChars: { type: "number", description: "Snippet context, default 220", required: false },
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const filePath = policy.resolve(requiredString(params.path, "path"));
			await policy.input(filePath);
			const query = requiredString(params.query, "query");
			const fileInfo = await stat(filePath);
			const artifactRef = `file:${filePath}:${fileInfo.size}:${fileInfo.mtimeMs}`;
			const maxResults = clampInt(params.maxResults, 1, 100, 20);
			const contextChars = clampInt(params.contextChars, 40, 2000, 220);
			const caseSensitive = params.caseSensitive === true;
			const wholeWord = params.wholeWord === true;
			const includeFormulas = params.includeFormulas !== false;
			if (!caseSensitive && !wholeWord) {
				let snapshot = await artifactIndex.get(artifactRef);
				let inspectionKind = kindFromExtension(filePath);
				let cacheHit = true;
				if (!snapshot) {
					const inspection = await inspectOfficeFile(filePath, {
						pages: optionalString(params.pages),
						maxUnits: MAX_SEARCH_UNITS,
					});
					inspectionKind = inspection.kind;
					await artifactIndex.index(
						artifactRef,
						inspection.units.map(toArtifactUnit),
					);
					snapshot = await artifactIndex.get(artifactRef);
					cacheHit = false;
				}
				const ranked = await artifactIndex.search(artifactRef, query, {
					limit: maxResults,
				});
				const matches = ranked.map((match) => ({
					...match.unit,
					score: match.score,
					snippet: truncate(match.snippet, contextChars * 2 + query.length),
					literalMatch: match.literalMatch,
					matchedTokens: match.matchedTokens,
				}));
				return {
					output: JSON.stringify(
						{
							schemaVersion: "octopus.office.v1",
							operation: "search",
							mode: "hybrid",
							file: { path: filePath, kind: inspectionKind },
							query,
							searchedUnits: snapshot?.units.length ?? 0,
							matches,
							totalMatches: matches.length,
							truncated: matches.length >= maxResults,
							cacheHit,
						},
						null,
						2,
					),
					metadata: { kind: inspectionKind, matches: matches.length, cacheHit, mode: "hybrid" },
				};
			}
			const inspection = await inspectOfficeFile(filePath, {
				pages: optionalString(params.pages),
				maxUnits: MAX_SEARCH_UNITS,
			});
			const matches: JsonObject[] = [];
			let totalMatches = 0;
			for (const unit of inspection.units) {
				const fields: Array<{ field: string; text: string }> = [{ field: "text", text: unit.text }];
				if (includeFormulas && unit.formula) fields.push({ field: "formula", text: unit.formula });
				for (const field of fields) {
					const occurrences = findOccurrences(field.text, query, caseSensitive, wholeWord);
					if (occurrences.length === 0) continue;
					totalMatches += occurrences.length;
					if (matches.length < maxResults) {
						matches.push({
							...unit,
							field: field.field,
							occurrences: occurrences.length,
							snippet: snippet(field.text, occurrences[0] ?? 0, query.length, contextChars),
						});
					}
				}
			}
			return {
				output: JSON.stringify(
					{
						schemaVersion: "octopus.office.v1",
						operation: "search",
						mode: "exact",
						file: { path: filePath, kind: inspection.kind },
						query,
						searchedUnits: inspection.units.length,
						matches,
						totalMatches,
						truncated: matches.length < totalMatches,
						warnings: inspection.warnings,
					},
					null,
					2,
				),
				metadata: { kind: inspection.kind, matches: matches.length, totalMatches },
			};
		}),
	};

	const docxTemplateTool = templateFillTool("docx", policy);
	const pptxTemplateTool = templateFillTool("pptx", policy);
	return [inspectTool, searchTool, docxTemplateTool, pptxTemplateTool];
}

function toArtifactUnit(unit: OfficeUnit): ArtifactUnit {
	return Object.fromEntries(
		Object.entries(unit).filter(([, value]) => value !== undefined),
	) as ArtifactUnit;
}

function kindFromExtension(filePath: string): OfficeKind {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".docx") return "docx";
	if (ext === ".pptx") return "pptx";
	if (ext === ".xlsx" || ext === ".xlsm") return "xlsx";
	if (ext === ".pdf") return "pdf";
	if ([".doc", ".ppt", ".rtf", ".odt", ".odp", ".ods"].includes(ext)) return "legacy";
	return "text";
}

function templateFillTool(kind: "docx" | "pptx", policy: PathPolicy): ToolDefinition {
	return {
		name: `${kind}_template_fill`,
		description:
			kind === "docx"
				? "Fill {{placeholders}} in an existing DOCX template while preserving its OOXML structure, styles, tables, images, headers, and footers. Supports placeholders split across text runs. Always writes a new file."
				: "Fill {{placeholders}} in an existing PPTX template while preserving slides, layouts, masters, geometry, media, and animations. Supports placeholders split across text runs, slide-specific values, and optional notes. Always writes a new file.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: `Input ${kind.toUpperCase()} template path`, required: true },
			outputPath: { type: "string", description: `Output ${kind.toUpperCase()} path`, required: true },
			values: { type: "object", description: "Object or JSON object string mapping placeholder keys to scalar values", required: true },
			onUnresolved: { type: "string", description: "error (default), keep, or empty", required: false },
			overwriteOutput: { type: "boolean", description: "Allow replacing an existing output file, default false", required: false },
			...(kind === "pptx"
				? {
					slides: { type: "string", description: "Optional slide range, e.g. 1-3,8", required: false },
					slideValues: { type: "array", description: "Optional [{slide, values}] overrides", required: false },
					includeNotes: { type: "boolean", description: "Fill notes too, default false", required: false },
				}
				: {}),
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const inputPath = policy.resolve(requiredString(params.path, "path"));
			const outputPath = policy.resolve(requiredString(params.outputPath, "outputPath"));
			await policy.input(inputPath);
			await policy.output(outputPath);
			if (samePath(inputPath, outputPath)) throw new Error("Template and output paths must be different");
			if (!params.overwriteOutput && (await exists(outputPath))) {
				throw new Error(`Output already exists: ${outputPath}`);
			}
			const values = parseValues(params.values);
			const onUnresolved = ["error", "keep", "empty"].includes(String(params.onUnresolved))
				? String(params.onUnresolved)
				: "error";
			const original = await readFile(inputPath);
			const zip = openSafeZip(original, kind);
			const selectedSlides = kind === "pptx" ? parseNumberSelection(optionalString(params.slides)) : null;
			const slideOverrides = kind === "pptx" ? parseSlideValues(params.slideValues) : new Map<number, JsonObject>();
			const entries = selectedTemplateEntries(zip, kind, selectedSlides, params.includeNotes === true);
			const allKeys = new Set<string>();
			const missingKeys = new Set<string>();
			for (const entry of entries) {
				const slideNumber = kind === "pptx" ? slideNumberFromEntry(entry.entryName) : undefined;
				const effective = slideNumber ? { ...values, ...(slideOverrides.get(slideNumber) ?? {}) } : values;
				for (const key of collectPlaceholderKeys(entry.getData().toString("utf8"), kind)) {
					allKeys.add(key);
					if (!Object.hasOwn(effective, key)) missingKeys.add(key);
				}
			}
			const missing = [...missingKeys];
			if (onUnresolved === "error" && missing.length > 0) {
				throw new Error(`Unresolved placeholders: ${missing.join(", ")}`);
			}
			const effectiveBase = { ...values };
			if (onUnresolved === "empty") for (const key of missing) effectiveBase[key] = "";
			let replacements = 0;
			const changedParts: string[] = [];
			for (const entry of entries) {
				const slideNumber = kind === "pptx" ? slideNumberFromEntry(entry.entryName) : undefined;
				const effective = slideNumber
					? { ...effectiveBase, ...(slideOverrides.get(slideNumber) ?? {}) }
					: effectiveBase;
				const result = replaceOoxmlPlaceholders(entry.getData().toString("utf8"), kind, effective);
				if (result.replacements > 0) {
					zip.updateFile(entry.entryName, Buffer.from(result.xml, "utf8"));
					replacements += result.replacements;
					changedParts.push(entry.entryName);
				}
			}
			const outputBuffer = zip.toBuffer();
			openSafeZip(outputBuffer, kind);
			const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
			await writeFile(tempPath, outputBuffer);
			try {
				openSafeZip(await readFile(tempPath), kind);
				if (params.overwriteOutput) await rm(outputPath, { force: true });
				await rename(tempPath, outputPath);
			} finally {
				await rm(tempPath, { force: true }).catch(() => {});
			}
			return {
				output: JSON.stringify(
					{
						schemaVersion: "octopus.office.v1",
						operation: `${kind}_template_fill`,
						template: { path: inputPath, sha256: sha256(original) },
						output: { path: outputPath, size: outputBuffer.length, sha256: sha256(outputBuffer) },
						replacements,
						changedParts,
						unresolved: onUnresolved === "keep" ? missing : [],
						unusedKeys: Object.keys(values).filter((key) => !allKeys.has(key)),
					},
					null,
					2,
				),
				metadata: { outputPath, replacements, changedParts: changedParts.length },
			};
		}),
	};
}

async function inspectOfficeFile(
	filePath: string,
	options: { pages?: string; maxUnits: number },
): Promise<Inspection> {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".docx") return inspectDocx(await readFile(filePath), options.maxUnits);
	if (ext === ".pptx") return inspectPptx(await readFile(filePath), options.maxUnits);
	if ([".xlsx", ".xlsm"].includes(ext)) return inspectXlsx(filePath, options.maxUnits);
	if (ext === ".pdf") return inspectPdf(filePath, options.pages, options.maxUnits);
	if ([".doc", ".ppt", ".rtf", ".odt", ".odp", ".ods"].includes(ext)) {
		return inspectLegacy(filePath, options.maxUnits);
	}
	return inspectText(filePath, options.maxUnits);
}

function inspectDocx(buffer: Buffer, maxUnits: number): Inspection {
	const zip = openSafeZip(buffer, "docx");
	const parts = zip
		.getEntries()
		.filter((entry) =>
			/^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(entry.entryName),
		);
	const units: OfficeUnit[] = [];
	for (const entry of parts) {
		let paragraph = 0;
		for (const xml of entry.getData().toString("utf8").matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
			paragraph++;
			const text = extractNodeTexts(xml[0], "w:t");
			if (!text.trim()) continue;
			units.push({
				kind: "paragraph",
				ref: `docx:${entry.entryName.replace(/^word\//, "")}/p:${paragraph}`,
				part: entry.entryName,
				paragraph,
				text,
			});
			if (units.length >= maxUnits) break;
		}
		if (units.length >= maxUnits) break;
	}
	return {
		kind: "docx",
		properties: { parts: parts.length, paragraphs: units.length },
		units,
		warnings: units.length >= maxUnits ? [`Inspection capped at ${maxUnits} units`] : [],
	};
}

function inspectPptx(buffer: Buffer, maxUnits: number): Inspection {
	const zip = openSafeZip(buffer, "pptx");
	const slides = zip
		.getEntries()
		.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
		.sort((a, b) => (slideNumberFromEntry(a.entryName) ?? 0) - (slideNumberFromEntry(b.entryName) ?? 0));
	const units: OfficeUnit[] = [];
	for (const entry of slides) {
		const slide = slideNumberFromEntry(entry.entryName) ?? 0;
		let paragraph = 0;
		for (const xml of entry.getData().toString("utf8").matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)) {
			paragraph++;
			const text = extractNodeTexts(xml[0], "a:t");
			if (!text.trim()) continue;
			units.push({
				kind: "slideText",
				ref: `pptx:slide:${slide}/p:${paragraph}`,
				part: entry.entryName,
				slide,
				paragraph,
				text,
			});
			if (units.length >= maxUnits) break;
		}
		if (units.length >= maxUnits) break;
	}
	return {
		kind: "pptx",
		properties: { slides: slides.length, textUnits: units.length },
		units,
		warnings: units.length >= maxUnits ? [`Inspection capped at ${maxUnits} units`] : [],
	};
}

async function inspectXlsx(filePath: string, maxUnits: number): Promise<Inspection> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(filePath);
	const units: OfficeUnit[] = [];
	for (const sheet of workbook.worksheets) {
		sheet.eachRow({ includeEmpty: false }, (row) => {
			if (units.length >= maxUnits) return;
			row.eachCell({ includeEmpty: false }, (cell) => {
				if (units.length >= maxUnits) return;
				units.push({
					kind: "cell",
					ref: `xlsx:sheet:${encodeURIComponent(sheet.name)}/cell:${cell.address}`,
					sheet: sheet.name,
					cell: cell.address,
					text: cell.text,
					formula: cell.formula,
				});
			});
		});
		if (units.length >= maxUnits) break;
	}
	return {
		kind: "xlsx",
		properties: {
			sheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, state: sheet.state })),
			populatedCells: units.length,
		},
		units,
		warnings: units.length >= maxUnits ? [`Inspection capped at ${maxUnits} cells`] : [],
	};
}

async function inspectPdf(filePath: string, pages: string | undefined, maxUnits: number): Promise<Inspection> {
	const reader = new PdfReader({ allowedLocalRoots: [path.dirname(filePath)], ocrMaxPages: 20 });
	const result = await reader.extract(await readFile(filePath), { pages, ocr: "auto", maxOcrPages: 20 });
	const units = result.pages.slice(0, maxUnits).map((page) => ({
		kind: "page" as const,
		ref: `pdf:page:${page.page}`,
		page: page.page,
		text: page.text,
		ocrUsed: page.ocrUsed,
	}));
	return {
		kind: "pdf",
		properties: { totalPages: result.totalPages, returnedPages: units.length, ocrUsed: result.ocrUsed },
		units,
		warnings: result.ocrSkippedReason ? [result.ocrSkippedReason] : [],
	};
}

async function inspectLegacy(filePath: string, maxUnits: number): Promise<Inspection> {
	const mod = (await import("officeparser")) as unknown as {
		convert?: (file: string, destination: string) => Promise<{ value?: unknown }>;
		default?: { convert?: (file: string, destination: string) => Promise<{ value?: unknown }> };
	};
	const convert = mod.convert ?? mod.default?.convert;
	if (!convert) throw new Error("officeparser.convert is unavailable");
	const result = await convert(filePath, "text");
	const blocks = String(result.value ?? "").split(/\n{2,}/).map((text) => text.trim()).filter(Boolean);
	return {
		kind: "legacy",
		properties: { referenceQuality: "synthetic", blocks: blocks.length },
		units: blocks.slice(0, maxUnits).map((text, index) => ({ kind: "block", ref: `legacy:block:${index + 1}`, text })),
		warnings: ["Legacy Office references are synthetic; convert to OOXML for structural editing."],
	};
}

async function inspectText(filePath: string, maxUnits: number): Promise<Inspection> {
	const buffer = await readFile(filePath);
	if (buffer.includes(0)) throw new Error("Unsupported binary file type");
	const lines = buffer.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
	return {
		kind: "text",
		properties: { lines: lines.length, extension: path.extname(filePath).toLowerCase() },
		units: lines.slice(0, maxUnits).map((text, index) => ({ kind: "line", ref: `text:line:${index + 1}`, text })),
		warnings: lines.length > maxUnits ? [`Inspection capped at ${maxUnits} lines`] : [],
	};
}

function selectedTemplateEntries(
	zip: AdmZip,
	kind: "docx" | "pptx",
	selectedSlides: Set<number> | null,
	includeNotes: boolean,
) {
	if (kind === "docx") {
		return zip.getEntries().filter((entry) =>
			/^word\/(document|header\d+|footer\d+)\.xml$/i.test(entry.entryName),
		);
	}
	return zip.getEntries().filter((entry) => {
		if (/^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName)) {
			const slide = slideNumberFromEntry(entry.entryName);
			return slide !== undefined && (!selectedSlides || selectedSlides.has(slide));
		}
		if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry.entryName)) {
			const slide = slideNumberFromEntry(entry.entryName);
			return includeNotes && slide !== undefined && (!selectedSlides || selectedSlides.has(slide));
		}
		return false;
	});
}

function replaceOoxmlPlaceholders(xml: string, kind: "docx" | "pptx", values: JsonObject) {
	const paragraphTag = kind === "docx" ? "w:p" : "a:p";
	const textTag = kind === "docx" ? "w:t" : "a:t";
	let replacements = 0;
	const paragraphRegex = new RegExp(`<${paragraphTag}\\b[^>]*>[\\s\\S]*?<\\/${paragraphTag}>`, "g");
	const output = xml.replace(paragraphRegex, (paragraphXml) => {
		const result = replaceInParagraph(paragraphXml, textTag, values);
		replacements += result.replacements;
		return result.xml;
	});
	return { xml: output, replacements };
}

function replaceInParagraph(paragraphXml: string, textTag: string, values: JsonObject) {
	const nodeRegex = new RegExp(`(<${textTag}\\b[^>]*>)([\\s\\S]*?)(<\\/${textTag}>)`, "g");
	const nodes = [...paragraphXml.matchAll(nodeRegex)].map((match) => ({
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
		open: match[1] ?? "",
		text: decodeXml(match[2] ?? ""),
		close: match[3] ?? "",
	}));
	if (nodes.length === 0) return { xml: paragraphXml, replacements: 0 };
	const combined = nodes.map((node) => node.text).join("");
	const matches = [...combined.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)]
		.filter((match) => Object.hasOwn(values, match[1] ?? ""))
		.reverse();
	for (const match of matches) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		const startLoc = locateTextOffset(nodes, start);
		const endLoc = locateTextOffset(nodes, end - 1);
		if (!startLoc || !endLoc) continue;
		const value = String(values[match[1] ?? ""] ?? "");
		if (startLoc.node === endLoc.node) {
			const node = nodes[startLoc.node];
			if (!node) continue;
			node.text = node.text.slice(0, startLoc.offset) + value + node.text.slice(endLoc.offset + 1);
		} else {
			const first = nodes[startLoc.node];
			const last = nodes[endLoc.node];
			if (!first || !last) continue;
			first.text = first.text.slice(0, startLoc.offset) + value;
			for (let i = startLoc.node + 1; i < endLoc.node; i++) {
				const node = nodes[i];
				if (node) node.text = "";
			}
			last.text = last.text.slice(endLoc.offset + 1);
		}
	}
	if (matches.length === 0) return { xml: paragraphXml, replacements: 0 };
	let rebuilt = "";
	let cursor = 0;
	for (const node of nodes) {
		rebuilt += paragraphXml.slice(cursor, node.start);
		rebuilt += `${node.open}${encodeXml(node.text)}${node.close}`;
		cursor = node.end;
	}
	rebuilt += paragraphXml.slice(cursor);
	return { xml: rebuilt, replacements: matches.length };
}

function locateTextOffset(nodes: Array<{ text: string }>, target: number) {
	let cursor = 0;
	for (let node = 0; node < nodes.length; node++) {
		const text = nodes[node]?.text ?? "";
		if (target >= cursor && target < cursor + text.length) return { node, offset: target - cursor };
		cursor += text.length;
	}
	return null;
}

function collectPlaceholderKeys(xml: string, kind: "docx" | "pptx"): string[] {
	const textTag = kind === "docx" ? "w:t" : "a:t";
	const paragraphTag = kind === "docx" ? "w:p" : "a:p";
	const keys = new Set<string>();
	for (const paragraph of xml.matchAll(new RegExp(`<${paragraphTag}\\b[^>]*>[\\s\\S]*?<\\/${paragraphTag}>`, "g"))) {
		const text = extractNodeTexts(paragraph[0], textTag, "");
		for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
			if (match[1]) keys.add(match[1]);
		}
	}
	return [...keys];
}

function openSafeZip(buffer: Buffer, expected: "docx" | "pptx"): AdmZip {
	const zip = new AdmZip(buffer);
	const entries = zip.getEntries();
	if (entries.length > MAX_ZIP_ENTRIES) throw new Error("Office package has too many ZIP entries");
	let total = 0;
	for (const entry of entries) {
		if (entry.entryName.includes("..") || path.posix.isAbsolute(entry.entryName)) {
			throw new Error(`Unsafe ZIP entry: ${entry.entryName}`);
		}
		total += entry.header.size;
		if (total > MAX_UNCOMPRESSED_BYTES) throw new Error("Office package is too large when decompressed");
	}
	const required = expected === "docx" ? "word/document.xml" : "ppt/presentation.xml";
	if (!zip.getEntry(required)) throw new Error(`Invalid ${expected.toUpperCase()} package: missing ${required}`);
	return zip;
}

function createPathPolicy(allowedPaths: string[], workspaceDir: string): PathPolicy {
	const roots = allowedPaths.map((root) => path.resolve(expandHome(root)));
	const resolve = (rawPath: string) => {
		const expanded = expandHome(rawPath);
		if (path.isAbsolute(expanded)) return path.resolve(expanded);
		const resolved = path.resolve(workspaceDir, expanded);
		if (!isPathInsideAny(resolved, [workspaceDir])) throw new Error(`Relative path escapes workspace: ${rawPath}`);
		return resolved;
	};
	const authorize = async (resolved: string) => {
		if (!isPathInsideAny(resolved, roots)) throw new Error(`Access denied: ${resolved}`);
		await assertRealPathInside(resolved, roots);
	};
	return {
		resolve,
		input: authorize,
		output: async (resolved) => {
			await authorize(resolved);
			await mkdir(path.dirname(resolved), { recursive: true });
			await authorize(resolved);
		},
	};
}

function extractNodeTexts(xml: string, tag: string, separator = " "): string {
	return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g"))]
		.map((match) => decodeXml(match[1] ?? ""))
		.join(separator)
		.replace(/\s+/g, " ")
		.trim();
}

function decodeXml(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function encodeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseValues(value: unknown): JsonObject {
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("values must be an object or JSON object string");
	const result: JsonObject = {};
	for (const [key, item] of Object.entries(parsed as JsonObject)) {
		if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`Invalid placeholder key: ${key}`);
		if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
			throw new Error(`Placeholder '${key}' must be a scalar value`);
		}
		result[key] = item;
	}
	return result;
}

function parseSlideValues(value: unknown): Map<number, JsonObject> {
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	const result = new Map<number, JsonObject>();
	if (parsed === undefined || parsed === null || parsed === "") return result;
	if (!Array.isArray(parsed)) throw new Error("slideValues must be an array");
	for (const item of parsed) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid slideValues item");
		const obj = item as JsonObject;
		const slide = Number(obj.slide);
		if (!Number.isInteger(slide) || slide < 1) throw new Error("slideValues.slide must be a positive integer");
		result.set(slide, parseValues(obj.values));
	}
	return result;
}

function parseNumberSelection(spec: string | undefined): Set<number> | null {
	if (!spec) return null;
	const values = new Set<number>();
	for (const part of spec.split(",")) {
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
		if (range) {
			for (let value = Number(range[1]); value <= Number(range[2]); value++) values.add(value);
		} else if (/^\d+$/.test(part.trim())) values.add(Number(part.trim()));
	}
	return values;
}

function slideNumberFromEntry(entryName: string): number | undefined {
	const match = /(?:slides\/slide|notesSlides\/notesSlide)(\d+)\.xml$/i.exec(entryName);
	return match ? Number(match[1]) : undefined;
}

function findOccurrences(text: string, query: string, caseSensitive: boolean, wholeWord: boolean): number[] {
	const haystack = caseSensitive ? text : normalizeSearch(text);
	const needle = caseSensitive ? query : normalizeSearch(query);
	if (!needle) return [];
	const results: number[] = [];
	let offset = 0;
	while (offset <= haystack.length - needle.length) {
		const index = haystack.indexOf(needle, offset);
		if (index < 0) break;
		const before = haystack[index - 1] ?? "";
		const after = haystack[index + needle.length] ?? "";
		if (!wholeWord || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))) results.push(index);
		offset = index + Math.max(needle.length, 1);
	}
	return results;
}

function normalizeSearch(value: string): string {
	let normalized = "";
	for (const char of value.normalize("NFD")) {
		const code = char.charCodeAt(0);
		if (code < 0x0300 || code > 0x036f) normalized += char;
	}
	return normalized.toLocaleLowerCase();
}

function snippet(text: string, index: number, needleLength: number, contextChars: number): string {
	const start = Math.max(0, index - contextChars);
	const end = Math.min(text.length, index + needleLength + contextChars);
	return `${start > 0 ? "..." : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "..." : ""}`;
}

function summarizeUnits(units: OfficeUnit[]) {
	const counts: Record<string, number> = {};
	for (const unit of units) counts[unit.kind] = (counts[unit.kind] ?? 0) + 1;
	return counts;
}

function requiredString(value: unknown, name: string): string {
	const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
	if (!text) throw new Error(`Missing required parameter '${name}'`);
	return text;
}

function optionalString(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	return text || undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}...[truncated]`;
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
	return stat(filePath).then(() => true, () => false);
}

function samePath(a: string, b: string): boolean {
	return process.platform === "win32"
		? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
		: path.resolve(a) === path.resolve(b);
}

async function wrapResult(
	fn: () => Promise<{ output: string; metadata?: JsonObject }>,
): Promise<ToolResult> {
	try {
		const result = await fn();
		return { success: true, ...result };
	} catch (err) {
		return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
	}
}
