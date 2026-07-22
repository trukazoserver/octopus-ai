import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const PREVIEW_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M2 12s3-4 7-4 7 4 7 4-3 4-7 4-7-4-7-4Z"/><circle cx="9" cy="12" r="1"/></svg>`;
const SUPPORTED_OFFICE = new Set([".doc", ".docx", ".rtf", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".ods", ".odp"]);
const CONVERSION_TARGETS = new Set(["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp"]);
const MAX_INPUT_BYTES = 250 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 150_000;
const MAX_PREVIEW_PAGES = 20;

export function createOfficePreviewTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	const roots = allowedPaths.map((root) => path.resolve(expandHome(root)));
	const resolvePath = (raw: string) => {
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
	const authorizeOutput = async (resolved: string) => {
		await authorize(resolved);
		await mkdir(path.dirname(resolved), { recursive: true });
		await authorize(resolved);
	};

	const tool: ToolDefinition = {
		name: "office_convert_preview",
		description:
			"Convert DOCX, PPTX, XLSX, ODT, ODS, or ODP to PDF with LibreOffice headless and optionally render selected PDF pages to PNG previews for visual QA. PDF input can be rendered directly. Returns output paths and validation details.",
		uiIcon: PREVIEW_SVG,
		managesOwnPathPolicy: true,
		longRunning: true,
		parameters: {
			source: { type: "string", description: "Input Office or PDF path", required: true },
			outputPath: { type: "string", description: "Output PDF path", required: true },
			previewDir: { type: "string", description: "Optional directory for PNG page previews", required: false },
			previewPages: { type: "string", description: "Pages to preview, e.g. 1-3,8; default 1", required: false },
			overwrite: { type: "boolean", description: "Overwrite output/preview files, default false", required: false },
		},
		handler: async (params, context): Promise<ToolResult> => {
			try {
				const source = resolvePath(requiredString(params.source, "source"));
				const outputPath = resolvePath(requiredString(params.outputPath, "outputPath"));
				await authorize(source);
				await authorizeOutput(outputPath);
				if (path.extname(outputPath).toLowerCase() !== ".pdf") throw new Error("outputPath must end with .pdf");
				if (!params.overwrite && (await pathExists(outputPath))) throw new Error(`Output already exists: ${outputPath}`);
				const info = await stat(source);
				if (!info.isFile()) throw new Error("source must be a regular file");
				if (info.size > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES / 1024 / 1024} MB`);
				const ext = path.extname(source).toLowerCase();
				if (ext !== ".pdf" && !SUPPORTED_OFFICE.has(ext)) throw new Error(`Unsupported preview format: ${ext}`);
				context?.onProgress?.("Preparing Office preview conversion");
				if (ext === ".pdf") {
					if (!samePath(source, outputPath)) await copyFile(source, outputPath);
				} else {
					await convertOfficeFileToPdf(source, outputPath, {
						abortSignal: context?.agent?.abortSignal,
					});
				}
				const pdfBytes = await readFile(outputPath);
				if (pdfBytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Converted output is not a valid PDF");
				let previewPaths: string[] = [];
				let previewWarning: string | undefined;
				const previewDirRaw = optionalString(params.previewDir);
				if (previewDirRaw) {
					const previewDir = resolvePath(previewDirRaw);
					await authorizeOutput(path.join(previewDir, "page-0001.png"));
					if (!params.overwrite && (await directoryHasFiles(previewDir))) {
						throw new Error(`Preview directory is not empty: ${previewDir}`);
					}
					context?.onProgress?.("Rendering PDF preview pages");
					try {
						previewPaths = await renderPdfPreviewPages(outputPath, previewDir, optionalString(params.previewPages) ?? "1");
					} catch (err) {
						previewWarning = err instanceof Error ? err.message : String(err);
					}
				}
				return {
					success: true,
					output: JSON.stringify(
						{
							operation: "office_convert_preview",
							source,
							pdfPath: outputPath,
							previewPaths,
							previewWarning,
							validated: true,
						},
						null,
						2,
					),
					metadata: { pdfPath: outputPath, previewPaths, previewWarning },
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	};
	const convertTool: ToolDefinition = {
		name: "office_convert",
		description:
			"Convert between Office/OpenDocument formats with LibreOffice headless. Supports DOC/DOCX/RTF/ODT, XLS/XLSX/ODS, PPT/PPTX/ODP and PDF targets. Use this to modernize legacy files before structural editing.",
		uiIcon: PREVIEW_SVG,
		managesOwnPathPolicy: true,
		longRunning: true,
		parameters: {
			source: { type: "string", description: "Input Office/OpenDocument path", required: true },
			outputPath: { type: "string", description: "Output path; extension selects target format", required: true },
			overwrite: { type: "boolean", description: "Overwrite existing output, default false", required: false },
		},
		handler: async (params, context): Promise<ToolResult> => {
			try {
				const source = resolvePath(requiredString(params.source, "source"));
				const outputPath = resolvePath(requiredString(params.outputPath, "outputPath"));
				await authorize(source);
				await authorizeOutput(outputPath);
				const sourceExt = path.extname(source).toLowerCase();
				const target = path.extname(outputPath).toLowerCase().slice(1);
				if (!SUPPORTED_OFFICE.has(sourceExt)) throw new Error(`Unsupported Office input: ${sourceExt}`);
				if (!CONVERSION_TARGETS.has(target)) throw new Error(`Unsupported conversion target: ${target}`);
				if (!params.overwrite && await pathExists(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
				context?.onProgress?.(`Converting ${sourceExt.slice(1).toUpperCase()} to ${target.toUpperCase()}`);
				await convertOfficeFile(source, outputPath, target, { abortSignal: context?.agent?.abortSignal });
				return {
					success: true,
					output: JSON.stringify({ operation: "office_convert", source, outputPath, target, validated: true }, null, 2),
					metadata: { outputPath, target },
				};
			} catch (error) {
				return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
	return [tool, convertTool];
}

export async function convertOfficeFileToPdf(
	source: string,
	outputPath: string,
	options: { abortSignal?: AbortSignal } = {},
): Promise<void> {
	return convertOfficeFile(source, outputPath, "pdf", options);
}

export async function convertOfficeFile(
	source: string,
	outputPath: string,
	targetFormat: string,
	options: { abortSignal?: AbortSignal } = {},
): Promise<void> {
	if (!CONVERSION_TARGETS.has(targetFormat)) throw new Error(`Unsupported conversion target: ${targetFormat}`);
	const soffice = findLibreOfficeExecutable();
	if (!soffice) {
		throw new Error(
			"LibreOffice/soffice was not found. Install LibreOffice or set OCTOPUS_SOFFICE_PATH to enable Office-to-PDF preview conversion.",
		);
	}
	const staging = await mkdtemp(path.join(path.dirname(outputPath), ".octopus-office-"));
	const conversionDir = path.join(staging, "converted");
	const profileDir = path.join(staging, "profile");
	await mkdir(conversionDir, { recursive: true });
	await mkdir(profileDir, { recursive: true });
	try {
		const args = [
			`-env:UserInstallation=${pathToFileURL(profileDir).href}`,
			"--headless",
			"--nologo",
			"--nodefault",
			"--nofirststartwizard",
			"--norestore",
			"--convert-to",
			targetFormat,
			"--outdir",
			conversionDir,
			source,
		];
		await runProcess(soffice, args, CONVERSION_TIMEOUT_MS, options.abortSignal);
		const outputs = (await readdir(conversionDir)).filter((name) => name.toLowerCase().endsWith(`.${targetFormat}`));
		if (outputs.length !== 1) throw new Error(`LibreOffice produced ${outputs.length} ${targetFormat.toUpperCase()} files; expected exactly one`);
		const converted = path.join(conversionDir, outputs[0] ?? "");
		const bytes = await readFile(converted);
		if (bytes.length === 0) throw new Error("LibreOffice produced an empty output file");
		if (targetFormat === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("LibreOffice output is not a PDF");
		await writeFile(outputPath, bytes);
	} finally {
		await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
	}
}

export function findLibreOfficeExecutable(): string | null {
	const explicit = process.env.OCTOPUS_SOFFICE_PATH?.trim();
	const candidates = [
		explicit,
		...pathCandidates("soffice.com"),
		...pathCandidates("soffice.exe"),
		...pathCandidates("soffice"),
		...pathCandidates("libreoffice"),
		process.platform === "win32" ? "C:\\Program Files\\LibreOffice\\program\\soffice.com" : undefined,
		process.platform === "win32" ? "C:\\Program Files\\LibreOffice\\program\\soffice.exe" : undefined,
		process.platform === "win32" ? "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe" : undefined,
		process.env.LOCALAPPDATA
			? path.join(process.env.LOCALAPPDATA, "Programs", "LibreOffice", "program", "soffice.com")
			: undefined,
		process.env.LOCALAPPDATA
			? path.join(process.env.LOCALAPPDATA, "Programs", "LibreOffice", "program", "soffice.exe")
			: undefined,
		process.platform === "darwin" ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : undefined,
		process.platform !== "win32" ? "/usr/bin/libreoffice" : undefined,
		process.platform !== "win32" ? "/usr/bin/soffice" : undefined,
	].filter((candidate): candidate is string => Boolean(candidate));
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function pathCandidates(executable: string): string[] {
	return (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.map((dir) => path.join(dir.replace(/^"|"$/g, ""), executable));
}

async function runProcess(
	command: string,
	args: string[],
	timeoutMs: number,
	abortSignal?: AbortSignal,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { shell: false, windowsHide: true });
		let stderr = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			abortSignal?.removeEventListener("abort", onAbort);
			error ? reject(error) : resolve();
		};
		const terminate = () => {
			if (process.platform === "win32" && child.pid) {
				spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
					shell: false,
					windowsHide: true,
				});
			} else child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			terminate();
			finish(new Error(`LibreOffice conversion timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const onAbort = () => {
			terminate();
			finish(new Error("Office conversion aborted"));
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 65_536) stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => finish(err));
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(`LibreOffice conversion failed (exit ${code}): ${stderr.slice(0, 2000)}`));
		});
	});
}

export async function renderPdfPreviewPages(pdfPath: string, outputDir: string, pageSpec: string): Promise<string[]> {
	const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
	const canvasMod = (await import("@napi-rs/canvas")) as any;
	const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await readFile(pdfPath)), useSystemFonts: true });
	const doc = await loadingTask.promise;
	try {
		const pages = parsePages(pageSpec, doc.numPages).slice(0, MAX_PREVIEW_PAGES);
		await mkdir(outputDir, { recursive: true });
		const outputs: string[] = [];
		for (const pageNumber of pages) {
			const page = await doc.getPage(pageNumber);
			const viewport = page.getViewport({ scale: 1.5 });
			if (viewport.width * viewport.height > 40_000_000) throw new Error(`Preview page ${pageNumber} is too large to render safely`);
			const canvas = canvasMod.createCanvas(viewport.width, viewport.height);
			await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
			const output = path.join(outputDir, `page-${String(pageNumber).padStart(4, "0")}.png`);
			await writeFile(output, canvas.toBuffer("image/png"));
			outputs.push(output);
		}
		return outputs;
	} finally {
		await loadingTask.destroy();
	}
}

function parsePages(spec: string, total: number): number[] {
	const result = new Set<number>();
	for (const part of spec.split(",")) {
		const value = part.trim();
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(value);
		if (range) {
			for (let page = Number(range[1]); page <= Number(range[2]); page++) {
				if (page >= 1 && page <= total) result.add(page);
			}
		} else if (/^\d+$/.test(value)) {
			const page = Number(value);
			if (page >= 1 && page <= total) result.add(page);
		}
	}
	return [...result].sort((a, b) => a - b);
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

async function pathExists(filePath: string): Promise<boolean> {
	return stat(filePath).then(() => true, () => false);
}

async function directoryHasFiles(dirPath: string): Promise<boolean> {
	if (!(await pathExists(dirPath))) return false;
	return (await readdir(dirPath)).length > 0;
}

function samePath(a: string, b: string): boolean {
	return process.platform === "win32"
		? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
		: path.resolve(a) === path.resolve(b);
}
