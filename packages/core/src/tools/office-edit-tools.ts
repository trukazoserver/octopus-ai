import { createHash, randomUUID } from "node:crypto";
import {
	link,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const OFFICE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="m9 15 2 2 4-4"/></svg>`;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 1_000;
const MAX_OPERATIONS = 1_000;
const MAX_TEXT_LENGTH = 1_000_000;

type OfficeKind = "docx" | "pptx";
type JsonObject = Record<string, unknown>;

interface PathPolicy {
	resolve(rawPath: string): string;
	input(resolved: string): Promise<void>;
	output(resolved: string): Promise<void>;
}

interface EditOperation extends JsonObject {
	type: string;
}

interface EditChange {
	operationIndex: number;
	type: string;
	count: number;
	references: string[];
}

interface TextNode {
	start: number;
	end: number;
	open: string;
	close: string;
	text: string;
}

export function createOfficeEditTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	const policy = createPathPolicy(allowedPaths, workspaceDir);
	return [createDocxEditTool(policy), createPptxEditTool(policy)];
}

function createDocxEditTool(policy: PathPolicy): ToolDefinition {
	return {
		name: "docx_edit",
		description:
			"Safely edit an existing DOCX into a different outputPath while preserving unaffected OOXML parts. Operations: {type:'replaceText', find, replace}, {type:'appendParagraphs', paragraphs:[string|{text}]}, and {type:'removeParagraphsContaining', text}. Literal text replacement supports matches split across runs.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Input .docx path", required: true },
			outputPath: { type: "string", description: "Different output .docx path", required: true },
			operations: { type: "array", description: "Ordered DOCX edit operations (array or JSON array string)", required: true },
			overwriteOutput: { type: "boolean", description: "Replace an existing output file, default false", required: false },
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const prepared = await prepareEdit(params, "docx", policy);
			const zip = openSafeOfficeZip(prepared.inputBuffer, "docx");
			const entries = zip.getEntries().filter((entry) =>
				/^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(entry.entryName),
			);
			const xmlByPart = new Map(entries.map((entry) => [entry.entryName, entry.getData().toString("utf8")]));
			const changedParts = new Set<string>();
			const changes: EditChange[] = [];

			for (const [operationIndex, operation] of prepared.operations.entries()) {
				const references = new Set<string>();
				let count = 0;
				if (operation.type === "replaceText") {
					const find = operationText(operation.find, "replaceText.find", false);
					const replacement = operationText(operation.replace, "replaceText.replace", true);
					for (const [part, xml] of xmlByPart) {
						const result = transformParagraphs(xml, "w:p", (paragraph, paragraphNumber) => {
							const replaced = replaceLiteralAcrossRuns(paragraph, "w:t", find, replacement);
							if (replaced.count > 0) references.add(docxParagraphRef(part, paragraphNumber));
							return replaced;
						});
						if (result.count > 0) {
							xmlByPart.set(part, result.xml);
							changedParts.add(part);
							count += result.count;
						}
					}
				} else if (operation.type === "removeParagraphsContaining") {
					const needle = operationText(operation.text, "removeParagraphsContaining.text", false);
					for (const [part, xml] of xmlByPart) {
						const result = transformParagraphs(xml, "w:p", (paragraph, paragraphNumber) => {
							if (!textFromNodes(paragraph, "w:t").includes(needle)) return { xml: paragraph, count: 0 };
							references.add(docxParagraphRef(part, paragraphNumber));
							return { xml: "", count: 1 };
						});
						if (result.count > 0) {
							const validTableCells = ensureDocxTableCellsHaveParagraphs(result.xml);
							xmlByPart.set(part, validTableCells);
							changedParts.add(part);
							count += result.count;
						}
					}
				} else if (operation.type === "appendParagraphs") {
					const paragraphs = parseParagraphs(operation.paragraphs);
					const part = "word/document.xml";
					const documentXml = xmlByPart.get(part);
					if (!documentXml) throw new Error("Invalid DOCX package: missing word/document.xml");
					const appended = appendDocxParagraphs(documentXml, paragraphs);
					xmlByPart.set(part, appended);
					changedParts.add(part);
					count = paragraphs.length;
					for (let index = 0; index < paragraphs.length; index++) {
						references.add(`docx:document.xml/appended:${index + 1}`);
					}
				} else {
					throw new Error(`Unsupported DOCX operation: ${operation.type}`);
				}
				changes.push({ operationIndex, type: operation.type, count, references: [...references] });
			}

			for (const part of changedParts) {
				const xml = xmlByPart.get(part);
				if (xml !== undefined) zip.updateFile(part, Buffer.from(xml, "utf8"));
			}
			return finishEdit(prepared, zip, "docx", changedParts, changes);
		}),
	};
}

function createPptxEditTool(policy: PathPolicy): ToolDefinition {
	return {
		name: "pptx_edit",
		description:
			"Safely edit an existing PPTX into a different outputPath while preserving unaffected OOXML parts. Operations: {type:'replaceText', find, replace, slides?} and {type:'removeShapesContaining', text, slides?}. Text matching is literal, global within selected slides, and supports text split across runs.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Input .pptx path", required: true },
			outputPath: { type: "string", description: "Different output .pptx path", required: true },
			operations: { type: "array", description: "Ordered PPTX edit operations (array or JSON array string)", required: true },
			slides: { type: "string", description: "Optional default slide selection, e.g. 1-3,5; operations may override it", required: false },
			overwriteOutput: { type: "boolean", description: "Replace an existing output file, default false", required: false },
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const prepared = await prepareEdit(params, "pptx", policy);
			const zip = openSafeOfficeZip(prepared.inputBuffer, "pptx");
			const entries = zip
				.getEntries()
				.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
				.sort((left, right) => slideNumber(left.entryName) - slideNumber(right.entryName));
			const availableSlides = new Set(entries.map((entry) => slideNumber(entry.entryName)));
			const defaultSlides = parseSlideSelection(params.slides, "slides");
			assertSlidesExist(defaultSlides, availableSlides);
			const xmlByPart = new Map(entries.map((entry) => [entry.entryName, entry.getData().toString("utf8")]));
			const changedParts = new Set<string>();
			const changes: EditChange[] = [];

			for (const [operationIndex, operation] of prepared.operations.entries()) {
				const operationSlides = operation.slides === undefined
					? defaultSlides
					: parseSlideSelection(operation.slides, `operations[${operationIndex}].slides`);
				assertSlidesExist(operationSlides, availableSlides);
				const references = new Set<string>();
				let count = 0;
				if (operation.type === "replaceText") {
					const find = operationText(operation.find, "replaceText.find", false);
					const replacement = operationText(operation.replace, "replaceText.replace", true);
					for (const [part, xml] of xmlByPart) {
						const slide = slideNumber(part);
						if (operationSlides && !operationSlides.has(slide)) continue;
						const result = transformParagraphs(xml, "a:p", (paragraph, paragraphNumber) => {
							const replaced = replaceLiteralAcrossRuns(paragraph, "a:t", find, replacement);
							if (replaced.count > 0) references.add(`pptx:slide:${slide}/p:${paragraphNumber}`);
							return replaced;
						});
						if (result.count > 0) {
							xmlByPart.set(part, result.xml);
							changedParts.add(part);
							count += result.count;
						}
					}
				} else if (operation.type === "removeShapesContaining") {
					const needle = operationText(operation.text, "removeShapesContaining.text", false);
					for (const [part, xml] of xmlByPart) {
						const slide = slideNumber(part);
						if (operationSlides && !operationSlides.has(slide)) continue;
						const result = removePptxShapes(xml, needle, slide);
						if (result.count > 0) {
							xmlByPart.set(part, result.xml);
							changedParts.add(part);
							count += result.count;
							for (const reference of result.references) references.add(reference);
						}
					}
				} else {
					throw new Error(`Unsupported PPTX operation: ${operation.type}`);
				}
				changes.push({ operationIndex, type: operation.type, count, references: [...references] });
			}

			for (const part of changedParts) {
				const xml = xmlByPart.get(part);
				if (xml !== undefined) zip.updateFile(part, Buffer.from(xml, "utf8"));
			}
			return finishEdit(prepared, zip, "pptx", changedParts, changes);
		}),
	};
}

async function prepareEdit(params: JsonObject, kind: OfficeKind, policy: PathPolicy) {
	const inputPath = policy.resolve(requiredString(params.path, "path"));
	const outputPath = policy.resolve(requiredString(params.outputPath, "outputPath"));
	if (path.extname(inputPath).toLowerCase() !== `.${kind}` || path.extname(outputPath).toLowerCase() !== `.${kind}`) {
		throw new Error(`${kind.toUpperCase()} editing requires .${kind} input and output paths`);
	}
	await policy.input(inputPath);
	await policy.output(outputPath);
	await assertDifferentFiles(inputPath, outputPath);
	const inputInfo = await stat(inputPath);
	if (!inputInfo.isFile()) throw new Error(`Input is not a regular file: ${inputPath}`);
	if (inputInfo.size > MAX_ARCHIVE_BYTES) throw new Error("Office package exceeds the compressed size limit");
	if (params.overwriteOutput !== true && await exists(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
	return {
		inputPath,
		outputPath,
		inputBuffer: await readFile(inputPath),
		operations: parseOperations(params.operations),
		overwriteOutput: params.overwriteOutput === true,
		policy,
	};
}

async function finishEdit(
	prepared: Awaited<ReturnType<typeof prepareEdit>>,
	zip: AdmZip,
	kind: OfficeKind,
	changedParts: Set<string>,
	changes: EditChange[],
): Promise<{ output: string; metadata: JsonObject }> {
	const outputBuffer = changedParts.size === 0 ? prepared.inputBuffer : zip.toBuffer();
	openSafeOfficeZip(outputBuffer, kind);
	await prepared.policy.output(prepared.outputPath);
	await assertDifferentFiles(prepared.inputPath, prepared.outputPath);
	await atomicWrite(prepared.outputPath, outputBuffer, prepared.overwriteOutput);
	const result = {
		schemaVersion: "octopus.office.v1",
		operation: `${kind}_edit`,
		input: {
			path: prepared.inputPath,
			size: prepared.inputBuffer.length,
			sha256: sha256(prepared.inputBuffer),
		},
		output: {
			path: prepared.outputPath,
			size: outputBuffer.length,
			sha256: sha256(outputBuffer),
		},
		changes,
		changedParts: [...changedParts],
		totalChanges: changes.reduce((sum, change) => sum + change.count, 0),
	};
	return {
		output: JSON.stringify(result, null, 2),
		metadata: {
			outputPath: prepared.outputPath,
			changedParts: changedParts.size,
			totalChanges: result.totalChanges,
		},
	};
}

function transformParagraphs(
	xml: string,
	paragraphTag: "w:p" | "a:p",
	transform: (paragraph: string, paragraphNumber: number) => { xml: string; count: number },
) {
	let paragraphNumber = 0;
	let count = 0;
	const pattern = new RegExp(`<${paragraphTag}\\b[^>]*>[\\s\\S]*?<\\/${paragraphTag}>`, "g");
	const output = xml.replace(pattern, (paragraph) => {
		paragraphNumber++;
		const result = transform(paragraph, paragraphNumber);
		count += result.count;
		return result.xml;
	});
	return { xml: output, count };
}

function replaceLiteralAcrossRuns(paragraph: string, textTag: "w:t" | "a:t", find: string, replacement: string) {
	const nodes = collectTextNodes(paragraph, textTag);
	if (nodes.length === 0) return { xml: paragraph, count: 0 };
	const combined = nodes.map((node) => node.text).join("");
	const positions: number[] = [];
	for (let offset = 0; offset <= combined.length - find.length;) {
		const found = combined.indexOf(find, offset);
		if (found < 0) break;
		positions.push(found);
		offset = found + find.length;
	}
	if (positions.length === 0) return { xml: paragraph, count: 0 };
	for (const start of positions.reverse()) {
		const end = start + find.length - 1;
		const startLocation = locateTextOffset(nodes, start);
		const endLocation = locateTextOffset(nodes, end);
		if (!startLocation || !endLocation) continue;
		const first = nodes[startLocation.node];
		const last = nodes[endLocation.node];
		if (!first || !last) continue;
		if (startLocation.node === endLocation.node) {
			first.text = first.text.slice(0, startLocation.offset) + replacement + first.text.slice(endLocation.offset + 1);
			continue;
		}
		first.text = first.text.slice(0, startLocation.offset) + replacement;
		for (let node = startLocation.node + 1; node < endLocation.node; node++) {
			const middle = nodes[node];
			if (middle) middle.text = "";
		}
		last.text = last.text.slice(endLocation.offset + 1);
	}
	let output = "";
	let cursor = 0;
	for (const node of nodes) {
		output += paragraph.slice(cursor, node.start);
		const openTag = preserveSpaceIfNeeded(node.open, node.text);
		output += `${openTag}${encodeXml(node.text)}${node.close}`;
		cursor = node.end;
	}
	output += paragraph.slice(cursor);
	return { xml: output, count: positions.length };
}

function collectTextNodes(xml: string, textTag: "w:t" | "a:t"): TextNode[] {
	const pattern = new RegExp(`(<${textTag}\\b[^>]*>)([\\s\\S]*?)(<\\/${textTag}>)`, "g");
	return [...xml.matchAll(pattern)].map((match) => ({
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
		open: match[1] ?? "",
		close: match[3] ?? "",
		text: decodeXml(match[2] ?? ""),
	}));
}

function locateTextOffset(nodes: TextNode[], target: number) {
	let cursor = 0;
	for (let node = 0; node < nodes.length; node++) {
		const text = nodes[node]?.text ?? "";
		if (target >= cursor && target < cursor + text.length) return { node, offset: target - cursor };
		cursor += text.length;
	}
	return null;
}

function textFromNodes(xml: string, textTag: "w:t" | "a:t") {
	return collectTextNodes(xml, textTag).map((node) => node.text).join("");
}

function removePptxShapes(xml: string, needle: string, slide: number) {
	let shapeNumber = 0;
	let count = 0;
	const references: string[] = [];
	const output = xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g, (shape) => {
		shapeNumber++;
		if (!textFromNodes(shape, "a:t").includes(needle)) return shape;
		count++;
		references.push(`pptx:slide:${slide}/shape:${shapeNumber}`);
		return "";
	});
	return { xml: output, count, references };
}

function appendDocxParagraphs(documentXml: string, paragraphs: string[]): string {
	const bodyClose = documentXml.lastIndexOf("</w:body>");
	if (bodyClose < 0) throw new Error("Invalid DOCX document XML: missing w:body");
	const bodyOpen = documentXml.lastIndexOf("<w:body", bodyClose);
	if (bodyOpen < 0) throw new Error("Invalid DOCX document XML: missing w:body");
	const sectionProperties = documentXml.lastIndexOf("<w:sectPr", bodyClose);
	const insertionPoint = sectionProperties > bodyOpen ? sectionProperties : bodyClose;
	const paragraphXml = paragraphs
		.map((text) => `<w:p><w:r><w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r></w:p>`)
		.join("");
	return documentXml.slice(0, insertionPoint) + paragraphXml + documentXml.slice(insertionPoint);
}

function ensureDocxTableCellsHaveParagraphs(xml: string): string {
	return xml.replace(/(<w:tc\b[^>]*>[\s\S]*?)(<\/w:tc>)/g, (cell, content: string, close: string) => {
		return /<w:p(?:\s|>)/.test(content) ? cell : `${content}<w:p/>${close}`;
	});
}

function parseParagraphs(value: unknown): string[] {
	const parsed = parseJson(value, "appendParagraphs.paragraphs");
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("appendParagraphs.paragraphs must be a non-empty array");
	return parsed.map((item, index) => {
		const text = typeof item === "string"
			? item
			: item && typeof item === "object" && !Array.isArray(item)
				? (item as JsonObject).text
				: undefined;
		return operationText(text, `appendParagraphs.paragraphs[${index}]`, true);
	});
}

function parseOperations(value: unknown): EditOperation[] {
	const parsed = parseJson(value, "operations");
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("operations must be a non-empty array or JSON array string");
	if (parsed.length > MAX_OPERATIONS) throw new Error(`operations exceeds the limit of ${MAX_OPERATIONS}`);
	return parsed.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`operations[${index}] must be an object`);
		const object = item as JsonObject;
		return { ...object, type: requiredString(object.type, `operations[${index}].type`) };
	});
}

function parseJson(value: unknown, name: string): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`${name} must contain valid JSON`);
	}
}

function parseSlideSelection(value: unknown, name: string): Set<number> | null {
	if (value === undefined || value === null || value === "") return null;
	const selected = new Set<number>();
	if (Array.isArray(value)) {
		for (const item of value) addSlide(selected, Number(item), name);
		return selected;
	}
	if (typeof value === "number") {
		addSlide(selected, value, name);
		return selected;
	}
	if (typeof value !== "string") throw new Error(`${name} must be a slide number, array, or range string`);
	for (const rawPart of value.split(",")) {
		const part = rawPart.trim();
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (start > end) throw new Error(`Invalid descending slide range in ${name}: ${part}`);
			for (let slide = start; slide <= end; slide++) addSlide(selected, slide, name);
		} else if (/^\d+$/.test(part)) {
			addSlide(selected, Number(part), name);
		} else {
			throw new Error(`Invalid slide selection in ${name}: ${part}`);
		}
	}
	if (selected.size === 0) throw new Error(`${name} must select at least one slide`);
	return selected;
}

function addSlide(selected: Set<number>, slide: number, name: string) {
	if (!Number.isSafeInteger(slide) || slide < 1 || slide > 100_000) throw new Error(`${name} contains an invalid slide number`);
	selected.add(slide);
}

function assertSlidesExist(selected: Set<number> | null, available: Set<number>) {
	if (!selected) return;
	const missing = [...selected].filter((slide) => !available.has(slide));
	if (missing.length > 0) throw new Error(`Selected slide(s) do not exist: ${missing.join(", ")}`);
}

function openSafeOfficeZip(buffer: Buffer, expected: OfficeKind): AdmZip {
	if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error("Office package exceeds the compressed size limit");
	let zip: AdmZip;
	try {
		zip = new AdmZip(buffer);
	} catch (error) {
		throw new Error(`Invalid ${expected.toUpperCase()} ZIP package: ${error instanceof Error ? error.message : String(error)}`);
	}
	const entries = zip.getEntries();
	if (entries.length > MAX_ZIP_ENTRIES) throw new Error("Office package has too many ZIP entries");
	let totalUncompressed = 0;
	for (const entry of entries) {
		const name = entry.entryName;
		if (name.includes("\\") || name.includes("\0") || path.posix.isAbsolute(name) || name.split("/").includes("..")) {
			throw new Error(`Unsafe ZIP entry: ${name}`);
		}
		const uncompressed = entry.header.size;
		const compressed = entry.header.compressedSize;
		if (uncompressed > MAX_ENTRY_BYTES) throw new Error(`ZIP entry exceeds the size limit: ${name}`);
		totalUncompressed += uncompressed;
		if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("Office package is too large when decompressed");
		if (uncompressed > 0 && compressed === 0) throw new Error(`Invalid ZIP size metadata: ${name}`);
		if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) {
			throw new Error(`ZIP entry has an unsafe compression ratio: ${name}`);
		}
	}
	const required = expected === "docx" ? "word/document.xml" : "ppt/presentation.xml";
	if (!zip.getEntry(required)) throw new Error(`Invalid ${expected.toUpperCase()} package: missing ${required}`);
	const contentTypes = zip.getEntry("[Content_Types].xml")?.getData().toString("utf8") ?? "";
	const hasMacroPart = entries.some((entry) => /(^|\/)vbaProject(?:Signature)?\.bin$/i.test(entry.entryName));
	if (hasMacroPart || /macroEnabled|vbaProject/i.test(contentTypes)) {
		throw new Error("Macro-enabled Office packages are not supported");
	}
	return zip;
}

function createPathPolicy(allowedPaths: string[], workspaceDir: string): PathPolicy {
	const roots = allowedPaths.map((root) => path.resolve(expandHome(root)));
	const resolvedWorkspace = path.resolve(expandHome(workspaceDir));
	const resolve = (rawPath: string) => {
		const expanded = expandHome(rawPath);
		if (path.isAbsolute(expanded)) return path.resolve(expanded);
		const resolved = path.resolve(resolvedWorkspace, expanded);
		if (!isPathInsideAny(resolved, [resolvedWorkspace])) throw new Error(`Relative path escapes workspace: ${rawPath}`);
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

async function assertDifferentFiles(inputPath: string, outputPath: string) {
	if (samePath(inputPath, outputPath)) throw new Error("Input and output paths must be different");
	const [inputInfo, outputInfo] = await Promise.all([stat(inputPath), stat(outputPath).catch(() => null)]);
	if (outputInfo && inputInfo.dev === outputInfo.dev && inputInfo.ino === outputInfo.ino) {
		throw new Error("Input and output paths must refer to different files");
	}
}

async function atomicWrite(outputPath: string, buffer: Buffer, overwrite: boolean) {
	const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(tempPath, "wx", 0o600);
		await handle.writeFile(buffer);
		await handle.sync();
		await handle.close();
		handle = undefined;
		if (overwrite) await rename(tempPath, outputPath);
		else await link(tempPath, outputPath);
	} catch (error) {
		if (!overwrite && (error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Output already exists: ${outputPath}`);
		throw error;
	} finally {
		await handle?.close().catch(() => {});
		await rm(tempPath, { force: true }).catch(() => {});
	}
}

function operationText(value: unknown, name: string, allowEmpty: boolean): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
	if (value.length > MAX_TEXT_LENGTH) throw new Error(`${name} exceeds the text length limit`);
	if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`${name} contains characters invalid in XML 1.0`);
	return value;
}

function preserveSpaceIfNeeded(openTag: string, value: string) {
	if (!/^\s|\s$/.test(value) || /\bxml:space\s*=/.test(openTag)) return openTag;
	return openTag.replace(/>$/, ' xml:space="preserve">');
}

function decodeXml(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => decodeCodePoint(entity, Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (entity, decimal: string) => decodeCodePoint(entity, Number(decimal)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function decodeCodePoint(entity: string, codePoint: number) {
	return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
		? String.fromCodePoint(codePoint)
		: entity;
}

function encodeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function docxParagraphRef(part: string, paragraph: number) {
	return `docx:${part.replace(/^word\//, "")}/p:${paragraph}`;
}

function slideNumber(entryName: string): number {
	const match = /ppt\/slides\/slide(\d+)\.xml$/i.exec(entryName);
	if (!match) throw new Error(`Invalid slide part name: ${entryName}`);
	return Number(match[1]);
}

function requiredString(value: unknown, name: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new Error(`Missing required parameter '${name}'`);
	return text;
}

function samePath(left: string, right: string) {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function exists(filePath: string) {
	return stat(filePath).then(() => true, () => false);
}

function sha256(buffer: Buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

async function wrapResult(
	fn: () => Promise<{ output: string; metadata?: JsonObject }>,
): Promise<ToolResult> {
	try {
		return { success: true, ...await fn() };
	} catch (error) {
		return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
	}
}
