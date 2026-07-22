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
	ShadingType,
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
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";

const OFFICE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/></svg>`;

type JsonObject = Record<string, unknown>;

type PptxThemePreset =
	| "executive"
	| "editorial"
	| "midnight"
	| "vibrant"
	| "swiss"
	| "dataJournalism"
	| "glassmorphism"
	| "memphis"
	| "risograph"
	| "cinematic";
type PptxRenderMode = "editable" | "hybrid" | "studio";
type PptxLayout =
	| "cover"
	| "section"
	| "statement"
	| "content"
	| "twoColumn"
	| "imageLeft"
	| "imageRight"
	| "fullImage"
	| "metrics"
	| "process"
	| "timeline"
	| "iconGrid"
	| "chart"
	| "table"
	| "quote"
	| "closing";

type ResolvedPptxTheme = {
	name: PptxThemePreset;
	headingFont: string;
	bodyFont: string;
	background: string;
	surface: string;
	text: string;
	muted: string;
	primary: string;
	secondary: string;
	accent: string;
	dark: string;
	motif:
		| "minimal"
		| "editorial"
		| "orbital"
		| "geometric"
		| "grid"
		| "data"
		| "glass"
		| "memphis"
		| "print"
		| "cinematic";
};

const PPTX_THEMES: Record<PptxThemePreset, ResolvedPptxTheme> = {
	executive: {
		name: "executive",
		headingFont: "Cambria",
		bodyFont: "Arial",
		background: "F6F8FB",
		surface: "FFFFFF",
		text: "172033",
		muted: "667085",
		primary: "1F4E79",
		secondary: "527A98",
		accent: "D4A72C",
		dark: "0B1F33",
		motif: "minimal",
	},
	editorial: {
		name: "editorial",
		headingFont: "Bookman Old Style",
		bodyFont: "Arial",
		background: "FFFFFF",
		surface: "F7F4F1",
		text: "251F1B",
		muted: "74665B",
		primary: "B44C36",
		secondary: "376C74",
		accent: "D8A23A",
		dark: "2B2420",
		motif: "editorial",
	},
	midnight: {
		name: "midnight",
		headingFont: "Cambria",
		bodyFont: "Arial",
		background: "08131F",
		surface: "102438",
		text: "F4F8FC",
		muted: "A7B7C8",
		primary: "38BDF8",
		secondary: "818CF8",
		accent: "F472B6",
		dark: "050B12",
		motif: "orbital",
	},
	vibrant: {
		name: "vibrant",
		headingFont: "Arial",
		bodyFont: "Arial",
		background: "F7F4FF",
		surface: "FFFFFF",
		text: "221C35",
		muted: "6F6682",
		primary: "6D28D9",
		secondary: "0F9D8A",
		accent: "F97316",
		dark: "241047",
		motif: "geometric",
	},
	swiss: {
		name: "swiss",
		headingFont: "Arial",
		bodyFont: "Arial",
		background: "FFFFFF",
		surface: "F2F2F2",
		text: "111111",
		muted: "606060",
		primary: "E10600",
		secondary: "111111",
		accent: "E10600",
		dark: "111111",
		motif: "grid",
	},
	dataJournalism: {
		name: "dataJournalism",
		headingFont: "Arial",
		bodyFont: "Arial",
		background: "0B1018",
		surface: "141C28",
		text: "F4F7FB",
		muted: "9FB0C3",
		primary: "F2B134",
		secondary: "3AA6B9",
		accent: "F25F5C",
		dark: "070A0F",
		motif: "data",
	},
	glassmorphism: {
		name: "glassmorphism",
		headingFont: "Arial",
		bodyFont: "Arial",
		background: "15102B",
		surface: "292044",
		text: "FFFFFF",
		muted: "C8C1DE",
		primary: "8B5CF6",
		secondary: "22D3EE",
		accent: "F472B6",
		dark: "0D0920",
		motif: "glass",
	},
	memphis: {
		name: "memphis",
		headingFont: "Arial",
		bodyFont: "Arial",
		background: "FFF7E8",
		surface: "FFFFFF",
		text: "202020",
		muted: "655F58",
		primary: "FF4D6D",
		secondary: "2EC4B6",
		accent: "FFB703",
		dark: "3A245B",
		motif: "memphis",
	},
	risograph: {
		name: "risograph",
		headingFont: "Bookman Old Style",
		bodyFont: "Arial",
		background: "FFF8E7",
		surface: "F8EED6",
		text: "222222",
		muted: "6A6257",
		primary: "EF476F",
		secondary: "118AB2",
		accent: "FFD166",
		dark: "263238",
		motif: "print",
	},
	cinematic: {
		name: "cinematic",
		headingFont: "Cambria",
		bodyFont: "Arial",
		background: "0A0A0A",
		surface: "1A1A1A",
		text: "F8F5EF",
		muted: "B8B1A7",
		primary: "C9A227",
		secondary: "8C7851",
		accent: "F2D16B",
		dark: "050505",
		motif: "cinematic",
	},
};

const PPTX_LAYOUTS = new Set<PptxLayout>([
	"cover",
	"section",
	"statement",
	"content",
	"twoColumn",
	"imageLeft",
	"imageRight",
	"fullImage",
	"metrics",
	"process",
	"timeline",
	"iconGrid",
	"chart",
	"table",
	"quote",
	"closing",
]);

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
			"Create a polished .docx Word document with a topic-appropriate editorial system, headings, paragraphs, styled tables, images, headers, footers, and page numbers. Define the audience/content/design brief and research factual claims before generation when needed.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Output .docx path", required: true },
			title: { type: "string", description: "Document title", required: false },
			designBrief: { type: "string", description: "Audience, purpose, content hierarchy, editorial tone, typography, palette, images/tables, and citation plan", required: false },
			stylePreset: { type: "string", description: "Editorial art-direction preset; inferred from topic when omitted", required: false, schema: { enum: Object.keys(PPTX_THEMES) } },
			theme: { type: "object", description: "Optional font/color overrides using the same fields as pptx_create.theme", required: false },
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
			const theme = resolvePptxTheme(optionalString(params.stylePreset), params.theme, [title, optionalString(params.designBrief)].filter(Boolean).join(" "));
			if (title) {
				children.push(new Paragraph({
					heading: HeadingLevel.TITLE,
					spacing: { before: 240, after: 360 },
					children: [new TextRun({ text: title, bold: true, size: 44, color: theme.primary, font: theme.headingFont })],
				}));
			}
			for (const block of blocks) {
				const obj = asObject(block);
				const type = String(obj.type ?? "paragraph");
				if (type === "heading") {
					children.push(
						new Paragraph({
							heading: headingLevel(Number(obj.level ?? 1)),
							spacing: { before: 240, after: 120 },
							children: [new TextRun({ text: String(obj.text ?? ""), bold: true, color: theme.primary, font: theme.headingFont })],
						}),
					);
				} else if (type === "table") {
					children.push(makeDocxTable(parseRows(obj.rows), theme));
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
					children.push(makeParagraph(String(obj.text ?? ""), theme));
				}
			}
			const doc = new Document({
				styles: {
					default: {
						document: {
							run: { font: theme.bodyFont, color: theme.text, size: 22 },
							paragraph: { spacing: { after: 140, line: 276 } },
						},
					},
				},
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
			return `DOCX created: ${outPath} (${blocks.length} block(s), ${theme.name} editorial system)`;
		}),
	};

	const xlsxCreate: ToolDefinition = {
		name: "xlsx_create",
		description:
			"Create a polished .xlsx workbook with a coherent visual system, purpose-built sheets, formulas, styled tables, frozen panes, filters, widths, number formats, and presentation-ready summaries using ExcelJS. Define the audience, workflow, analytical hierarchy, and style before generation.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Output .xlsx path", required: true },
			title: { type: "string", description: "Workbook title metadata", required: false },
			designBrief: { type: "string", description: "Audience, decisions supported, workbook architecture, visual hierarchy, palette, tables, summaries, and validation plan", required: false },
			stylePreset: { type: "string", description: "Workbook art-direction preset; inferred from title when omitted", required: false, schema: { enum: Object.keys(PPTX_THEMES) } },
			theme: { type: "object", description: "Optional font/color overrides using the same fields as pptx_create.theme", required: false },
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
			const theme = resolvePptxTheme(optionalString(params.stylePreset), params.theme, [optionalString(params.title), optionalString(params.designBrief)].filter(Boolean).join(" "));
			const sheets = parseArray(params.sheets, "sheets");
			for (const sheetInput of sheets) {
				const spec = asObject(sheetInput);
				const name = sanitizeSheetName(String(spec.name ?? `Sheet${workbook.worksheets.length + 1}`));
				const ws = workbook.addWorksheet(name);
				ws.properties.tabColor = { argb: normalizeArgb(theme.primary) };
				ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
				const columns = Array.isArray(spec.columns) ? spec.columns.map(String) : [];
				if (columns.length > 0) {
					ws.addRow(columns);
					ws.getRow(1).height = 24;
					ws.getRow(1).font = { name: theme.bodyFont, size: 12, bold: true, color: { argb: "FFFFFFFF" } };
					ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: normalizeArgb(theme.primary) } };
					ws.getRow(1).alignment = { vertical: "middle", horizontal: "left" };
				}
				for (const row of parseRows(spec.rows, false)) ws.addRow(row);
				for (let rowIndex = 2; rowIndex <= ws.rowCount; rowIndex++) {
					const row = ws.getRow(rowIndex);
					row.font = { name: theme.bodyFont, size: 11, color: { argb: normalizeArgb(theme.text) } };
					if (rowIndex % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: normalizeArgb(theme.background) } };
				}
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
						style: { theme: xlsxTableStyle(theme.name), showRowStripes: true },
						columns: columns.map((column) => ({ name: column, filterButton: true })),
						rows:
							ws.getRows(2, ws.rowCount - 1)?.map((row) =>
								Array.isArray(row.values) ? row.values.slice(1) : [],
							) ?? [],
					});
				}
			}
			await workbook.xlsx.writeFile(outPath);
			return `XLSX created: ${outPath} (${sheets.length} sheet(s), ${theme.name} visual system)`;
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
			"Create a premium .pptx from an explicit creative brief in editable, hybrid, or studio mode. Supports ten art directions, semantic layouts, process/timeline/icon grids, generated or sourced visuals, native charts, styled tables, structured notes/citations, and a Content-Design-Coherence quality report. Define visual direction first and use research tools before generation when claims need current or external evidence.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		longRunning: true,
		parameters: {
			path: { type: "string", description: "Output .pptx path", required: true },
			title: { type: "string", description: "Presentation title", required: false },
			subject: { type: "string", description: "Presentation subject", required: false },
			designBrief: {
				type: "string",
				description:
					"Creative direction covering audience, goal, narrative, visual concept, typography, palette, image treatment, chart/table style, and citation approach.",
				required: false,
			},
			stylePreset: {
				type: "string",
				description:
					"Art-direction preset: executive, editorial, midnight, vibrant, swiss, dataJournalism, glassmorphism, memphis, risograph, or cinematic. If omitted, Octopus infers the best fit.",
				required: false,
				schema: { enum: Object.keys(PPTX_THEMES) },
			},
			renderMode: {
				type: "string",
				description:
					"editable keeps native objects; hybrid combines native objects with sourced/generated visuals (premium default); studio places a complete high-resolution composition for every slide and prioritizes fidelity over editability.",
				required: false,
				schema: { enum: ["editable", "hybrid", "studio"] },
			},
			sourceManifest: {
				type: "array",
				description:
					"Sources actually used: [{title,url,date?,publisher?}]. Include only sources retrieved or provided; these are summarized in the quality report.",
				required: false,
			},
			theme: {
				type: "object",
				description:
					"Optional theme overrides: {headingFont, bodyFont, background, surface, text, muted, primary, secondary, accent, dark}. Colors are 6-digit HEX.",
				required: false,
				schema: {
					additionalProperties: false,
					properties: {
						headingFont: { type: "string" },
						bodyFont: { type: "string" },
						background: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
						surface: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
						text: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
						muted: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
						primary: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
						secondary: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
						accent: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
						dark: { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$" },
					},
				},
			},
			slides: {
				type: "array",
				description:
					"Slides use semantic layouts: cover, section, statement, content, twoColumn, imageLeft, imageRight, fullImage, metrics, process, timeline, iconGrid, chart, table, quote, closing. Fields: {layout,title,subtitle?,kicker?,body?,bullets?,columns?:[{heading,body,bullets}],steps?:[{title,description}],events?:[{date,title,description}],items?:[{label,title,description}],imagePath?,images?:[{path,alt,fit,caption,generationPrompt?}],metrics?:[{value,label,detail}],chart?:{type,categories,series:[{name,values}],showLegend?,showValues?,valueAxisTitle?},table?: rows[][] or {headers,rows},quoteAttribution?,takeaway?,speaker?:{narrative,talkingPoints,sources,generationNotes},notes?}. In studio mode every slide requires imagePath/images[0] containing the complete rendered slide. JSON string accepted.",
				required: true,
				schema: {
					minItems: 1,
					maxItems: 60,
					items: {
						type: "object",
						required: ["title"],
						properties: {
							layout: { type: "string", enum: [...PPTX_LAYOUTS] },
							title: { type: "string", maxLength: 140 },
							subtitle: { type: "string", maxLength: 240 },
							kicker: { type: "string", maxLength: 80 },
							body: { type: "string", maxLength: 900 },
							bullets: { type: "array", maxItems: 8, items: { type: "string", maxLength: 220 } },
							columns: { type: "array", minItems: 2, maxItems: 2 },
							images: { type: "array", maxItems: 2 },
							metrics: { type: "array", maxItems: 6 },
							steps: { type: "array", maxItems: 6 },
							events: { type: "array", maxItems: 8 },
							items: { type: "array", maxItems: 6 },
							chart: { type: "object" },
							table: {},
							speaker: { type: "object" },
						},
					},
				},
			},
		},
		handler: async (params, context): Promise<ToolResult> => wrapResult(async () => {
			const outPath = resolveToolPath(requiredString(params.path, "path"));
			await authorizeOutput(outPath);
			if (path.extname(outPath).toLowerCase() !== ".pptx") {
				throw new Error("pptx_create output path must end with .pptx");
			}
			const slides = parseArray(params.slides, "slides");
			if (slides.length === 0 || slides.length > 60) {
				throw new Error("pptx_create requires between 1 and 60 slides");
			}
			const designBrief = optionalString(params.designBrief);
			const renderMode = resolvePptxRenderMode(optionalString(params.renderMode));
			const sourceManifest = params.sourceManifest === undefined
				? []
				: parseArray(params.sourceManifest, "sourceManifest").map(asObject);
			const theme = resolvePptxTheme(
				optionalString(params.stylePreset),
				params.theme,
				[
					optionalString(params.title),
					optionalString(params.subject),
					designBrief,
				].filter(Boolean).join(" "),
			);
			emitOfficePhase(context, "phase_visual_direction", "completed", `Dirección visual definida: ${theme.name}; ${theme.headingFont} + ${theme.bodyFont}; modo ${renderMode}.`);
			const PptxGen = pptxgen as unknown as { new (): any };
			const pptx = new PptxGen();
			pptx.layout = "LAYOUT_WIDE";
			pptx.author = "Octopus AI";
			pptx.company = "Octopus AI";
			pptx.subject = optionalString(params.subject) ?? "Generated presentation";
			pptx.title = optionalString(params.title) ?? "Octopus presentation";
			pptx.theme = { headFontFace: theme.headingFont, bodyFontFace: theme.bodyFont };
			pptx.lang = "es-ES";
			const layoutCounts: Record<string, number> = {};
			const normalizedSpecs: Array<{ spec: JsonObject; layout: PptxLayout }> = [];
			let imageCount = 0;
			let chartCount = 0;
			let tableCount = 0;
			let notesCount = 0;
			emitOfficePhase(context, "phase_generation", "started", `Construyendo ${slides.length} diapositivas con layouts semánticos.`);
			for (const [index, slideInput] of slides.entries()) {
				const spec = asObject(slideInput);
				validatePptxSlide(spec, index);
				validatePptxRenderModeSlide(spec, index, renderMode);
				const layout = renderMode === "studio" ? "fullImage" : inferPptxLayout(spec, index);
				normalizedSpecs.push({ spec, layout });
				layoutCounts[layout] = (layoutCounts[layout] ?? 0) + 1;
				const slide = pptx.addSlide();
				const rendered = await renderPremiumPptxSlide({
					slide,
					spec,
					layout,
					index,
					total: slides.length,
					theme,
					renderMode,
					resolveToolPath,
					authorizeInput,
				});
				imageCount += rendered.images;
				chartCount += rendered.charts;
				tableCount += rendered.tables;
				notesCount += rendered.notes;
			}
			const qualityReport = evaluatePptxQuality(normalizedSpecs, theme, renderMode, sourceManifest);
			await pptx.writeFile({ fileName: outPath });
			emitOfficePhase(context, "phase_generation", "completed", "Presentación generada; iniciando validación estructural.");
			emitOfficePhase(context, "phase_validation", "started", "Verificando paquete PPTX, conteo de slides y assets.");
			const bytes = await readFile(outPath);
			if (bytes.subarray(0, 2).toString() !== "PK") {
				throw new Error("Generated PPTX is not a valid OOXML ZIP package");
			}
			emitOfficePhase(context, "phase_validation", "completed", `Paquete PPTX válido con ${slides.length} diapositivas.`);
			return `PPTX created: ${outPath}\nSlides: ${slides.length}\nTheme: ${theme.name}\nRender mode: ${renderMode}\nLayouts: ${JSON.stringify(layoutCounts)}\nAssets: ${imageCount} image(s), ${chartCount} chart(s), ${tableCount} table(s), ${notesCount} slide(s) with notes\nSources: ${sourceManifest.length}\nDesign brief: ${designBrief ?? "inferred from topic"}\nQuality report: ${JSON.stringify(qualityReport)}\nNext required QA: fix quality warnings, run office_inspect, then office_convert_preview with previewDir + montagePath for every slide; review canvas overflow/font warnings and inspect the montage before delivery.`;
		}),
	};

	const pdfCreate: ToolDefinition = {
		name: "pdf_create",
		description:
			"Create a polished PDF report with a topic-appropriate editorial system, headings, paragraphs, tables, images, and page breaks. Define audience, hierarchy, visual direction, and sources before generation when factual research is needed.",
		uiIcon: OFFICE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: { type: "string", description: "Output .pdf path", required: true },
			title: { type: "string", description: "PDF title", required: false },
			designBrief: { type: "string", description: "Audience, purpose, hierarchy, editorial tone, palette, visuals, tables, and citation plan", required: false },
			stylePreset: { type: "string", description: "Editorial art-direction preset; inferred from topic when omitted", required: false, schema: { enum: Object.keys(PPTX_THEMES) } },
			theme: { type: "object", description: "Optional font/color overrides using the same fields as pptx_create.theme", required: false },
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
			const title = optionalString(params.title);
			const theme = resolvePptxTheme(optionalString(params.stylePreset), params.theme, [title, optionalString(params.designBrief)].filter(Boolean).join(" "));
			await createPdfWithPdfkit(outPath, title, parseArray(params.blocks, "blocks"), resolveToolPath, authorizeInput, theme);
			return `PDF created: ${outPath} (${theme.name} editorial system)`;
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

export function createAgentFacingOfficeTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	return createOfficeTools(allowedPaths, workspaceDir).filter(
		(tool) => tool.name !== "pptx_create",
	);
}

function emitOfficePhase(
	context: ToolContext | undefined,
	status:
		| "phase_visual_direction"
		| "phase_generation"
		| "phase_validation",
	state: "started" | "completed" | "failed",
	message: string,
): void {
	const detail = Buffer.from(JSON.stringify({ phase: status, state, message })).toString(
		"base64",
	);
	context?.onProgress?.(`\x00STATUS:${status}:pptx_create::${detail}\x00`);
}

function resolvePptxTheme(
	presetInput: string | undefined,
	overridesInput: unknown,
	contextText: string,
): ResolvedPptxTheme {
	const inferred = inferPptxTheme(contextText);
	const preset = (presetInput ?? inferred) as PptxThemePreset;
	if (!Object.hasOwn(PPTX_THEMES, preset)) {
		throw new Error(
			`stylePreset must be one of: ${Object.keys(PPTX_THEMES).join(", ")}`,
		);
	}
	const base = PPTX_THEMES[preset];
	const overrides = optionalObject(overridesInput, "theme");
	const resolved: ResolvedPptxTheme = { ...base };
	for (const field of ["headingFont", "bodyFont"] as const) {
		if (overrides?.[field]) resolved[field] = requiredString(overrides[field], field);
	}
	for (const field of [
		"background",
		"surface",
		"text",
		"muted",
		"primary",
		"secondary",
		"accent",
		"dark",
	] as const) {
		if (overrides?.[field]) resolved[field] = normalizeHex(overrides[field], `theme.${field}`);
	}
	return resolved;
}

function inferPptxTheme(contextText: string): PptxThemePreset {
	const text = contextText.toLowerCase();
	if (/glass|saas|product ui|interfaz|dashboard|aplicaci[oó]n/.test(text)) return "glassmorphism";
	if (/periodismo de datos|data journalism|mercado|capital|inversi[oó]n|finanzas|kpi|anal[ií]tica/.test(text)) return "dataJournalism";
	if (/suizo|swiss|ret[ií]cula|grid system|tipograf[ií]a minimal/.test(text)) return "swiss";
	if (/festival|infantil|juguete|pop|memphis|divertid|playful/.test(text)) return "memphis";
	if (/zine|risograph|librer[ií]a|indie|fanzine|impresi[oó]n artesanal/.test(text)) return "risograph";
	if (/cine|cinematic|lujo|luxury|automotriz|arquitectura premium/.test(text)) return "cinematic";
	if (/tecnolog|software|ia\b|inteligencia artificial|cyber|datos|futur|digital/.test(text)) {
		return "midnight";
	}
	if (/histori|arte|cultura|literatura|educa|editorial|humanidad|museo/.test(text)) {
		return "editorial";
	}
	if (/marketing|creativ|viaje|evento|campaña|marca|producto|innovaci/.test(text)) {
		return "vibrant";
	}
	return "executive";
}

function resolvePptxRenderMode(value: string | undefined): PptxRenderMode {
	const mode = value ?? "hybrid";
	if (mode !== "editable" && mode !== "hybrid" && mode !== "studio") {
		throw new Error("renderMode must be editable, hybrid, or studio");
	}
	return mode;
}

function normalizeHex(value: unknown, field: string): string {
	const cleaned = String(value ?? "").replace(/^#/, "").toUpperCase();
	if (!/^[0-9A-F]{6}$/.test(cleaned)) {
		throw new Error(`${field} must be a 6-digit HEX color`);
	}
	return cleaned;
}

function optionalObject(value: unknown, name: string): JsonObject | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as JsonObject;
		}
		throw new Error(`Parameter '${name}' must be an object or JSON object string`);
	}
	if (typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
	throw new Error(`Parameter '${name}' must be an object or JSON object string`);
}

function validatePptxSlide(spec: JsonObject, index: number): void {
	const prefix = `slides[${index}]`;
	const title = requiredString(spec.title, `${prefix}.title`);
	if (title.length > 140) throw new Error(`${prefix}.title must be 140 characters or fewer`);
	if (String(spec.subtitle ?? "").length > 240) {
		throw new Error(`${prefix}.subtitle must be 240 characters or fewer`);
	}
	if (String(spec.body ?? "").length > 900) {
		throw new Error(`${prefix}.body must be 900 characters or fewer`);
	}
	const bullets = Array.isArray(spec.bullets) ? spec.bullets : [];
	if (bullets.length > 8) throw new Error(`${prefix}.bullets supports at most 8 items`);
	for (const [bulletIndex, bullet] of bullets.entries()) {
		if (String(bullet).length > 220) {
			throw new Error(`${prefix}.bullets[${bulletIndex}] must be 220 characters or fewer`);
		}
	}
	if (spec.layout && !PPTX_LAYOUTS.has(String(spec.layout) as PptxLayout)) {
		throw new Error(`${prefix}.layout is not supported`);
	}
	const metrics = Array.isArray(spec.metrics) ? spec.metrics : [];
	if (metrics.length > 6) throw new Error(`${prefix}.metrics supports at most 6 cards`);
	const steps = Array.isArray(spec.steps) ? spec.steps : [];
	if (steps.length > 6) throw new Error(`${prefix}.steps supports at most 6 items`);
	const events = Array.isArray(spec.events) ? spec.events : [];
	if (events.length > 8) throw new Error(`${prefix}.events supports at most 8 items`);
	const items = Array.isArray(spec.items) ? spec.items : [];
	if (items.length > 6) throw new Error(`${prefix}.items supports at most 6 items`);
	const images = Array.isArray(spec.images) ? spec.images : [];
	if (images.length > 2) throw new Error(`${prefix}.images supports at most 2 images`);
	if (spec.chart) validatePptxChart(asObject(spec.chart), prefix);
}

function validatePptxRenderModeSlide(
	spec: JsonObject,
	index: number,
	mode: PptxRenderMode,
): void {
	if (mode !== "studio") return;
	const hasImage = Boolean(
		spec.imagePath ||
			(Array.isArray(spec.images) && spec.images.length > 0 && asObject(spec.images[0]).path),
	);
	if (!hasImage) {
		throw new Error(
			`slides[${index}] requires imagePath or images[0].path in studio mode`,
		);
	}
}

function evaluatePptxQuality(
	slides: Array<{ spec: JsonObject; layout: PptxLayout }>,
	theme: ResolvedPptxTheme,
	mode: PptxRenderMode,
	sourceManifest: JsonObject[],
): {
	overall: number;
	content: number;
	design: number;
	coherence: number;
	status: "pass" | "revise";
	warnings: string[];
} {
	const warnings: string[] = [];
	let content = 100;
	let design = 100;
	let coherence = 100;
	const layouts = slides.map((slide) => slide.layout);
	const uniqueLayouts = new Set(layouts);
	const genericTitle = /^(agenda|overview|introducci[oó]n|resumen|contexto|conclusi[oó]n|resultados|pr[oó]ximos pasos)$/i;
	const factualSlides = slides.filter(({ spec, layout }) =>
		layout === "chart" || layout === "metrics" || layout === "table" || Boolean(spec.quoteAttribution),
	);
	const sourcedSlides = slides.filter(({ spec }) => {
		const speaker = optionalObject(spec.speaker, "speaker");
		return Array.isArray(speaker?.sources) && speaker.sources.length > 0;
	});
	const generatedAssetSlides = slides.filter(({ spec }) =>
		Boolean(spec.imagePath || (Array.isArray(spec.images) && spec.images.length > 0)),
	);

	for (const [index, { spec, layout }] of slides.entries()) {
		if (genericTitle.test(String(spec.title).trim())) {
			content -= 4;
			warnings.push(`Slide ${index + 1}: replace generic title with an assertion or takeaway.`);
		}
		const bullets = Array.isArray(spec.bullets) ? spec.bullets : [];
		if (bullets.length > 6 || String(spec.body ?? "").length > 650) {
			content -= 7;
			warnings.push(`Slide ${index + 1}: visible copy is dense; split or move detail to notes.`);
		}
		if (layout === "chart") {
			const chart = asObject(spec.chart);
			const chartType = String(chart.type ?? "column");
			if (chartType !== "pie" && chartType !== "doughnut") {
				if (!optionalString(chart.categoryAxisTitle)) {
					content -= 3;
					warnings.push(`Slide ${index + 1}: chart needs an explicit category-axis title.`);
				}
				if (!optionalString(chart.valueAxisTitle)) {
					content -= 3;
					warnings.push(`Slide ${index + 1}: chart needs an explicit value-axis title and units.`);
				}
			}
		}
		if (index >= 2 && layouts[index] === layouts[index - 1] && layouts[index - 1] === layouts[index - 2]) {
			design -= 8;
			warnings.push(`Slide ${index + 1}: the same layout appears three times consecutively.`);
		}
	}

	const targetDiversity = Math.min(4, slides.length);
	if (uniqueLayouts.size < targetDiversity) {
		design -= (targetDiversity - uniqueLayouts.size) * 6;
		warnings.push(`Use at least ${targetDiversity} layout families; current deck uses ${uniqueLayouts.size}.`);
	}
	const imageLedOpportunities = slides.filter(({ layout }) =>
		["cover", "section", "statement", "imageLeft", "imageRight", "fullImage", "quote", "closing"].includes(layout),
	).length;
	const hybridAssetTarget = Math.max(1, Math.ceil(imageLedOpportunities / 2));
	if (mode === "hybrid" && slides.length >= 4 && generatedAssetSlides.length < hybridAssetTarget) {
		design -= 10;
		warnings.push(`Hybrid mode needs intentional sourced/generated visuals on at least ${hybridAssetTarget} image-led slide(s).`);
	}
	if (mode === "studio") {
		warnings.push("Studio mode prioritizes fidelity; slide text and diagrams are not natively editable.");
	}
	if (/aptos/i.test(`${theme.headingFont} ${theme.bodyFont}`)) {
		design -= 8;
		warnings.push("Aptos can substitute unpredictably in LibreOffice and older Office versions.");
	}
	if (factualSlides.length > 0 && sourceManifest.length === 0 && sourcedSlides.length === 0) {
		content -= 15;
		warnings.push("Charts, metrics, tables, or quotations need traceable sources in notes/sourceManifest.");
	}
	const notesCoverage = slides.filter(({ spec }) => Boolean(serializePptxNotes(spec))).length / slides.length;
	if (slides.length >= 4 && notesCoverage < 0.5) {
		content -= 6;
		warnings.push("Add speaker notes, caveats, generation notes, or sources to at least half the deck.");
	}
	if (slides.length >= 4 && layouts[0] !== "cover") {
		coherence -= 8;
		warnings.push("Long decks should open with a deliberate cover or framing slide.");
	}
	if (slides.length >= 4 && layouts.at(-1) !== "closing") {
		coherence -= 8;
		warnings.push("Long decks should end with a decision, call to action, or closing slide.");
	}
	const normalizedTitles = slides.map(({ spec }) => String(spec.title).trim().toLowerCase());
	if (new Set(normalizedTitles).size !== normalizedTitles.length) {
		coherence -= 8;
		warnings.push("Duplicate slide titles weaken the narrative arc.");
	}
	content = Math.max(0, content);
	design = Math.max(0, design);
	coherence = Math.max(0, coherence);
	const overall = Math.round(content * 0.35 + design * 0.4 + coherence * 0.25);
	return {
		overall,
		content,
		design,
		coherence,
		status: overall >= 82 ? "pass" : "revise",
		warnings,
	};
}

function validatePptxChart(chart: JsonObject, prefix: string): void {
	const categories = parseArray(chart.categories, `${prefix}.chart.categories`).map(String);
	const series = parseArray(chart.series, `${prefix}.chart.series`);
	if (categories.length === 0 || categories.length > 20) {
		throw new Error(`${prefix}.chart.categories requires 1-20 labels`);
	}
	if (series.length === 0 || series.length > 6) {
		throw new Error(`${prefix}.chart.series requires 1-6 series`);
	}
	for (const [seriesIndex, item] of series.entries()) {
		const values = parseArray(asObject(item).values, `${prefix}.chart.series[${seriesIndex}].values`);
		if (values.length !== categories.length || values.some((value) => !Number.isFinite(Number(value)))) {
			throw new Error(
				`${prefix}.chart.series[${seriesIndex}].values must contain one finite number per category`,
			);
		}
	}
	const type = String(chart.type ?? "column");
	if ((type === "pie" || type === "doughnut") && series.length !== 1) {
		throw new Error(`${prefix}.chart.${type} supports exactly one series`);
	}
}

function inferPptxLayout(spec: JsonObject, index: number): PptxLayout {
	if (spec.layout) return String(spec.layout) as PptxLayout;
	const hasVisibleContent = Boolean(
		spec.body ||
			(Array.isArray(spec.bullets) && spec.bullets.length > 0) ||
			spec.chart ||
			spec.table ||
			(Array.isArray(spec.metrics) && spec.metrics.length > 0) ||
			(Array.isArray(spec.columns) && spec.columns.length > 0),
	);
	if (index === 0 && !hasVisibleContent) return "cover";
	if (spec.chart) return "chart";
	if (spec.table) return "table";
	if (Array.isArray(spec.metrics) && spec.metrics.length > 0) return "metrics";
	if (Array.isArray(spec.steps) && spec.steps.length > 0) return "process";
	if (Array.isArray(spec.events) && spec.events.length > 0) return "timeline";
	if (Array.isArray(spec.items) && spec.items.length > 0) return "iconGrid";
	if (Array.isArray(spec.columns) && spec.columns.length === 2) return "twoColumn";
	if (spec.imagePath || (Array.isArray(spec.images) && spec.images.length > 0)) {
		return "imageRight";
	}
	if (spec.quoteAttribution) return "quote";
	return "content";
}

async function renderPremiumPptxSlide(input: {
	slide: any;
	spec: JsonObject;
	layout: PptxLayout;
	index: number;
	total: number;
	theme: ResolvedPptxTheme;
	renderMode: PptxRenderMode;
	resolveToolPath: (filePath: string) => string;
	authorizeInput: (resolved: string) => Promise<void>;
}): Promise<{ images: number; charts: number; tables: number; notes: number }> {
	const { slide, spec, layout, index, total, theme, renderMode } = input;
	if (renderMode === "studio") {
		const imageCount = await addStudioPptxSlide(slide, spec, input);
		const studioNotes = serializePptxNotes(spec);
		if (studioNotes) slide.addNotes(studioNotes);
		return { images: imageCount, charts: 0, tables: 0, notes: studioNotes ? 1 : 0 };
	}
	const dark = layout === "cover" || layout === "section" || layout === "closing";
	slide.background = { color: dark ? theme.dark : theme.background };
	addPptxDecoration(slide, theme, dark, index, total);
	const title = String(spec.title);
	const subtitle = optionalString(spec.subtitle);
	const body = optionalString(spec.body);
	const bullets = Array.isArray(spec.bullets) ? spec.bullets.map(String) : [];
	let images = 0;
	let charts = 0;
	let tables = 0;

	if (layout === "cover") {
		if (spec.kicker) addPptxKicker(slide, String(spec.kicker), theme, true, 0.8, 0.7);
		slide.addText(title, {
			x: 0.8, y: 1.55, w: 7.1, h: 2.15, fontFace: theme.headingFont,
			fontSize: 40, bold: true, color: "FFFFFF", margin: 0, fit: "shrink",
			breakLine: false, valign: "mid",
		});
		if (subtitle) slide.addText(subtitle, { x: 0.82, y: 4.0, w: 6.7, h: 1.0, fontFace: theme.bodyFont, fontSize: 20, color: "DDE7F1", margin: 0.02, breakLine: false, fit: "shrink" });
		images += await addPptxImages(slide, spec, theme, input, { x: 8.3, y: 0.65, w: 4.4, h: 5.95 }, "cover");
	} else if (layout === "section") {
		slide.addText(String(index).padStart(2, "0"), { x: 0.8, y: 0.65, w: 2.2, h: 1.4, fontFace: theme.headingFont, fontSize: 54, bold: true, color: theme.accent, transparency: 12, margin: 0 });
		slide.addText(title, { x: 0.82, y: 2.25, w: 10.7, h: 1.55, fontFace: theme.headingFont, fontSize: 34, bold: true, color: "FFFFFF", margin: 0, fit: "shrink" });
		if (subtitle) slide.addText(subtitle, { x: 0.85, y: 4.05, w: 8.8, h: 0.8, fontFace: theme.bodyFont, fontSize: 17, color: "DDE7F1", margin: 0 });
	} else if (layout === "statement" || layout === "closing") {
		if (spec.kicker) addPptxKicker(slide, String(spec.kicker), theme, dark, 0.9, 0.9);
		slide.addText(title, { x: 1.0, y: 1.65, w: 11.3, h: 2.5, fontFace: theme.headingFont, fontSize: 34, bold: true, color: dark ? "FFFFFF" : theme.text, align: "center", valign: "mid", margin: 0, fit: "shrink" });
		if (subtitle || spec.takeaway) slide.addText(String(spec.takeaway ?? subtitle), { x: 2.0, y: 4.4, w: 9.3, h: 1.0, fontFace: theme.bodyFont, fontSize: 20, color: dark ? "DDE7F1" : theme.muted, align: "center", margin: 0, fit: "shrink" });
	} else if (layout === "quote") {
		addPptxKicker(slide, String(spec.kicker ?? "PERSPECTIVA"), theme, false, 0.8, 0.55);
		slide.addText("“", { x: 0.75, y: 1.05, w: 1.2, h: 1.2, fontFace: "Georgia", fontSize: 72, color: theme.accent, margin: 0 });
		slide.addText(body ?? title, { x: 1.7, y: 1.55, w: 9.9, h: 3.25, fontFace: theme.headingFont, fontSize: 28, italic: true, color: theme.text, margin: 0, fit: "shrink", valign: "mid" });
		if (spec.quoteAttribution) slide.addText(`— ${String(spec.quoteAttribution)}`, { x: 1.75, y: 5.15, w: 8.0, h: 0.45, fontFace: theme.bodyFont, fontSize: 15, bold: true, color: theme.primary, margin: 0 });
	} else {
		addPptxSlideTitle(slide, title, optionalString(spec.kicker), theme);
		if (layout === "twoColumn") {
			const columns = parseArray(spec.columns, "columns");
			for (const [columnIndex, item] of columns.slice(0, 2).entries()) {
				addPptxColumn(slide, asObject(item), theme, columnIndex === 0 ? 0.75 : 6.85, columnIndex);
			}
		} else if (layout === "imageLeft" || layout === "imageRight") {
			const imageLeft = layout === "imageLeft";
			images += await addPptxImages(slide, spec, theme, input, { x: imageLeft ? 0.65 : 7.05, y: 1.55, w: 5.65, h: 4.9 }, "contain");
			addPptxBody(slide, body, bullets, theme, { x: imageLeft ? 6.75 : 0.8, y: 1.7, w: 5.55, h: 4.65 });
		} else if (layout === "fullImage") {
			images += await addPptxImages(slide, spec, theme, input, { x: 0, y: 0, w: 13.333, h: 7.5 }, "cover");
			slide.addShape("rect", { x: 0, y: 4.65, w: 13.333, h: 2.85, fill: { color: theme.dark, transparency: 18 }, line: { transparency: 100 } });
			slide.addText(title, { x: 0.8, y: 5.15, w: 11.7, h: 1.2, fontFace: theme.headingFont, fontSize: 29, bold: true, color: "FFFFFF", margin: 0, fit: "shrink" });
		} else if (layout === "metrics") {
			addPptxMetrics(slide, parseArray(spec.metrics, "metrics"), theme);
		} else if (layout === "process") {
			addPptxProcess(slide, parseArray(spec.steps, "steps"), theme);
		} else if (layout === "timeline") {
			addPptxTimeline(slide, parseArray(spec.events, "events"), theme);
		} else if (layout === "iconGrid") {
			addPptxIconGrid(slide, parseArray(spec.items, "items"), theme);
		} else if (layout === "chart") {
			addPptxChart(slide, asObject(spec.chart), theme);
			charts += 1;
			if (spec.takeaway) addPptxTakeaway(slide, String(spec.takeaway), theme);
		} else if (layout === "table") {
			addPptxTable(slide, spec.table, theme);
			tables += 1;
		} else {
			addPptxContentComposition(slide, body, bullets, theme);
			if (spec.takeaway) addPptxTakeaway(slide, String(spec.takeaway), theme);
		}
	}

	const notes = serializePptxNotes(spec);
	if (notes) slide.addNotes(notes);
	return { images, charts, tables, notes: notes ? 1 : 0 };
}

function addPptxDecoration(
	slide: any,
	theme: ResolvedPptxTheme,
	dark: boolean,
	index: number,
	total: number,
): void {
	if (theme.motif === "grid" || theme.motif === "data") {
		for (let row = 0; row < 4; row++) {
			for (let column = 0; column < 6; column++) {
				slide.addShape("ellipse", {
					x: 10.65 + column * 0.34,
					y: 0.25 + row * 0.34,
					w: 0.035,
					h: 0.035,
					fill: { color: dark ? theme.text : theme.primary, transparency: 65 },
					line: { transparency: 100 },
				});
			}
		}
	} else if (theme.motif === "glass" || theme.motif === "orbital") {
		slide.addShape("ellipse", { x: 11.45, y: 0.15, w: 1.35, h: 1.35, fill: { color: theme.primary, transparency: 72 }, line: { transparency: 100 } });
		slide.addShape("ellipse", { x: 10.95, y: 0.72, w: 0.85, h: 0.85, fill: { color: theme.secondary, transparency: 76 }, line: { transparency: 100 } });
	} else if (theme.motif === "memphis" || theme.motif === "geometric") {
		slide.addShape("ellipse", { x: 11.85, y: 0.32, w: 0.62, h: 0.62, fill: { color: theme.accent }, line: { transparency: 100 } });
		slide.addShape("rect", { x: 11.15, y: 0.72, w: 0.46, h: 0.46, rotate: 18, fill: { color: theme.secondary }, line: { transparency: 100 } });
	} else if (theme.motif === "print") {
		slide.addShape("ellipse", { x: 11.35, y: 0.3, w: 1.1, h: 1.1, fill: { color: theme.primary, transparency: 18 }, line: { transparency: 100 } });
		slide.addShape("ellipse", { x: 11.75, y: 0.62, w: 0.92, h: 0.92, fill: { color: theme.secondary, transparency: 24 }, line: { transparency: 100 } });
	} else if (theme.motif === "cinematic") {
		slide.addShape("rect", { x: 0.38, y: 0.3, w: 12.57, h: 6.88, fill: { transparency: 100 }, line: { color: theme.primary, transparency: 62, pt: 0.7 } });
	}
	slide.addText(`${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, { x: 11.65, y: 7.05, w: 1.05, h: 0.2, fontFace: theme.bodyFont, fontSize: 8.5, color: dark ? "B8C6D5" : theme.muted, align: "right", margin: 0 });
}

function addPptxSlideTitle(slide: any, title: string, kicker: string | undefined, theme: ResolvedPptxTheme): void {
	if (kicker) addPptxKicker(slide, kicker, theme, false, 0.78, 0.38);
	slide.addText(title, { x: 0.78, y: kicker ? 0.72 : 0.44, w: 11.5, h: 0.86, fontFace: theme.headingFont, fontSize: 34, bold: true, color: theme.text, margin: 0, fit: "shrink" });
}

function addPptxKicker(slide: any, text: string, theme: ResolvedPptxTheme, dark: boolean, x: number, y: number): void {
	slide.addText(text.toUpperCase(), { x, y, w: 5.5, h: 0.25, fontFace: theme.bodyFont, fontSize: 9.5, bold: true, charSpacing: 1.6, color: dark ? theme.accent : theme.primary, margin: 0 });
}

function addPptxBody(slide: any, body: string | undefined, bullets: string[], theme: ResolvedPptxTheme, box: { x: number; y: number; w: number; h: number }): void {
	let y = box.y;
	if (body) {
		slide.addText(body, { x: box.x, y, w: box.w, h: Math.min(1.45, box.h), fontFace: theme.bodyFont, fontSize: 20, color: theme.text, margin: 0.03, breakLine: false, fit: "shrink", valign: "top" });
		y += 1.65;
	}
	if (bullets.length > 0) {
		slide.addText(
			bullets.map((text, index) => ({ text, options: { bullet: { indent: 18 }, breakLine: index < bullets.length - 1 } })),
			{ x: box.x + 0.05, y, w: box.w - 0.05, h: Math.max(1, box.h - (y - box.y)), fontFace: theme.bodyFont, fontSize: 17, color: theme.text, margin: 0.04, paraSpaceAfterPt: 12, breakLine: false, fit: "shrink", valign: "top" },
		);
	}
}

function addPptxContentComposition(
	slide: any,
	body: string | undefined,
	bullets: string[],
	theme: ResolvedPptxTheme,
): void {
	if (bullets.length === 0) {
		slide.addShape("roundRect", { x: 0.82, y: 1.65, w: 11.65, h: 4.75, fill: { color: theme.surface }, line: { color: theme.primary, transparency: 78, pt: 0.8 }, shadow: { type: "outer", color: "000000", opacity: 0.1, blur: 1.5, angle: 45, distance: 1 } });
		slide.addText(body ?? "", { x: 1.35, y: 2.25, w: 10.55, h: 3.2, fontFace: theme.headingFont, fontSize: 25, color: theme.text, margin: 0, fit: "shrink", valign: "mid", align: "left" });
		return;
	}
	if (body) {
		slide.addText(body, { x: 0.85, y: 1.48, w: 11.5, h: 0.68, fontFace: theme.bodyFont, fontSize: 18, color: theme.muted, margin: 0, fit: "shrink" });
	}
	const top = body ? 2.35 : 1.65;
	const columns = bullets.length <= 3 ? 1 : 2;
	const rows = Math.ceil(bullets.length / columns);
	const gapX = 0.34;
	const gapY = 0.24;
	const cardW = columns === 1 ? 11.55 : (11.55 - gapX) / 2;
	const cardH = Math.min(1.18, (4.45 - gapY * (rows - 1)) / rows);
	for (const [index, text] of bullets.entries()) {
		const column = Math.floor(index / rows);
		const row = index % rows;
		const x = 0.85 + column * (cardW + gapX);
		const y = top + row * (cardH + gapY);
		slide.addShape("roundRect", { x, y, w: cardW, h: cardH, fill: { color: theme.surface }, line: { color: theme.primary, transparency: 82, pt: 0.7 }, shadow: { type: "outer", color: "000000", opacity: 0.08, blur: 1, angle: 45, distance: 0.7 } });
		slide.addShape("ellipse", { x: x + 0.22, y: y + (cardH - 0.48) / 2, w: 0.48, h: 0.48, fill: { color: index % 2 === 0 ? theme.primary : theme.secondary }, line: { transparency: 100 } });
		slide.addText(String(index + 1).padStart(2, "0"), { x: x + 0.22, y: y + (cardH - 0.48) / 2 + 0.12, w: 0.48, h: 0.18, fontFace: theme.bodyFont, fontSize: 8.5, bold: true, color: "FFFFFF", align: "center", margin: 0 });
		slide.addText(text, { x: x + 0.9, y: y + 0.18, w: cardW - 1.18, h: cardH - 0.32, fontFace: theme.bodyFont, fontSize: 16, color: theme.text, margin: 0, fit: "shrink", valign: "mid" });
	}
}

function addPptxProcess(slide: any, input: unknown[], theme: ResolvedPptxTheme): void {
	const steps = input.slice(0, 6).map(asObject);
	if (steps.length === 0) throw new Error("process layout requires steps");
	const gap = 0.2;
	const width = (11.65 - gap * (steps.length - 1)) / steps.length;
	for (const [index, step] of steps.entries()) {
		const x = 0.82 + index * (width + gap);
		if (index < steps.length - 1) {
			slide.addShape("chevron", { x: x + width - 0.05, y: 3.26, w: gap + 0.14, h: 0.38, fill: { color: theme.muted, transparency: 58 }, line: { transparency: 100 } });
		}
		slide.addShape("roundRect", { x, y: 1.75, w: width, h: 4.45, fill: { color: theme.surface }, line: { color: index % 2 === 0 ? theme.primary : theme.secondary, transparency: 54, pt: 1 } });
		slide.addText(String(index + 1).padStart(2, "0"), { x: x + 0.22, y: 2.05, w: width - 0.44, h: 0.55, fontFace: theme.headingFont, fontSize: 26, bold: true, color: index % 2 === 0 ? theme.primary : theme.secondary, margin: 0 });
		slide.addText(String(step.title ?? `Paso ${index + 1}`), { x: x + 0.22, y: 2.82, w: width - 0.44, h: 0.9, fontFace: theme.headingFont, fontSize: 19, bold: true, color: theme.text, margin: 0, fit: "shrink" });
		if (step.description) slide.addText(String(step.description), { x: x + 0.22, y: 3.9, w: width - 0.44, h: 1.65, fontFace: theme.bodyFont, fontSize: 14, color: theme.muted, margin: 0, fit: "shrink", valign: "top" });
	}
}

function addPptxTimeline(slide: any, input: unknown[], theme: ResolvedPptxTheme): void {
	const events = input.slice(0, 8).map(asObject);
	if (events.length === 0) throw new Error("timeline layout requires events");
	const startX = 1.65;
	const endX = 11.68;
	slide.addShape("line", { x: startX, y: 3.72, w: endX - startX, h: 0, line: { color: theme.muted, transparency: 35, pt: 2 } });
	const spacing = events.length === 1 ? 0 : (endX - startX) / (events.length - 1);
	const eventWidth = Math.min(2.6, Math.max(1.45, spacing * 0.72));
	for (const [index, event] of events.entries()) {
		const x = events.length === 1 ? (startX + endX) / 2 : startX + index * spacing;
		const above = index % 2 === 0;
		slide.addShape("ellipse", { x: x - 0.15, y: 3.57, w: 0.3, h: 0.3, fill: { color: index % 2 === 0 ? theme.primary : theme.secondary }, line: { color: theme.surface, pt: 1 } });
		slide.addText(String(event.date ?? ""), { x: x - eventWidth / 2, y: above ? 2.82 : 4.05, w: eventWidth, h: 0.35, fontFace: theme.bodyFont, fontSize: 12, bold: true, color: theme.primary, align: "center", margin: 0, fit: "shrink" });
		slide.addText(String(event.title ?? ""), { x: x - eventWidth / 2, y: above ? 1.9 : 4.48, w: eventWidth, h: 0.66, fontFace: theme.headingFont, fontSize: 16, bold: true, color: theme.text, align: "center", margin: 0, fit: "shrink" });
		if (event.description) slide.addText(String(event.description), { x: x - eventWidth / 2, y: above ? 1.15 : 5.2, w: eventWidth, h: 0.64, fontFace: theme.bodyFont, fontSize: 12, color: theme.muted, align: "center", margin: 0, fit: "shrink" });
	}
}

function addPptxIconGrid(slide: any, input: unknown[], theme: ResolvedPptxTheme): void {
	const items = input.slice(0, 6).map(asObject);
	if (items.length === 0) throw new Error("iconGrid layout requires items");
	const columns = items.length <= 3 ? items.length : 3;
	const rows = Math.ceil(items.length / columns);
	const cardW = (11.65 - 0.3 * (columns - 1)) / columns;
	const cardH = rows === 1 ? 4.3 : 2.05;
	for (const [index, item] of items.entries()) {
		const x = 0.82 + (index % columns) * (cardW + 0.3);
		const y = 1.7 + Math.floor(index / columns) * (cardH + 0.28);
		slide.addShape("roundRect", { x, y, w: cardW, h: cardH, fill: { color: theme.surface }, line: { color: theme.muted, transparency: 76, pt: 0.8 } });
		slide.addShape("ellipse", { x: x + 0.28, y: y + 0.28, w: 0.72, h: 0.72, fill: { color: index % 2 === 0 ? theme.primary : theme.secondary }, line: { transparency: 100 } });
		slide.addText(String(item.label ?? index + 1).slice(0, 3).toUpperCase(), { x: x + 0.28, y: y + 0.49, w: 0.72, h: 0.2, fontFace: theme.bodyFont, fontSize: 9.5, bold: true, color: "FFFFFF", align: "center", margin: 0, fit: "shrink" });
		slide.addText(String(item.title ?? ""), { x: x + 1.2, y: y + 0.34, w: cardW - 1.5, h: 0.58, fontFace: theme.headingFont, fontSize: 16, bold: true, color: theme.text, margin: 0, fit: "shrink" });
		if (item.description) slide.addText(String(item.description), { x: x + 0.3, y: y + 1.2, w: cardW - 0.6, h: cardH - 1.48, fontFace: theme.bodyFont, fontSize: 13, color: theme.muted, margin: 0, fit: "shrink", valign: "top" });
	}
}

function addPptxColumn(slide: any, column: JsonObject, theme: ResolvedPptxTheme, x: number, index: number): void {
	slide.addShape("roundRect", { x, y: 1.65, w: 5.75, h: 4.75, rectRadius: 0.08, fill: { color: theme.surface }, line: { color: index === 0 ? theme.primary : theme.secondary, pt: 1.3 } });
	slide.addText(String(column.heading ?? `Opción ${index + 1}`), { x: x + 0.35, y: 1.98, w: 5.05, h: 0.55, fontFace: theme.headingFont, fontSize: 20, bold: true, color: index === 0 ? theme.primary : theme.secondary, margin: 0 });
	addPptxBody(slide, optionalString(column.body), Array.isArray(column.bullets) ? column.bullets.map(String) : [], theme, { x: x + 0.32, y: 2.78, w: 5.08, h: 3.15 });
}

async function addStudioPptxSlide(
	slide: any,
	spec: JsonObject,
	input: {
		resolveToolPath: (filePath: string) => string;
		authorizeInput: (resolved: string) => Promise<void>;
	},
): Promise<number> {
	const imageSpec = Array.isArray(spec.images) && spec.images.length > 0
		? asObject(spec.images[0])
		: { path: spec.imagePath, alt: spec.title };
	const imagePath = input.resolveToolPath(requiredString(imageSpec.path, "studio slide image path"));
	await input.authorizeInput(imagePath);
	slide.background = { color: "000000" };
	slide.addImage({
		path: imagePath,
		altText: String(imageSpec.alt ?? spec.title ?? "Studio slide"),
		x: 0,
		y: 0,
		w: 13.333,
		h: 7.5,
		sizing: { type: "cover", w: 13.333, h: 7.5 },
	});
	return 1;
}

async function addPptxImages(
	slide: any,
	spec: JsonObject,
	theme: ResolvedPptxTheme,
	input: { resolveToolPath: (filePath: string) => string; authorizeInput: (resolved: string) => Promise<void> },
	box: { x: number; y: number; w: number; h: number },
	defaultFit: "contain" | "cover",
): Promise<number> {
	const rawImages = Array.isArray(spec.images) ? spec.images : [];
	const imageSpecs = rawImages.length > 0
		? rawImages.map((item) => asObject(item))
		: spec.imagePath
			? [{ path: spec.imagePath, alt: String(spec.title ?? "Presentation image"), fit: defaultFit }]
			: [];
	if (imageSpecs.length === 0) return 0;
	const image = imageSpecs[0];
	const imagePath = input.resolveToolPath(requiredString(image.path, "image path"));
	await input.authorizeInput(imagePath);
	const fit = image.fit === "cover" ? "cover" : defaultFit;
	slide.addShape("roundRect", { x: box.x - 0.06, y: box.y - 0.06, w: box.w + 0.12, h: box.h + 0.12, fill: { color: theme.surface }, line: { color: theme.primary, transparency: 45, pt: 1.1 }, shadow: { type: "outer", color: "000000", opacity: 0.15, blur: 2, angle: 45, distance: 1 } });
	slide.addImage({ path: imagePath, altText: String(image.alt ?? spec.title ?? "Presentation image"), x: box.x, y: box.y, w: box.w, h: box.h, sizing: { type: fit, w: box.w, h: box.h } });
	if (image.caption) slide.addText(String(image.caption), { x: box.x, y: box.y + box.h + 0.08, w: box.w, h: 0.28, fontFace: theme.bodyFont, fontSize: 8.5, color: theme.muted, italic: true, margin: 0 });
	return 1;
}

function addPptxMetrics(slide: any, metricInput: unknown[], theme: ResolvedPptxTheme): void {
	const metrics = metricInput.slice(0, 6).map(asObject);
	const columns = metrics.length <= 3 ? metrics.length : 3;
	const rows = Math.ceil(metrics.length / columns);
	const gap = 0.25;
	const cardW = (11.7 - gap * (columns - 1)) / columns;
	const cardH = rows === 1 ? 3.5 : 2.05;
	for (const [index, metric] of metrics.entries()) {
		const column = index % columns;
		const row = Math.floor(index / columns);
		const x = 0.78 + column * (cardW + gap);
		const y = 1.7 + row * (cardH + gap);
		slide.addShape("roundRect", { x, y, w: cardW, h: cardH, fill: { color: theme.surface }, line: { color: index % 2 === 0 ? theme.primary : theme.secondary, transparency: 30, pt: 1.2 } });
		slide.addText(String(metric.value ?? "—"), { x: x + 0.28, y: y + 0.3, w: cardW - 0.56, h: 0.75, fontFace: theme.headingFont, fontSize: rows === 1 ? 30 : 25, bold: true, color: index % 2 === 0 ? theme.primary : theme.secondary, margin: 0, fit: "shrink" });
		slide.addText(String(metric.label ?? ""), { x: x + 0.28, y: y + 1.12, w: cardW - 0.56, h: 0.52, fontFace: theme.bodyFont, fontSize: 16, bold: true, color: theme.text, margin: 0, fit: "shrink" });
		if (metric.detail) slide.addText(String(metric.detail), { x: x + 0.28, y: y + 1.75, w: cardW - 0.56, h: Math.max(0.35, cardH - 2.0), fontFace: theme.bodyFont, fontSize: 13, color: theme.muted, margin: 0, fit: "shrink" });
	}
}

function addPptxChart(slide: any, chart: JsonObject, theme: ResolvedPptxTheme): void {
	const categories = parseArray(chart.categories, "chart.categories").map(String);
	const series = parseArray(chart.series, "chart.series").map((item) => {
		const entry = asObject(item);
		return { name: requiredString(entry.name, "chart series name"), labels: categories, values: parseArray(entry.values, "chart values").map(Number) };
	});
	const requestedType = String(chart.type ?? "column");
	const chartType = requestedType === "column" ? "bar" : requestedType;
	slide.addChart(chartType, series, {
		x: 0.85, y: 1.62, w: 11.55, h: 4.75,
		barDir: requestedType === "column" ? "col" : undefined,
		catAxisLabelFontFace: theme.bodyFont,
		catAxisLabelFontSize: 12,
		catAxisLabelColor: theme.muted,
		catAxisTitleColor: theme.text,
		valAxisLabelFontFace: theme.bodyFont,
		valAxisLabelFontSize: 12,
		valAxisLabelColor: theme.muted,
		valAxisTitleColor: theme.text,
		chartColors: [theme.primary, theme.secondary, theme.accent, "8B5CF6", "14B8A6", "E11D48"],
		showLegend: chart.showLegend !== false && series.length > 1,
		legendPos: "b",
		showValue: chart.showValues === true,
		dataLabelColor: theme.text,
		dataLabelFormatCode: "0.##",
		dataLabelPosition: "outEnd",
		showTitle: Boolean(chart.title),
		title: optionalString(chart.title),
		showCatName: false,
		showValAxisTitle: Boolean(chart.valueAxisTitle),
		valAxisTitle: optionalString(chart.valueAxisTitle),
		showCatAxisTitle: Boolean(chart.categoryAxisTitle),
		catAxisTitle: optionalString(chart.categoryAxisTitle),
		showBorder: false,
		showGridLines: true,
		gridLine: { color: "D0D5DD", transparency: 30 },
		showPercent: requestedType === "pie" || requestedType === "doughnut",
		showLeaderLines: requestedType === "pie" || requestedType === "doughnut",
	});
}

function addPptxTable(slide: any, input: unknown, theme: ResolvedPptxTheme): void {
	const spec = Array.isArray(input) ? undefined : optionalObject(input, "table");
	const rawRows = Array.isArray(input) ? input : spec?.rows;
	const rows = parseRows(rawRows);
	if (rows.length === 0) throw new Error("table requires at least one row");
	const headers = Array.isArray(spec?.headers) ? spec.headers : rows.shift();
	const width = headers?.length ?? rows[0]?.length ?? 0;
	if (width === 0 || width > 7 || rows.length > 10 || rows.some((row) => row.length !== width)) {
		throw new Error("table must be rectangular with 1-7 columns and at most 10 body rows");
	}
	const tableRows = [
		(headers ?? []).map((cell) => ({ text: String(cell ?? ""), options: { bold: true, color: "FFFFFF", fill: { color: theme.primary }, margin: 0.08 } })),
		...rows.map((row, rowIndex) => row.map((cell) => ({ text: String(cell ?? ""), options: { color: theme.text, fill: { color: rowIndex % 2 === 0 ? theme.surface : theme.background }, margin: 0.07, align: typeof cell === "number" ? "right" : "left" } }))),
	];
	slide.addTable(tableRows, { x: 0.75, y: 1.62, w: 11.75, h: Math.min(5.15, 0.72 * tableRows.length), fontFace: theme.bodyFont, fontSize: 14, border: { color: "D0D5DD", pt: 0.7 }, color: theme.text, valign: "mid", autoFit: false });
}

function addPptxTakeaway(slide: any, text: string, theme: ResolvedPptxTheme): void {
	slide.addShape("roundRect", { x: 0.85, y: 6.48, w: 11.55, h: 0.48, fill: { color: theme.primary, transparency: 88 }, line: { color: theme.primary, transparency: 55, pt: 0.8 } });
	slide.addText(text, { x: 1.05, y: 6.55, w: 11.1, h: 0.28, fontFace: theme.bodyFont, fontSize: 13, bold: true, color: theme.primary, margin: 0, align: "center", fit: "shrink" });
}

function serializePptxNotes(spec: JsonObject): string | undefined {
	const speaker = optionalObject(spec.speaker, "speaker");
	const sections: string[] = [];
	const narrative = optionalString(speaker?.narrative) ?? optionalString(spec.notes);
	if (narrative) sections.push(narrative);
	const talkingPoints = Array.isArray(speaker?.talkingPoints) ? speaker.talkingPoints.map(String) : [];
	if (talkingPoints.length > 0) sections.push(`Talking points:\n${talkingPoints.map((item) => `- ${item}`).join("\n")}`);
	const generationNotes = Array.isArray(speaker?.generationNotes)
		? speaker.generationNotes.map(String)
		: optionalString(speaker?.generationNotes)
			? [String(speaker?.generationNotes)]
			: [];
	if (generationNotes.length > 0) sections.push(`Visual generation notes:\n${generationNotes.map((item) => `- ${item}`).join("\n")}`);
	const sources = Array.isArray(speaker?.sources) ? speaker.sources.map(String) : [];
	if (sources.length > 0) sections.push(`Sources:\n${sources.map((item) => `- ${item}`).join("\n")}`);
	return sections.length > 0 ? sections.join("\n\n") : undefined;
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

function makeParagraph(text: string, theme?: ResolvedPptxTheme): Paragraph {
	return new Paragraph({
		children: [
			new TextRun({
				text,
				font: theme?.bodyFont,
				color: theme?.text,
				size: 22,
			}),
		],
	});
}

function makeDocxTable(
	rows: Array<Array<unknown>>,
	theme: ResolvedPptxTheme = PPTX_THEMES.executive,
): Table {
	return new Table({
		width: { size: 100, type: WidthType.PERCENTAGE },
		rows: rows.map(
			(row, rowIndex) =>
				new TableRow({
					children: row.map(
						(cell) =>
							new TableCell({
								shading: {
									type: ShadingType.CLEAR,
									color: "auto",
									fill:
										rowIndex === 0
											? theme.primary
											: rowIndex % 2 === 0
												? theme.background
												: theme.surface,
								},
								children: [
									new Paragraph({
										children: [
											new TextRun({
												text: String(cell ?? ""),
												bold: rowIndex === 0,
												color: rowIndex === 0 ? "FFFFFF" : theme.text,
												font: theme.bodyFont,
											}),
										],
									}),
								],
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

function xlsxTableStyle(
	preset: PptxThemePreset,
): "TableStyleMedium2" | "TableStyleMedium4" | "TableStyleMedium5" {
	if (preset === "editorial") return "TableStyleMedium4";
	if (preset === "midnight") return "TableStyleMedium2";
	if (preset === "vibrant") return "TableStyleMedium5";
	return "TableStyleMedium2";
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
	theme: ResolvedPptxTheme,
): Promise<void> {
	const { default: PDFDocumentCtor } = (await import("pdfkit")) as unknown as {
		default: new (opts?: JsonObject) => {
			pipe: (stream: PassThrough | ReturnType<typeof createWriteStream>) => void;
			fontSize: (size: number) => { text: (text: string, opts?: JsonObject) => unknown };
			font: (name: string) => unknown;
			fillColor: (color: string) => unknown;
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
		doc.fillColor(`#${theme.primary}`);
		doc.fontSize(22).text(title, { align: "left" });
		doc.fillColor(`#${theme.text}`);
		doc.moveDown(1);
	}
	for (const block of blocks) {
		const obj = asObject(block);
		const type = String(obj.type ?? "paragraph");
		if (type === "heading") {
			doc.moveDown(0.5);
			doc.font("Helvetica-Bold");
			doc.fillColor(`#${theme.primary}`);
			doc.fontSize(16).text(String(obj.text ?? ""));
			doc.font("Helvetica");
			doc.fillColor(`#${theme.text}`);
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
