import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PassThrough } from "node:stream";
import {
	AlignmentType,
	Document,
	Footer,
	Header,
	HeadingLevel,
	ImageRun,
	Packer,
	PageNumber,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import pptxgen from "pptxgenjs";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const OFFICE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/></svg>`;

type JsonObject = Record<string, unknown>;

export function createOfficeTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	const resolveToolPath = (filePath: string): string => {
		const expanded = expandHome(filePath);
		if (path.isAbsolute(expanded)) return path.resolve(expanded);
		const resolved = path.resolve(workspaceDir, expanded);
		if (!isPathInsideAny(resolved, [workspaceDir])) {
			throw new Error(
				`Relative path '${filePath}' escapes the Octopus workspace. Use a workspace-relative path or an absolute path within allowed roots.`,
			);
		}
		return resolved;
	};

	const authorizeOutput = async (resolved: string): Promise<void> => {
		const roots = allowedPaths.map((p) => path.resolve(expandHome(p)));
		if (!isPathInsideAny(resolved, roots)) {
			throw new Error(`Access denied: path '${resolved}' is not within allowed paths`);
		}
		await assertRealPathInside(resolved, roots);
		await mkdir(path.dirname(resolved), { recursive: true });
		await assertRealPathInside(resolved, roots);
	};

	const authorizeInput = async (resolved: string): Promise<void> => {
		const roots = allowedPaths.map((p) => path.resolve(expandHome(p)));
		if (!isPathInsideAny(resolved, roots)) {
			throw new Error(`Access denied: path '${resolved}' is not within allowed paths`);
		}
		await assertRealPathInside(resolved, roots);
	};

	const docxCreate: ToolDefinition = {
		name: "docx_create",
		description:
			"Create a real .docx Word document with headings, paragraphs, tables, images, headers, footers, page numbers, and basic formatting. Pass content as JSON arrays; preserves aspect ratios by requiring image width/height.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Output .docx path", required: true },
			title: { type: "string", description: "Document title", required: false },
			header: { type: "string", description: "Optional header text", required: false },
			footer: { type: "string", description: "Optional footer text before page numbers", required: false },
			blocks: {
				type: "array",
				description:
					"Array of blocks: {type:'heading'|'paragraph'|'table'|'image'|'pageBreak', text?, level?, rows?: string[][], path?, width?, height?, caption?}. JSON string also accepted.",
				required: true,
			},
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const outPath = resolveToolPath(requiredString(params.path, "path"));
			await authorizeOutput(outPath);
			const blocks = parseArray(params.blocks, "blocks");
			const children: Array<Paragraph | Table> = [];
			const title = optionalString(params.title);
			if (title) {
				children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
			}
			for (const block of blocks) {
				const obj = asObject(block);
				const type = String(obj.type ?? "paragraph");
				if (type === "heading") {
					children.push(
						new Paragraph({
							text: String(obj.text ?? ""),
							heading: headingLevel(Number(obj.level ?? 1)),
						}),
					);
				} else if (type === "table") {
					children.push(makeDocxTable(parseRows(obj.rows)));
				} else if (type === "image") {
					const imagePath = resolveToolPath(requiredString(obj.path, "image path"));
					await authorizeInput(imagePath);
					children.push(
						new Paragraph({
							alignment: AlignmentType.CENTER,
							children: [
								new ImageRun({
									type: imageRunType(imagePath),
									data: await readFile(imagePath),
									transformation: {
										width: positiveNumber(obj.width, 480),
										height: positiveNumber(obj.height, 270),
									},
								}),
							],
						}),
					);
					if (obj.caption) {
						children.push(
							new Paragraph({
								alignment: AlignmentType.CENTER,
								children: [new TextRun({ text: String(obj.caption), italics: true })],
							}),
						);
					}
				} else if (type === "pageBreak") {
					children.push(new Paragraph({ pageBreakBefore: true }));
				} else {
					children.push(makeParagraph(String(obj.text ?? "")));
				}
			}
			const doc = new Document({
				sections: [
					{
						headers: optionalString(params.header)
							? { default: new Header({ children: [new Paragraph(optionalString(params.header) ?? "")] }) }
							: undefined,
						footers: {
							default: new Footer({
								children: [
									new Paragraph({
										alignment: AlignmentType.CENTER,
										children: [
											new TextRun(optionalString(params.footer) ?? "Page "),
											new TextRun({ children: [PageNumber.CURRENT] }),
											new TextRun(" of "),
											new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
										],
									}),
								],
							}),
						},
						children,
					},
				],
			});
			const buffer = await Packer.toBuffer(doc);
			await import("node:fs/promises").then((fs) => fs.writeFile(outPath, buffer));
			return `DOCX created: ${outPath} (${blocks.length} block(s))`;
		}),
	};

	const xlsxCreate: ToolDefinition = {
		name: "xlsx_create",
		description:
			"Create a real .xlsx workbook with sheets, rows, formulas, tables, styles, frozen panes, auto-filters, column widths, and number formats using ExcelJS.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Output .xlsx path", required: true },
			title: { type: "string", description: "Workbook title metadata", required: false },
			sheets: {
				type: "array",
				description:
					"Array: {name, columns?: string[], rows?: any[][], table?: boolean, freezeHeader?: boolean, formulas?: [{cell, formula, result}], widths?: number[]}. JSON string accepted.",
				required: true,
			},
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const outPath = resolveToolPath(requiredString(params.path, "path"));
			await authorizeOutput(outPath);
			const workbook = new ExcelJS.Workbook();
			workbook.creator = "Octopus AI";
			workbook.created = new Date();
			workbook.modified = new Date();
			workbook.title = optionalString(params.title) ?? "Octopus workbook";
			workbook.calcProperties.fullCalcOnLoad = true;
			const sheets = parseArray(params.sheets, "sheets");
			for (const sheetInput of sheets) {
				const spec = asObject(sheetInput);
				const name = sanitizeSheetName(String(spec.name ?? `Sheet${workbook.worksheets.length + 1}`));
				const ws = workbook.addWorksheet(name);
				const columns = Array.isArray(spec.columns) ? spec.columns.map(String) : [];
				if (columns.length > 0) {
					ws.addRow(columns);
					ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
					ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
				}
				for (const row of parseRows(spec.rows, false)) ws.addRow(row);
				if (spec.freezeHeader !== false && columns.length > 0) {
					ws.views = [{ state: "frozen", ySplit: 1 }];
					ws.autoFilter = { from: "A1", to: `${columnLetter(Math.max(columns.length, 1))}1` };
				}
				const widths = Array.isArray(spec.widths) ? spec.widths : [];
				for (let i = 1; i <= Math.max(columns.length, ws.columnCount); i++) {
					ws.getColumn(i).width = positiveNumber(widths[i - 1], inferColumnWidth(ws, i));
				}
				for (const formula of parseArray(spec.formulas ?? [], "formulas")) {
					const f = asObject(formula);
					ws.getCell(requiredString(f.cell, "formula cell")).value = {
						formula: requiredString(f.formula, "formula"),
						result: f.result as string | number | boolean | Date | undefined,
					};
				}
				if (spec.table && columns.length > 0 && ws.rowCount > 1) {
					ws.addTable({
						name: safeTableName(name),
						ref: "A1",
						headerRow: true,
						style: { theme: "TableStyleMedium2", showRowStripes: true },
						columns: columns.map((column) => ({ name: column, filterButton: true })),
						rows:
							ws.getRows(2, ws.rowCount - 1)?.map((row) =>
								Array.isArray(row.values) ? row.values.slice(1) : [],
							) ?? [],
					});
				}
			}
			await workbook.xlsx.writeFile(outPath);
			return `XLSX created: ${outPath} (${sheets.length} sheet(s))`;
		}),
	};

	const xlsxEdit: ToolDefinition = {
		name: "xlsx_edit",
		description:
			"Edit an existing .xlsx workbook safely: set cell values/formulas/styles, append rows, create sheets, and save to a new output path.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Input .xlsx path", required: true },
			outputPath: { type: "string", description: "Output .xlsx path", required: true },
			updates: {
				type: "array",
				description:
					"Array updates: {sheet, cell, value?, formula?, result?, numFmt?, bold?, fillColor?} or {sheet, appendRows: any[][]}. JSON string accepted.",
				required: true,
			},
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const inputPath = resolveToolPath(requiredString(params.path, "path"));
			await authorizeInput(inputPath);
			const outPath = resolveToolPath(requiredString(params.outputPath, "outputPath"));
			await authorizeOutput(outPath);
			const workbook = new ExcelJS.Workbook();
			await workbook.xlsx.readFile(inputPath);
			const updates = parseArray(params.updates, "updates");
			for (const update of updates) {
				const spec = asObject(update);
				const ws = workbook.getWorksheet(String(spec.sheet ?? "Sheet1")) ?? workbook.addWorksheet(String(spec.sheet ?? "Sheet1"));
				if (spec.appendRows) {
					for (const row of parseRows(spec.appendRows, false)) ws.addRow(row);
					continue;
				}
				const cell = ws.getCell(requiredString(spec.cell, "cell"));
				if (spec.formula) {
					cell.value = { formula: String(spec.formula), result: spec.result as string | number | boolean | Date | undefined };
				} else if (Object.hasOwn(spec, "value")) {
					cell.value = spec.value as string | number | boolean | Date | null;
				}
				if (spec.numFmt) cell.numFmt = String(spec.numFmt);
				if (spec.bold) cell.font = { ...(cell.font ?? {}), bold: true };
				if (spec.fillColor) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: normalizeArgb(String(spec.fillColor)) } };
			}
			workbook.modified = new Date();
			workbook.calcProperties.fullCalcOnLoad = true;
			await workbook.xlsx.writeFile(outPath);
			return `XLSX edited: ${outPath} (${updates.length} update(s))`;
		}),
	};

	const pptxCreate: ToolDefinition = {
		name: "pptx_create",
		description:
			"Create a real .pptx presentation with professional slide layouts, titles, bullets, images, tables, speaker notes, and theme colors using PptxGenJS.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Output .pptx path", required: true },
			title: { type: "string", description: "Presentation title", required: false },
			subject: { type: "string", description: "Presentation subject", required: false },
			slides: {
				type: "array",
				description:
					"Array slides: {title, subtitle?, bullets?: string[], notes?, imagePath?, table?: string[][]}. JSON string accepted.",
				required: true,
			},
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const outPath = resolveToolPath(requiredString(params.path, "path"));
			await authorizeOutput(outPath);
			const PptxGen = pptxgen as unknown as { new (): any };
			const pptx = new PptxGen();
			pptx.layout = "LAYOUT_WIDE";
			pptx.author = "Octopus AI";
			pptx.company = "Octopus AI";
			pptx.subject = optionalString(params.subject) ?? "Generated presentation";
			pptx.title = optionalString(params.title) ?? "Octopus presentation";
			pptx.theme = {
				headFontFace: "Aptos Display",
				bodyFontFace: "Aptos",
				lang: "es-ES",
			};
			const slides = parseArray(params.slides, "slides");
			for (const [index, slideInput] of slides.entries()) {
				const spec = asObject(slideInput);
				const slide = pptx.addSlide();
				slide.background = { color: index === 0 ? "0F172A" : "FFFFFF" };
				const titleColor = index === 0 ? "FFFFFF" : "0F172A";
				slide.addText(String(spec.title ?? `Slide ${index + 1}`), {
					x: 0.55,
					y: 0.35,
					w: 12.2,
					h: 0.55,
					fontSize: index === 0 ? 34 : 26,
					bold: true,
					color: titleColor,
					margin: 0,
					fit: "shrink",
				});
				if (spec.subtitle) {
					slide.addText(String(spec.subtitle), { x: 0.6, y: 1.0, w: 11.8, h: 0.45, fontSize: 16, color: index === 0 ? "CBD5E1" : "475569" });
				}
				const bullets = Array.isArray(spec.bullets) ? spec.bullets.map(String) : [];
				if (bullets.length > 0) {
					slide.addText(bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, hanging: 6 } })), {
						x: 0.8,
						y: spec.subtitle ? 1.65 : 1.25,
						w: spec.imagePath ? 6.2 : 11.6,
						h: 4.5,
						fontSize: 16,
						breakLine: false,
						fit: "shrink",
						color: index === 0 ? "E2E8F0" : "1E293B",
					});
				}
				if (spec.imagePath) {
					const imagePath = resolveToolPath(String(spec.imagePath));
					await authorizeInput(imagePath);
					slide.addImage({ path: imagePath, x: 7.25, y: 1.35, w: 5.2, h: 4.4, sizing: { type: "contain", w: 5.2, h: 4.4 } });
				}
				if (spec.table) {
					slide.addTable(parseRows(spec.table).map((row) => row.map((cell) => ({ text: String(cell) }))), {
						x: 0.7,
						y: bullets.length > 0 ? 5.35 : 1.35,
						w: 11.9,
						h: 1.4,
						fontSize: 10,
						border: { color: "CBD5E1", pt: 1 },
						color: "0F172A",
					});
				}
				if (spec.notes) slide.addNotes(String(spec.notes));
				slide.addText(`${index + 1}`, { x: 12.35, y: 7.05, w: 0.35, h: 0.2, fontSize: 9, color: index === 0 ? "94A3B8" : "64748B" });
			}
			await pptx.writeFile({ fileName: outPath });
			return `PPTX created: ${outPath} (${slides.length} slide(s))`;
		}),
	};

	const pdfCreate: ToolDefinition = {
		name: "pdf_create",
		description:
			"Create a real PDF report with headings, paragraphs, tables, images, and page breaks. Best for clean generated reports; use PDF edit tools for existing PDFs.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Output .pdf path", required: true },
			title: { type: "string", description: "PDF title", required: false },
			blocks: {
				type: "array",
				description:
					"Array blocks: {type:'heading'|'paragraph'|'table'|'image'|'pageBreak', text?, rows?: string[][], path?, width?, height?}. JSON string accepted.",
				required: true,
			},
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const outPath = resolveToolPath(requiredString(params.path, "path"));
			await authorizeOutput(outPath);
			await createPdfWithPdfkit(outPath, optionalString(params.title), parseArray(params.blocks, "blocks"), resolveToolPath, authorizeInput);
			return `PDF created: ${outPath}`;
		}),
	};

	const pdfPages: ToolDefinition = {
		name: "pdf_pages",
		description:
			"Merge PDFs or extract selected pages to a new PDF using pdf-lib. Actions: merge, extract. For extract, provide source and pages like '1-3,8'.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			action: { type: "string", description: "merge or extract", required: true },
			outputPath: { type: "string", description: "Output .pdf path", required: true },
			inputPaths: { type: "array", description: "For merge: array of input PDF paths. JSON string accepted.", required: false },
			source: { type: "string", description: "For extract: input PDF path", required: false },
			pages: { type: "string", description: "For extract: page range like '1-3,8'", required: false },
		},
		handler: async (params): Promise<ToolResult> => wrapResult(async () => {
			const outPath = resolveToolPath(requiredString(params.outputPath, "outputPath"));
			await authorizeOutput(outPath);
			const output = await PDFDocument.create();
			const action = String(params.action ?? "").toLowerCase();
			if (action === "merge") {
				const inputPaths = parseArray(params.inputPaths, "inputPaths").map((p) => resolveToolPath(String(p)));
				for (const inputPath of inputPaths) {
					await authorizeInput(inputPath);
					const sourcePdf = await PDFDocument.load(await readFile(inputPath));
					const copied = await output.copyPages(sourcePdf, sourcePdf.getPageIndices());
					for (const page of copied) output.addPage(page);
				}
			} else if (action === "extract") {
				const source = resolveToolPath(requiredString(params.source, "source"));
				await authorizeInput(source);
				const sourcePdf = await PDFDocument.load(await readFile(source));
				const indices = parsePageIndices(optionalString(params.pages), sourcePdf.getPageCount());
				const copied = await output.copyPages(sourcePdf, indices);
				for (const page of copied) output.addPage(page);
			} else {
				throw new Error("action must be 'merge' or 'extract'");
			}
			const bytes = await output.save();
			await import("node:fs/promises").then((fs) => fs.writeFile(outPath, bytes));
			return `PDF ${action} saved: ${outPath} (${output.getPageCount()} page(s))`;
		}),
	};

	return [docxCreate, xlsxCreate, xlsxEdit, pptxCreate, pdfCreate, pdfPages];
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

function parseArray(value: unknown, name: string): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed;
	}
	if (value === undefined || value === null || value === "") return [];
	throw new Error(`Parameter '${name}' must be an array or JSON array string`);
}

function asObject(value: unknown): JsonObject {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
	throw new Error("Expected object item");
}

function parseRows(value: unknown, strict = true): Array<Array<string | number | boolean | Date | null>> {
	const rows = parseArray(value, "rows");
	if (!strict && rows.length === 0) return [];
	return rows.map((row) => {
		if (!Array.isArray(row)) throw new Error("Rows must be arrays");
		return row.map((cell) => cell as string | number | boolean | Date | null);
	});
}

function headingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
	if (level <= 1) return HeadingLevel.HEADING_1;
	if (level === 2) return HeadingLevel.HEADING_2;
	if (level === 3) return HeadingLevel.HEADING_3;
	if (level === 4) return HeadingLevel.HEADING_4;
	if (level === 5) return HeadingLevel.HEADING_5;
	return HeadingLevel.HEADING_6;
}

function imageRunType(filePath: string): "png" | "jpg" | "gif" | "bmp" {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "jpg";
	if (ext === ".gif") return "gif";
	if (ext === ".bmp") return "bmp";
	return "png";
}

function makeParagraph(text: string): Paragraph {
	return new Paragraph({ children: [new TextRun(text)] });
}

function makeDocxTable(rows: Array<Array<unknown>>): Table {
	return new Table({
		width: { size: 100, type: WidthType.PERCENTAGE },
		rows: rows.map(
			(row, rowIndex) =>
				new TableRow({
					children: row.map(
						(cell) =>
							new TableCell({
								children: [new Paragraph({ children: [new TextRun({ text: String(cell ?? ""), bold: rowIndex === 0 })] })],
							}),
					),
				}),
		),
	});
}

function positiveNumber(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sanitizeSheetName(name: string): string {
	return name.replace(/[\\/?*\[\]:]/g, " ").trim().slice(0, 31) || "Sheet";
}

function safeTableName(name: string): string {
	return `${name.replace(/[^A-Za-z0-9_]/g, "_")}_Table`.replace(/^\d/, "T$&").slice(0, 255);
}

function inferColumnWidth(ws: ExcelJS.Worksheet, columnIndex: number): number {
	let max = 10;
	ws.getColumn(columnIndex).eachCell({ includeEmpty: false }, (cell) => {
		max = Math.max(max, String(cell.text ?? cell.value ?? "").length + 2);
	});
	return Math.min(max, 48);
}

function columnLetter(n: number): string {
	let result = "";
	let value = n;
	while (value > 0) {
		const mod = (value - 1) % 26;
		result = String.fromCharCode(65 + mod) + result;
		value = Math.floor((value - mod) / 26);
	}
	return result;
}

function normalizeArgb(color: string): string {
	const cleaned = color.replace(/^#/, "").toUpperCase();
	if (/^[0-9A-F]{8}$/.test(cleaned)) return cleaned;
	if (/^[0-9A-F]{6}$/.test(cleaned)) return `FF${cleaned}`;
	return "FFFFFF00";
}

function parsePageIndices(spec: string | undefined, totalPages: number): number[] {
	if (!spec) return Array.from({ length: totalPages }, (_, i) => i);
	const set = new Set<number>();
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			for (let p = start; p <= end; p++) if (p >= 1 && p <= totalPages) set.add(p - 1);
		} else if (/^\d+$/.test(trimmed)) {
			const p = Number(trimmed);
			if (p >= 1 && p <= totalPages) set.add(p - 1);
		}
	}
	return [...set].sort((a, b) => a - b);
}

async function createPdfWithPdfkit(
	outPath: string,
	title: string | undefined,
	blocks: unknown[],
	resolveToolPath: (filePath: string) => string,
	authorizeInput: (resolved: string) => Promise<void>,
): Promise<void> {
	const { default: PDFDocumentCtor } = (await import("pdfkit")) as unknown as {
		default: new (opts?: JsonObject) => {
			pipe: (stream: PassThrough | ReturnType<typeof createWriteStream>) => void;
			fontSize: (size: number) => { text: (text: string, opts?: JsonObject) => unknown };
			font: (name: string) => unknown;
			text: (text: string, opts?: JsonObject) => unknown;
			moveDown: (lines?: number) => unknown;
			addPage: () => unknown;
			image: (path: string, opts?: JsonObject) => unknown;
			end: () => void;
		};
	};
	const doc = new PDFDocumentCtor({ margin: 54, size: "A4", info: { Title: title ?? "Octopus PDF" } });
	const stream = createWriteStream(outPath);
	doc.pipe(stream);
	if (title) {
		doc.fontSize(22).text(title, { align: "left" });
		doc.moveDown(1);
	}
	for (const block of blocks) {
		const obj = asObject(block);
		const type = String(obj.type ?? "paragraph");
		if (type === "heading") {
			doc.moveDown(0.5);
			doc.font("Helvetica-Bold");
			doc.fontSize(16).text(String(obj.text ?? ""));
			doc.font("Helvetica");
			doc.moveDown(0.4);
		} else if (type === "table") {
			for (const row of parseRows(obj.rows)) doc.fontSize(9).text(row.map((cell) => String(cell ?? "")).join("   |   "));
			doc.moveDown(0.6);
		} else if (type === "image") {
			const imagePath = resolveToolPath(requiredString(obj.path, "image path"));
			await authorizeInput(imagePath);
			doc.image(imagePath, { fit: [positiveNumber(obj.width, 480), positiveNumber(obj.height, 260)], align: "center" });
			doc.moveDown(0.8);
		} else if (type === "pageBreak") {
			doc.addPage();
		} else {
			doc.fontSize(11).text(String(obj.text ?? ""), { align: "left" });
			doc.moveDown(0.5);
		}
	}
	doc.end();
	await new Promise<void>((resolve, reject) => {
		stream.on("finish", resolve);
		stream.on("error", reject);
	});
}

async function wrapResult(fn: () => Promise<string>): Promise<ToolResult> {
	try {
		return { success: true, output: await fn() };
	} catch (err) {
		return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
	}
}
