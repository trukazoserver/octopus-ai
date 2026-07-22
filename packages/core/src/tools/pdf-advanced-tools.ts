import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	PDFCheckBox,
	PDFDocument,
	PDFDropdown,
	PDFOptionList,
	PDFRadioGroup,
	PDFTextField,
	degrees,
	rgb,
} from "pdf-lib";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const PDF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`;
const MAX_PDF_BYTES = 250 * 1024 * 1024;
type JsonObject = Record<string, unknown>;

export function createPdfAdvancedTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	const roots = allowedPaths.map((root) => path.resolve(expandHome(root)));
	const resolve = (raw: string) => {
		const expanded = expandHome(raw);
		if (path.isAbsolute(expanded)) return path.resolve(expanded);
		const resolved = path.resolve(workspaceDir, expanded);
		if (!isPathInsideAny(resolved, [workspaceDir])) throw new Error(`Relative path escapes workspace: ${raw}`);
		return resolved;
	};
	const authorize = async (resolved: string) => {
		if (!isPathInsideAny(resolved, roots)) throw new Error(`Access denied: ${resolved}`);
		await assertRealPathInside(resolved, roots);
	};
	const output = async (resolved: string) => {
		await authorize(resolved);
		await mkdir(path.dirname(resolved), { recursive: true });
		await authorize(resolved);
	};

	const formTool: ToolDefinition = {
		name: "pdf_form",
		description:
			"Inspect or fill AcroForm fields in a PDF. Actions: inspect, fill. Fill supports text fields, checkboxes, dropdowns, option lists, and radio groups; optionally flatten fields. Always saves to a new output for fill.",
		uiIcon: PDF_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			action: { type: "string", description: "inspect or fill", required: true },
			path: { type: "string", description: "Input PDF path", required: true },
			outputPath: { type: "string", description: "Output PDF path for fill", required: false },
			values: { type: "object", description: "Field-name to scalar/array value mapping", required: false },
			flatten: { type: "boolean", description: "Flatten form after filling, default false", required: false },
			overwriteOutput: { type: "boolean", description: "Overwrite existing output, default false", required: false },
		},
		handler: async (params): Promise<ToolResult> => wrap(async () => {
			const inputPath = resolve(requiredString(params.path, "path"));
			await authorize(inputPath);
			const bytes = await readBoundedPdf(inputPath);
			const doc = await PDFDocument.load(bytes);
			const form = doc.getForm();
			const fields = form.getFields().map((field) => ({
				name: field.getName(),
				type: field.constructor.name,
				value: readFieldValue(field),
			}));
			const action = String(params.action ?? "").toLowerCase();
			if (action === "inspect") {
				return { output: JSON.stringify({ operation: "pdf_form_inspect", path: inputPath, pages: doc.getPageCount(), fields }, null, 2), metadata: { fields: fields.length } };
			}
			if (action !== "fill") throw new Error("action must be inspect or fill");
			const outputPath = resolve(requiredString(params.outputPath, "outputPath"));
			await output(outputPath);
			assertDifferent(inputPath, outputPath);
			const values = parseObject(params.values, "values");
			let updated = 0;
			for (const field of form.getFields()) {
				if (!Object.hasOwn(values, field.getName())) continue;
				setFieldValue(field, values[field.getName()]);
				updated++;
			}
			if (params.flatten === true) form.flatten();
			const outputBytes = Buffer.from(await doc.save());
			await atomicWrite(outputPath, outputBytes, params.overwriteOutput === true);
			return { output: JSON.stringify({ operation: "pdf_form_fill", inputPath, outputPath, updated, flattened: params.flatten === true, unusedKeys: Object.keys(values).filter((key) => !fields.some((field) => field.name === key)) }, null, 2), metadata: { outputPath, updated } };
		}),
	};

	const transformTool: ToolDefinition = {
		name: "pdf_transform",
		description:
			"Transform an existing PDF into a new file: rotate selected pages, add a visible watermark, and update title/author/subject metadata. This tool does not claim secure redaction.",
		uiIcon: PDF_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Input PDF path", required: true },
			outputPath: { type: "string", description: "Output PDF path", required: true },
			pages: { type: "string", description: "Selected pages for rotate/watermark, e.g. 1-3,8; default all", required: false },
			rotate: { type: "number", description: "Clockwise rotation: 0, 90, 180, or 270", required: false },
			watermark: { type: "string", description: "Optional visible watermark text", required: false },
			title: { type: "string", description: "Optional PDF title metadata", required: false },
			author: { type: "string", description: "Optional PDF author metadata", required: false },
			subject: { type: "string", description: "Optional PDF subject metadata", required: false },
			overwriteOutput: { type: "boolean", description: "Overwrite existing output, default false", required: false },
		},
		handler: async (params): Promise<ToolResult> => wrap(async () => {
			const inputPath = resolve(requiredString(params.path, "path"));
			const outputPath = resolve(requiredString(params.outputPath, "outputPath"));
			await authorize(inputPath);
			await output(outputPath);
			assertDifferent(inputPath, outputPath);
			const doc = await PDFDocument.load(await readBoundedPdf(inputPath));
			const selected = parsePages(optionalString(params.pages), doc.getPageCount());
			const rotation = params.rotate === undefined ? undefined : Number(params.rotate);
			if (rotation !== undefined && ![0, 90, 180, 270].includes(rotation)) throw new Error("rotate must be 0, 90, 180, or 270");
			const watermark = optionalString(params.watermark);
			for (const pageNumber of selected) {
				const page = doc.getPage(pageNumber - 1);
				if (rotation !== undefined) page.setRotation(degrees(rotation));
				if (watermark) {
					const { width, height } = page.getSize();
					page.drawText(watermark, { x: width * 0.18, y: height * 0.5, size: Math.max(18, Math.min(52, width / 12)), color: rgb(0.55, 0.55, 0.55), opacity: 0.28, rotate: degrees(35) });
				}
			}
			if (optionalString(params.title)) doc.setTitle(String(params.title));
			if (optionalString(params.author)) doc.setAuthor(String(params.author));
			if (optionalString(params.subject)) doc.setSubject(String(params.subject));
			const outputBytes = Buffer.from(await doc.save());
			await atomicWrite(outputPath, outputBytes, params.overwriteOutput === true);
			return { output: JSON.stringify({ operation: "pdf_transform", inputPath, outputPath, pages: selected, rotation, watermark: Boolean(watermark) }, null, 2), metadata: { outputPath, pages: selected.length } };
		}),
	};

	return [formTool, transformTool];
}

async function readBoundedPdf(filePath: string): Promise<Buffer> {
	const info = await stat(filePath);
	if (!info.isFile()) throw new Error("Input PDF must be a regular file");
	if (info.size > MAX_PDF_BYTES) throw new Error("PDF exceeds 250 MB limit");
	const bytes = await readFile(filePath);
	if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Input is not a valid PDF");
	return bytes;
}

function readFieldValue(field: unknown): unknown {
	if (field instanceof PDFTextField) return field.getText() ?? "";
	if (field instanceof PDFCheckBox) return field.isChecked();
	if (field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getSelected();
	if (field instanceof PDFRadioGroup) return field.getSelected();
	return null;
}

function setFieldValue(field: unknown, value: unknown): void {
	if (field instanceof PDFTextField) field.setText(String(value ?? ""));
	else if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck();
	else if (field instanceof PDFDropdown || field instanceof PDFOptionList) field.select(Array.isArray(value) ? value.map(String) : String(value ?? ""));
	else if (field instanceof PDFRadioGroup) field.select(String(value ?? ""));
	else throw new Error("Unsupported PDF form field type");
}

function parsePages(spec: string | undefined, total: number): number[] {
	if (!spec) return Array.from({ length: total }, (_, index) => index + 1);
	const pages = new Set<number>();
	for (const part of spec.split(",")) {
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
		if (range) {
			for (let page = Number(range[1]); page <= Number(range[2]); page++) if (page >= 1 && page <= total) pages.add(page);
		} else if (/^\d+$/.test(part.trim())) {
			const page = Number(part.trim());
			if (page >= 1 && page <= total) pages.add(page);
		}
	}
	if (pages.size === 0) throw new Error("pages did not select any valid PDF page");
	return [...pages].sort((a, b) => a - b);
}

function parseObject(value: unknown, name: string): JsonObject {
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be an object or JSON object string`);
	return parsed as JsonObject;
}

async function atomicWrite(outputPath: string, bytes: Buffer, overwrite: boolean): Promise<void> {
	if (!overwrite && await stat(outputPath).then(() => true, () => false)) throw new Error(`Output already exists: ${outputPath}`);
	const temporary = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (overwrite) await rm(outputPath, { force: true });
		await rename(temporary, outputPath);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

function assertDifferent(inputPath: string, outputPath: string): void {
	const left = path.resolve(inputPath);
	const right = path.resolve(outputPath);
	if (process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right) throw new Error("Input and output paths must be different");
}

function requiredString(value: unknown, name: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new Error(`Missing required parameter '${name}'`);
	return text;
}

function optionalString(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	return text || undefined;
}

async function wrap(fn: () => Promise<{ output: string; metadata?: JsonObject }>): Promise<ToolResult> {
	try {
		return { success: true, ...await fn() };
	} catch (error) {
		return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
	}
}
