import type { Skill, ToolDefinition } from "@octopus-ai/core";
import {
	getMascotById,
	getMascotOptions,
	type MascotProfile,
} from "@octopus-ai/core/mascots/index";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type {
	ConsoleSession,
	ConsoleStatus,
	StreamEvent,
} from "../runtime/console-session.js";
import { openUrl } from "../runtime/server-session.js";
import { ActivityBar } from "./components/ActivityBar.js";
import { MarkdownText } from "./components/MarkdownText.js";
import { colors } from "./theme.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MASCOT_IMAGE_PATH = path.join(__dirname, "../assets/mascota-octopus.png");

function getMascotImagePath(mascot: MascotProfile): string {
	return path.join(__dirname, "../assets/mascotas", mascot.fileName);
}

type Message =
	| { id: string; role: "user" | "assistant" | "system"; content: string }
	| {
			id: string;
			role: "activity";
			status: string;
			toolName?: string;
			detail?: string;
			done?: boolean;
			error?: boolean;
	  };

type AppProps = {
	session: ConsoleSession;
	onExit?: () => Promise<void> | void;
};

type DashboardLayout = {
	width: number;
	sideBySide: boolean;
	mascotWidth: number;
	infoWidth: number;
	maxMascotRows: number;
};

type StreamState = {
	liveResponse: string;
	activity: { status: string; toolName?: string; detail?: string } | null;
};

type StreamAction =
	| { type: "SET_RESPONSE"; text: string }
	| { type: "SET_ACTIVITY"; activity: StreamState["activity"] }
	| { type: "RESET" };

function streamReducer(state: StreamState, action: StreamAction): StreamState {
	switch (action.type) {
		case "SET_RESPONSE": return { ...state, liveResponse: action.text };
		case "SET_ACTIVITY": return { ...state, activity: action.activity };
		case "RESET": return { liveResponse: "", activity: null };
	}
}

const VERSION = "0.7.0 (2026.4.3)";

const TITLE_ART = [
	" ███   ███  █████  ███  ████  █   █  ████       ███   ███  █████ █   █ █████ ",
	"█   █ █       █   █   █ █   █ █   █ █          █   █ █     █     ██  █   █   ",
	"█   █ █       █   █   █ ████  █   █  ███  ████ █████ █  ██ ████  █ █ █   █   ",
	"█   █ █       █   █   █ █     █   █     █      █   █ █   █ █     █  ██   █   ",
	" ███   ███    █    ███  █      ███  ████       █   █  ███  █████ █   █   █   ",
];

const MASCOT_FALLBACK = [
	"                  .::::::::::.                  ",
	"               .:@@@@@@@@@@@@@@:.               ",
	"             .:@@@@@@@@@@@@@@@@@@:.             ",
	"            .@@@@@@@@@@@@@@@@@@@@@@@@.           ",
	"           .@@@@@@@@@@@@@@@@@@@@@@@@@@.          ",
	"          .@@@@@@@@@@@@@@@@@@@@@@@@@@@@.         ",
	"          @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@         ",
	"         @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@        ",
	"        @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@       ",
	"        @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@       ",
	"       @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@      ",
	"       @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@      ",
	"       @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@      ",
	"       @@@@@@@@@@@@+...+@@@@@@@@@@@@@@@@@@@      ",
	"       @@@@@@@@@@+.........+@@@@@@@@@@@@@@@      ",
	"       @@@@@@@@@@+..@@@@@..+@@@@@@@@@@@@@@@      ",
	"       @@@@@@@@@@@+.......+@@@@@@@@@@@@@@@@      ",
	"       @@@@@@@@@@@@@@+.+@@@@@@@@@@@@@@@@@@@      ",
	"        @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@       ",
	"        @@@@@@@@@@@@*@@.@@*@@@@@@@@@@@@@@@       ",
	"         @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@        ",
	"          @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@         ",
	"          @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@         ",
	"           @@@@@@@@@@@@@@@@@@@@@@@@@@@@          ",
	"            @@@@@@@@@@@@@@@@@@@@@@@@@@           ",
	"             @@@@@@@@@@@@@@@@@@@@@@@@            ",
	"     @@@     @@@@@@@@@@@@@@@@@@@@@@@@     @@@    ",
	"   @@@@@@     @@@@@@@@@@@@@@@@@@@@@@     @@@@@@  ",
	"  @@@@@@@@     @@@@@@@@@@@@@@@@@@@@     @@@@@@@@ ",
	"  @@@@@@@@@     @@@@@@@@@@@@@@@@@@     @@@@@@@@@ ",
	"  @@@@@@@@@@     @@@@@@@@@@@@@@@@     @@@@@@@@@@ ",
	"  @@@@@@@@@@    @@@@@@@@@@@@@@@@@@    @@@@@@@@@@ ",
	"   @@@@@@@@    @@@@@@@@@@@@@@@@@@@@    @@@@@@@@  ",
	"    @@@@@@    @@@@@@@@@@@@@@@@@@@@@@    @@@@@@   ",
	"     @@@@    @@@@@@@@@@@@@@@@@@@@@@@@    @@@@    ",
	"      @@@   @@@@@@@@@@@@@@@@@@@@@@@@@@   @@@     ",
	"       @@   @@@@@@@@@@@@@@@@@@@@@@@@@@   @@      ",
	"        @  @@@@@@@@@@@@@@@@@@@@@@@@@@@@  @       ",
	"           @@@@@@@@@@@@@@@@@@@@@@@@@@@@          ",
	"            @@@@@@@@@@@@@@@@@@@@@@@@@@           ",
	"             @@@@@@@@@@@@@@@@@@@@@@              ",
	"              @@@@@@@@@@@@@@@@@@@@               ",
	"               @@@@@@@@@@@@@@@@@@                ",
	"                @@@@@@@@@@@@@@@@                 ",
	"                 @@@@@@@@@@@@@@                  ",
	"                  @@@@@@@@@@@@                   ",
	"                   @@@@@@@@@@                    ",
	"                    @@@@@@@@                     ",
	"                     @@@@@@                      ",
	"                      @@@@                       ",
	"                       @@                        ",
];

const TOOL_ROWS = [
	["browser", "browser_click, browser_navigate, browser_snapshot"],
	["file", "patch, read_file, search_files, write_file"],
	["memory", "memory_store, session_search, knowledge_add"],
	["terminal", "execute_code, run_shell, process, terminal"],
	["analyze", "inspect_data, summarize, extract, visualize"],
	["automation", "schedule_job, workflow, triggers, webhooks"],
];

const SKILL_ROWS = [
	["research", "web_research, deep_dive, citations, synthesize"],
	["creative", "ideate, copywrite, design_concepts, storytelling"],
	["developer", "code_review, build, refactor, test, debug"],
	["orchestration", "task_runner, planner, coordinator, pipelines"],
	["multimodal", "image_understand, generate_image, ocr, audio"],
	["productivity", "summarize, organize, automate, track, report"],
];

function uid(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeArray<T>(
	value: T[] | Record<string, unknown> | unknown,
): T[] {
	if (Array.isArray(value)) return value as T[];
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (Array.isArray(record.items)) return record.items as T[];
		if (Array.isArray(record.dbSkills)) return record.dbSkills as T[];
		if (Array.isArray(record.tools)) return record.tools as T[];
		if (Array.isArray(record.skills)) return record.skills as T[];
	}
	return [];
}

function compactJson(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text.padEnd(width, " ");
	return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function center(text: string, width: number): string {
	const value = text.trimEnd();
	if (value.length >= width) return fit(value, width);
	const left = Math.floor((width - value.length) / 2);
	return `${" ".repeat(left)}${value}${" ".repeat(width - value.length - left)}`;
}

function repeat(char: string, width: number): string {
	return width <= 0 ? "" : char.repeat(width);
}

function formatNumber(value: number | undefined): string {
	if (value == null || !Number.isFinite(value)) return "n/d";
	return new Intl.NumberFormat("en-US").format(value);
}

function formatUptime(seconds: number | undefined): string {
	if (seconds == null || !Number.isFinite(seconds)) return "n/d";
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

function getRequestCount(status?: ConsoleStatus): number {
	const providers = status?.usage?.byProvider ?? {};
	return Object.values(providers).reduce(
		(total, provider) => total + (provider.requests ?? 0),
		0,
	);
}

function getProviderLabel(status?: ConsoleStatus): string {
	const provider = status?.providerDisplayName ?? status?.provider;
	if (!provider) return "n/d";
	return status?.provider && provider !== status.provider
		? `${provider} (${status.provider})`
		: provider;
}

function getModelLabel(status?: ConsoleStatus): string {
	return status?.model ?? status?.provider ?? "n/d";
}

function getFallbackLabel(status?: ConsoleStatus): string {
	if (!status?.fallback) return "off";
	if (status.fallbackProvider && status.fallbackModel) {
		return `${status.fallbackProvider}/${status.fallbackModel}`;
	}
	return status.fallback;
}

function maxLineLength(lines: string[]): number {
	return lines.reduce((max, line) => Math.max(max, line.trimEnd().length), 0);
}

function proportionalArt(lines: string[], maxWidth: number, maxRows: number): string[] {
	const sourceWidth = maxLineLength(lines);
	const source = lines.map((line) => line.padEnd(sourceWidth));
	const ratio = Math.min(1, maxWidth / sourceWidth, maxRows / source.length);
	if (ratio >= 0.98) return source;

	const targetWidth = Math.max(20, Math.floor(sourceWidth * ratio));
	const targetRows = Math.max(10, Math.floor(source.length * ratio));
	return Array.from({ length: targetRows }, (_, row) => {
		const sourceRow = Math.min(source.length - 1, Math.floor(row / ratio));
		let line = "";
		for (let col = 0; col < targetWidth; col++) {
			const sourceCol = Math.min(sourceWidth - 1, Math.floor(col / ratio));
			line += source[sourceRow]?.[sourceCol] ?? " ";
		}
		return line;
	});
}

function formatTitleBlock(width: number): string {
	const blockWidth = maxLineLength(TITLE_ART);
	const left = Math.max(0, Math.floor((width - blockWidth) / 2));
	return TITLE_ART.map(
		(line) => `${" ".repeat(left)}${line.trimEnd().padEnd(blockWidth)}`,
	).join("\n");
}

function layoutFor(columns: number, rows: number): DashboardLayout {
	const width = Math.max(48, Math.min(columns, 200));
	const sideBySide = width >= 82;
	const headerRows = width - 2 >= maxLineLength(TITLE_ART) ? 7 : 3;
	const maxMascotRows = Math.max(10, Math.min(48, rows - headerRows - 10));

	if (sideBySide) {
		const sourceWidth = maxLineLength(MASCOT_FALLBACK);
		const fullMascotWidth = sourceWidth + 2;
		const mascotWidth = Math.max(
			44,
			Math.min(fullMascotWidth, Math.floor(width * 0.55), width - 50),
		);
		const infoWidth = width - mascotWidth - 5;
		return {
			width,
			sideBySide: true,
			mascotWidth,
			infoWidth,
			maxMascotRows,
		};
	}

	return {
		width,
		sideBySide: false,
		mascotWidth: width - 2,
		infoWidth: width - 4,
		maxMascotRows,
	};
}

function useTerminalSize(): { columns: number; rows: number } {
	const { stdout } = useStdout();
	const [size, setSize] = useState({
		columns: stdout?.columns ?? 120,
		rows: stdout?.rows ?? 40,
	});
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useLayoutEffect(() => {
		if (!stdout) return;
		const updateSize = () =>
			setSize({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 40 });
		const onResize = () => {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(updateSize, 500);
		};
		stdout.on("resize", onResize);
		updateSize();
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
			stdout.off("resize", onResize);
		};
	}, [stdout]);

	return size;
}

function PixelHeader({ layout }: { layout: DashboardLayout }) {
	const width = layout.width;
	const inner = width - 2;
	const titleWidth = maxLineLength(TITLE_ART);
	const canRenderTitle = inner >= titleWidth;
	const separatorWidth = Math.max(4, Math.floor((inner - 36) / 2));
	const sep = repeat("─", separatorWidth);
	const titleBlock = formatTitleBlock(inner);

	return (
		<Box flexDirection="column" paddingX={1} width={width}>
			<Text color={colors.accent}>
				{fit(`${"     ◌  ○  ◌".padEnd(inner - 10, " ")}◌  ○  ◌`, inner)}
			</Text>
			{canRenderTitle ? (
				<Text color={colors.accentBright} bold>{titleBlock}</Text>
			) : (
				<Text color={colors.accentBright} bold>
					{center("OCTOPUS-AGENT", inner)}
				</Text>
			)}
			<Text color={colors.accent}>
				{center(`◇ ${sep} Octopus Agent v${VERSION} ${sep} ◇`, inner)}
			</Text>
		</Box>
	);
}



function MascotPixel({ char, index }: { char: string; index: number }) {
	if ("@%#*+".includes(char)) return <Text key={index} color={colors.coral}>{char}</Text>;
	if ("=-:".includes(char)) return <Text key={index} color={colors.accent}>{char}</Text>;
	if (char === ".") return <Text key={index} color={colors.accentBright}>{char}</Text>;
	return <Text key={index}> </Text>;
}

function MascotLine({ line, width }: { line: string; width: number }) {
	const padded = center(line, width);
	return (
		<Text>
			{[...padded].map((char, index) => (
				<MascotPixel key={`${index}-${char}`} char={char} index={index} />
			))}
		</Text>
	);
}

type PixelBlock = { char: string; color?: string; bgColor?: string };
type ImageLine = PixelBlock[];

const pngDimensionsCache = new Map<string, { width: number; height: number } | null>();
const mascotPixelsCache = new Map<string, ImageLine[] | null>();
const MAX_MASCOT_PIXEL_CACHE = 24;

function rgbHex(r: number, g: number, b: number): string {
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function loadMascotPixels(imagePath: string, targetWidth: number, targetHeight: number): ImageLine[] | null {
	const cacheKey = `${imagePath}:${targetWidth}x${targetHeight}`;
	if (mascotPixelsCache.has(cacheKey)) return mascotPixelsCache.get(cacheKey) ?? null;
	try {
		const resolvedPath = fs.existsSync(imagePath) ? imagePath : DEFAULT_MASCOT_IMAGE_PATH;
		if (!fs.existsSync(resolvedPath)) return null;
		const raw = fs.readFileSync(resolvedPath);
		const png = PNG.sync.read(raw);
		const { width: srcW, height: srcH, data } = png;

		const isOpaque = (x: number, y: number) => {
			if (x < 0 || x >= srcW || y < 0 || y >= srcH) return false;
			return data[(y * srcW + x) * 4 + 3] > 30;
		};

		let minX = srcW, minY = srcH, maxX = 0, maxY = 0;
		for (let y = 0; y < srcH; y++) {
			for (let x = 0; x < srcW; x++) {
				if (isOpaque(x, y)) {
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
		}
		if (maxX <= minX || maxY <= minY) return null;

		const cropW = maxX - minX + 1;
		const cropH = maxY - minY + 1;
		const halfH = Math.floor(targetHeight);
		const lines: ImageLine[] = [];

		for (let row = 0; row < halfH; row++) {
			const line: PixelBlock[] = [];
			let hasContent = false;
			for (let col = 0; col < targetWidth; col++) {
				const sx = Math.min(minX + Math.floor(col * cropW / targetWidth), srcW - 1);
				const sy1 = Math.min(minY + Math.floor(row * 2 * cropH / (halfH * 2)), srcH - 1);
				const sy2 = Math.min(minY + Math.floor((row * 2 + 1) * cropH / (halfH * 2)), srcH - 1);

				const i1 = (sy1 * srcW + sx) * 4;
				const i2 = (sy2 * srcW + sx) * 4;

				const topA = data[i1 + 3];
				const botA = data[i2 + 3];
				const topOpaque = topA > 30;
				const botOpaque = botA > 30;

				if (!topOpaque && !botOpaque) {
					line.push({ char: " " });
					continue;
				}

				hasContent = true;
				const topColor = rgbHex(data[i1], data[i1 + 1], data[i1 + 2]);
				const botColor = rgbHex(data[i2], data[i2 + 1], data[i2 + 2]);

				if (topOpaque && botOpaque) {
					line.push({ char: "▄", color: botColor, bgColor: topColor });
				} else if (botOpaque && !topOpaque) {
					line.push({ char: "█", color: botColor });
				} else {
					line.push({ char: "▀", color: topColor });
				}
			}
			if (hasContent) lines.push(line);
		}

		while (lines.length > 0 && lines[lines.length - 1].every((px) => px.char === " ")) {
			lines.pop();
		}

		const result = lines.length > 0 ? lines : null;
		if (mascotPixelsCache.size >= MAX_MASCOT_PIXEL_CACHE) mascotPixelsCache.clear();
		mascotPixelsCache.set(cacheKey, result);
		return result;
	} catch {
		mascotPixelsCache.set(cacheKey, null);
		return null;
	}
}

function ImageLine({ line }: { line: ImageLine }) {
	const groups: { color?: string; bgColor?: string; text: string }[] = [];
	for (const px of line) {
		const last = groups[groups.length - 1];
		if (last && last.color === px.color && last.bgColor === px.bgColor) {
			last.text += px.char;
		} else {
			groups.push({ color: px.color, bgColor: px.bgColor, text: px.char });
		}
	}
	return (
		<Text>
			{groups.map((g, i) => (
				<Text key={i} color={g.color} backgroundColor={g.bgColor}>{g.text}</Text>
			))}
		</Text>
	);
}

function CenteredImageLine({ line, width }: { line: ImageLine; width: number }) {
	const left = Math.max(0, Math.floor((width - line.length) / 2));
	const right = Math.max(0, width - line.length - left);
	return (
		<Text>
			{" ".repeat(left)}
			<ImageLine line={line} />
			{" ".repeat(right)}
		</Text>
	);
}

function getPngDimensions(imagePath: string): { width: number; height: number } | null {
	if (pngDimensionsCache.has(imagePath)) return pngDimensionsCache.get(imagePath) ?? null;
	try {
		const resolvedPath = fs.existsSync(imagePath) ? imagePath : DEFAULT_MASCOT_IMAGE_PATH;
		if (!fs.existsSync(resolvedPath)) return null;
		const raw = fs.readFileSync(resolvedPath);
		const png = PNG.sync.read(raw);
		const result = { width: png.width, height: png.height };
		pngDimensionsCache.set(imagePath, result);
		return result;
	} catch {
		pngDimensionsCache.set(imagePath, null);
		return null;
	}
}

function MascotPanel({ layout, mascot }: { layout: DashboardLayout; mascot: MascotProfile }) {
	const panelWidth = layout.mascotWidth;
	const innerWidth = panelWidth - 2;
	const maxH = layout.maxMascotRows - 2;
	const imagePath = useMemo(() => getMascotImagePath(mascot), [mascot]);
	const dims = useMemo(() => getPngDimensions(imagePath), [imagePath]);
	const imgWidth = useMemo(() => {
		const maxWidth = Math.max(12, Math.min(innerWidth, 52));
		if (!dims) return maxWidth;
		const aspect = dims.height / dims.width;
		// Half-block rendering packs two source pixel rows into one terminal row.
		const widthLimitedByHeight = Math.floor((Math.max(6, maxH) * 2) / aspect);
		return Math.max(12, Math.min(maxWidth, widthLimitedByHeight));
	}, [dims, innerWidth, maxH]);
	const imgHeight = useMemo(() => {
		if (dims) {
			const aspect = dims.height / dims.width;
			return Math.max(4, Math.min(maxH, Math.floor((imgWidth * aspect) / 2)));
		}
		return Math.min(maxH, Math.floor(imgWidth * 1.0));
	}, [dims, imgWidth, maxH]);
	const pixels = useMemo(() => loadMascotPixels(imagePath, imgWidth, imgHeight), [imagePath, imgWidth, imgHeight]);

	if (pixels) {
		return (
			<Box flexDirection="column" width={panelWidth} paddingX={1}>
				{pixels.map((line, i) => (
					<CenteredImageLine key={`px-${i}`} line={line} width={innerWidth} />
				))}
				<Text color={colors.accent}>
					{center(`~~~   ${mascot.nombre} · ${mascot.animal}   ~~~`, innerWidth)}
				</Text>
				<Text color={colors.coral}>{center(mascot.tagline, innerWidth)}</Text>
			</Box>
		);
	}

	const art = proportionalArt(MASCOT_FALLBACK, innerWidth, layout.maxMascotRows);
	return (
		<Box flexDirection="column" width={panelWidth} paddingX={1}>
			{art.map((line, row) => (
				<MascotLine key={`octopus-${row}`} line={line} width={innerWidth} />
			))}
			<Text color={colors.accent}>
				{center(`~~~   ${mascot.nombre} · ${mascot.animal}   ~~~`, innerWidth)}
			</Text>
			<Text color={colors.coral}>{center(mascot.tagline, innerWidth)}</Text>
		</Box>
	);
}

function CapabilityRows({ rows, width }: { rows: string[][]; width: number }) {
	const valueWidth = Math.max(8, width - 17);
	return (
		<Box flexDirection="column" width={width}>
			{rows.map(([name, value]) => (
				<Text key={name}>
					<Text color={colors.text}>{fit(name ?? "", 13)}</Text>
					<Text color={colors.accent}>: </Text>
					<Text color={colors.textDim}>{fit(value ?? "", valueWidth)}</Text>
				</Text>
			))}
		</Box>
	);
}

function RuntimeRows({ status, width }: { status?: ConsoleStatus; width: number }) {
	const requests = getRequestCount(status);
	const usage = status?.usage;
	const providers = status?.availableProviders?.length
		? status.availableProviders.join(", ")
		: "n/d";
	const server = status?.server
		? `${status.server.host ?? "localhost"}:${status.server.port ?? "?"}`
		: "local";
	const runtimeRows = [
		["provider", getProviderLabel(status)],
		["model", getModelLabel(status)],
		["fallback", getFallbackLabel(status)],
		["requests", formatNumber(requests)],
		["tokens", formatNumber(usage?.totalTokens)],
		["thinking", status?.thinking ?? "n/d"],
		["max output", status?.maxTokens ? formatNumber(status.maxTokens) : "n/d"],
		["providers", providers],
		["server", server],
		["uptime", formatUptime(status?.uptime)],
	];

	return <CapabilityRows rows={runtimeRows} width={width} />;
}

function ToolsPanel({ tools, width }: { tools: unknown; width: number }) {
	const toolCount = normalizeArray<ToolDefinition>(tools).length || 14;
	const innerWidth = width - 2;

	return (
		<Box flexDirection="column" width={width} paddingX={1}>
			<Text color={colors.accent} bold>
				{fit("▣  Available Tools", innerWidth)}
			</Text>
			<CapabilityRows rows={TOOL_ROWS} width={innerWidth} />
			<Text color={colors.accent}>{repeat("─", innerWidth)}</Text>
			<Text color={colors.text}>
				{fit(`${toolCount} tools ready`, innerWidth)}
			</Text>
		</Box>
	);
}

function RuntimePanel({ status, width }: { status?: ConsoleStatus; width: number }) {
	const innerWidth = width - 2;

	return (
		<Box flexDirection="column" width={width} paddingX={1}>
			<Text color={colors.accentBright} bold>
				{fit("◈  Runtime", innerWidth)}
			</Text>
			<RuntimeRows status={status} width={innerWidth} />
		</Box>
	);
}

function SkillsPanel({ skills, width }: { skills: unknown; width: number }) {
	const skillCount = normalizeArray<Skill>(skills).length || 42;
	const innerWidth = width - 2;

	return (
		<Box flexDirection="column" width={width} paddingX={1}>
			<Text color={colors.coral} bold>
				{fit("☆  Available Skills", innerWidth)}
			</Text>
			<CapabilityRows rows={SKILL_ROWS} width={innerWidth} />
			<Text color={colors.accent}>{repeat("─", innerWidth)}</Text>
			<Text color={colors.text}>
				{fit(`${skillCount} skills • /help for commands`, innerWidth)}
			</Text>
		</Box>
	);
}

function Footer({ layout, sid, status }: { layout: DashboardLayout; sid: string; status?: ConsoleStatus }) {
	const isSmall = layout.width < 80;
	const containerWidth = layout.width - 4;
	const tip = isSmall
		? "〰 Tip: ¡Pregúntame cualquier cosa! ≋"
		: "〰〰  Tip: Soy curioso por naturaleza. ¡Pregúntame cualquier cosa!  ≋≋≋";
	const w = containerWidth - 2;
	const requestCount = getRequestCount(status);
	const tokenCount = status?.usage?.totalTokens;
	const summary = `${getProviderLabel(status)} • ${getModelLabel(status)} • ${formatNumber(requestCount)} req • ${formatNumber(tokenCount)} tokens`;

	if (isSmall) {
		return (
			<Box flexDirection="column" paddingX={2}>
				<Text color={colors.accent}>
					{fit(summary, w)}
				</Text>
				<Text color={colors.text}>
					{fit(`▣ Session: ${sid}`, w)}
				</Text>
				<Text color={colors.textDim}>{fit(tip, w)}</Text>
			</Box>
		);
	}

	const leftWidth = Math.max(30, containerWidth - 74);
	const tipWidth = Math.max(24, Math.min(72, containerWidth - leftWidth - 2));
	return (
		<Box paddingX={1} justifyContent="space-between" width={containerWidth}>
			<Box flexDirection="column" width={leftWidth}>
				<Text color={colors.accent}>
					{fit(summary, leftWidth)}
				</Text>
				<Text color={colors.text}>{fit(`▣ ${process.cwd()}`, leftWidth)}</Text>
				<Text color={colors.text}>
					{fit(`⌕ Session: ${sid}`, leftWidth)}
				</Text>
			</Box>
			<Box
				borderStyle="single"
				borderColor={colors.accent}
				paddingX={1}
				width={tipWidth}
			>
				<Text color={colors.textDim}>
					{fit(tip, tipWidth - 4)}
				</Text>
			</Box>
		</Box>
	);
}

function Dashboard({
	tools,
	skills,
	layout,
	sid,
	mascot,
	status,
}: {
	tools: unknown;
	skills: unknown;
	layout: DashboardLayout;
	sid: string;
	mascot: MascotProfile;
	status?: ConsoleStatus;
}) {
	const borderW = layout.width - 2;
	const innerW = borderW - 2;
	const topDividerHeight = Math.max(layout.maxMascotRows + 2, 12);
	const capabilityDividerHeight = Math.max(TOOL_ROWS.length, SKILL_ROWS.length) + 3;

	return (
		<Box flexDirection="column" paddingX={1} width={layout.width}>
			<Box
				borderStyle="single"
				borderColor={colors.accent}
				flexDirection="column"
				width={borderW}
			>
				{layout.sideBySide ? (
					<Box flexDirection="column">
						<Box>
							<MascotPanel layout={layout} mascot={mascot} />
							<Box flexDirection="column">
								{Array.from({ length: topDividerHeight }, (_, index) => (
									<Text key={`top-divider-${index}`} color={colors.accent}>
										│
									</Text>
								))}
							</Box>
							<RuntimePanel status={status} width={layout.infoWidth} />
						</Box>
						<Text color={colors.accent}>{repeat("─", innerW)}</Text>
						<Box>
							<Box flexDirection="column" width={layout.mascotWidth}>
								<ToolsPanel tools={tools} width={layout.mascotWidth} />
							</Box>
							<Box flexDirection="column">
								{Array.from({ length: capabilityDividerHeight }, (_, index) => (
								<Text key={`capability-divider-${index}`} color={colors.accent}>
									│
								</Text>
							))}
						</Box>
						<SkillsPanel skills={skills} width={layout.infoWidth} />
						</Box>
					</Box>
				) : (
					<Box flexDirection="column">
						<MascotPanel layout={layout} mascot={mascot} />
						<Text color={colors.accent}>{repeat("─", innerW)}</Text>
						<RuntimePanel status={status} width={layout.infoWidth} />
						<Text color={colors.accent}>{repeat("─", innerW)}</Text>
						<ToolsPanel tools={tools} width={layout.infoWidth} />
						<Text color={colors.accent}>{repeat("─", innerW)}</Text>
						<SkillsPanel skills={skills} width={layout.infoWidth} />
					</Box>
				)}
				<Text color={colors.accent}>{repeat("─", innerW)}</Text>
				<Footer layout={layout} sid={sid} status={status} />
			</Box>
		</Box>
	);
}

const MemoPixelHeader = React.memo(PixelHeader);
const MemoDashboard = React.memo(Dashboard);

function CompactHeader({ layout, busy }: { layout: DashboardLayout; busy: boolean }) {
	const width = layout.width;
	const inner = width - 4;
	return (
		<Box paddingX={2} width={width}>
			<Box
				borderStyle="round"
				borderColor={busy ? colors.accent : colors.accentDim}
				paddingX={1}
				width={width - 4}
			>
				<Text color={colors.accentBright} bold>
					{fit("OCTOPUS-AGENT", Math.max(16, Math.floor(inner * 0.35)))}
				</Text>
				<Text color={colors.textDim}> </Text>
				<Text color={colors.textDim}>
					{fit(busy ? "modo trabajo: dashboard pausado para rendimiento" : `v${VERSION}`, Math.max(12, inner - 20))}
				</Text>
			</Box>
		</Box>
	);
}

const MemoCompactHeader = React.memo(CompactHeader);

function ChatLine({ msg, width }: { msg: Message; width: number }) {
	if (msg.role === "activity") {
		return (
			<ActivityBar
				status={msg.status}
				toolName={msg.toolName}
				detail={msg.detail}
				done={msg.done}
				error={msg.error}
			/>
		);
	}
	const label =
		msg.role === "assistant" ? "octopus" : msg.role === "user" ? "you" : "sys";
	const color =
		msg.role === "assistant"
			? colors.coral
			: msg.role === "user"
				? colors.accent
				: colors.muted;
	return (
		<Box flexDirection="column">
			<Text color={color} bold>
				{label} &gt;
			</Text>
			{msg.role === "assistant" ? (
				<MarkdownText text={msg.content} width={width - 4} />
			) : (
				<Text color={msg.role === "system" ? colors.textDim : colors.text}>
					{msg.content}
				</Text>
			)}
		</Box>
	);
}

const MemoChatLine = React.memo(ChatLine);

function namedList(items: unknown[], max = 12): string {
	if (items.length === 0) return "No items found.";
	return items
		.slice(0, max)
		.map((item, index) => {
			if (item && typeof item === "object") {
				const record = item as Record<string, unknown>;
				return `${index + 1}. ${String(record.name ?? record.id ?? `item-${index + 1}`)}`;
			}
			return `${index + 1}. ${String(item)}`;
		})
		.join("\n");
}

function wrapText(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	if (!text) return [];
	const words = text.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length + word.length > maxWidth && current.length > 0) {
			lines.push(current.trimEnd());
			current = word.trimStart();
		} else {
			current += word;
		}
	}
	if (current.trimEnd()) lines.push(current.trimEnd());
	return lines.length > 0 ? lines : [""];
}

function BlinkCursor({ color }: { color: string }) {
	return <Text color={color}>█</Text>;
}

const ACTIVITY_SPINNERS: Record<string, string[]> = {
	thinking: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	tool: ["◐", "◓", "◑", "◒"],
	code: ["░", "▒", "▓", "█", "▓", "▒"],
	memory: ["⬡", "⬢", "⬣", "⬢"],
	embedding: ["◴", "◷", "◷", "◶"],
	retrieving: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	planning: ["◇", "◈", "◆", "◈"],
	responding: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"],
	browsing: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"],
	searching: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	reading: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
	writing: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"],
	tool_done: ["✓"],
	tool_error: ["✗"],
	tool_skipped: ["○"],
};

const ACTIVITY_LABELS: Record<string, string> = {
	thinking: "Pensando...",
	tool: "Ejecutando herramienta",
	code: "Ejecutando código",
	memory: "Consolidando memoria",
	embedding: "Generando embeddings",
	retrieving: "Buscando en memoria",
	planning: "Planificando acciones",
	responding: "Escribiendo respuesta",
	browsing: "Navegando en la web",
	searching: "Buscando información",
	reading: "Leyendo archivo",
	writing: "Escribiendo archivo",
	tool_done: "Herramienta completada",
	tool_error: "Error en herramienta",
	tool_skipped: "Herramienta omitida",
	closing: "Cerrando sesión",
};

function useSpinnerFrame(spinnerFrames: string[] | undefined, active: boolean): string {
	const [frame, setFrame] = useState(0);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		if (!active || !spinnerFrames || spinnerFrames.length === 0) return;
		intervalRef.current = setInterval(() => {
			setFrame((prev) => (prev + 1) % spinnerFrames.length);
		}, 180);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [active, spinnerFrames]);

	if (!active || !spinnerFrames || spinnerFrames.length === 0) return "";
	return spinnerFrames[frame % spinnerFrames.length];
}

function AnimatedActivity({
	status,
	toolName,
	detail,
	width,
}: {
	status: string;
	toolName?: string;
	detail?: string;
	width: number;
}) {
	const spinnerFrames = ACTIVITY_SPINNERS[status] || ACTIVITY_SPINNERS.thinking;
	const spinnerChar = useSpinnerFrame(spinnerFrames, true);
	const label = ACTIVITY_LABELS[status] || status;
	const isThinking = status === "thinking";
	const isCode = status === "code";
	const isBrowsing = status === "browsing" || status === "searching";
	const isMemory = status === "memory" || status === "retrieving" || status === "embedding";
	const isTool = status === "tool" || status === "reading" || status === "writing";
	const isDone = status === "tool_done";
	const isError = status === "tool_error";
	const isSkipped = status === "tool_skipped";
	const innerWidth = width - 4;

	if (isDone || isError || isSkipped) {
		const doneColor = isError ? colors.error : isSkipped ? colors.warn : colors.good;
		const icon = isError ? "✗" : isSkipped ? "○" : "✓";
		const msg = isError ? "Error" : isSkipped ? "Omitido" : "Completado";
		return (
			<Box flexDirection="column" paddingX={2} width={width}>
				<Box gap={1}>
					<Text color={doneColor} bold>{icon}</Text>
					<Text color={doneColor}>{msg}</Text>
					{toolName && <Text color={colors.textDim}>{toolName}</Text>}
					{detail && <Text color={colors.textDim}> — {detail}</Text>}
				</Box>
			</Box>
		);
	}

	let accentColor = colors.accent;
	if (isCode) accentColor = "#a78bfa";
	else if (isBrowsing) accentColor = "#60a5fa";
	else if (isMemory) accentColor = "#34d399";
	else if (isTool) accentColor = "#60a5fa";
	else if (isThinking) accentColor = colors.accentBright;

	const topColor = isThinking ? colors.accentBright : accentColor;

	return (
		<Box flexDirection="column" paddingX={1} width={width}>
			<Box
				borderStyle="round"
				borderColor={accentColor}
				paddingX={1}
				width={innerWidth}
			>
				<Box gap={1}>
					<Text color={topColor} bold>{spinnerChar}</Text>
					<Text color={topColor} bold>{label}</Text>
				</Box>
				{toolName && (
					<Text color={colors.accent}>
						{fit(toolName, innerWidth - 2)}
					</Text>
				)}
				{detail && (
					<Text color={colors.textDim}>
						{fit(detail, innerWidth - 2)}
					</Text>
				)}
				{isThinking && (
					<Text color={colors.textDim}>
						{fit("Analizando tu consulta...", innerWidth - 2)}
					</Text>
				)}
				{isCode && (
					<Text color={colors.textDim}>
						{fit("Ejecutando bloque de código...", innerWidth - 2)}
					</Text>
				)}
				{isBrowsing && (
					<Text color={colors.textDim}>
						{fit(detail || "Accediendo a página web...", innerWidth - 2)}
					</Text>
				)}
			</Box>
		</Box>
	);
}

const MemoAnimatedActivity = React.memo(AnimatedActivity);

function StreamingBlock({
	text,
	width,
	busy,
	hasContent,
	maxLines,
}: { text: string; width: number; busy: boolean; hasContent: boolean; maxLines: number }) {
	const barFrames = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"];
	const barChar = useSpinnerFrame(barFrames, busy);
	const trimmedText = maxLines > 0 ? text.split("\n").slice(-maxLines).join("\n") : text;

	return (
		<Box flexDirection="column" paddingX={2} width={width}>
			<Box gap={1}>
				<Text color={colors.coral} bold>octopus</Text>
				<Text color={colors.muted}>{!hasContent ? "thinking" : "streaming"}</Text>
				{busy && <Text color={colors.accentBright}>{barChar}</Text>}
				<Text color={colors.coral} bold> &gt;</Text>
			</Box>
			<MarkdownText text={trimmedText} width={width - 4} />
			{busy && <BlinkCursor color={colors.accent} />}
		</Box>
	);
}

const MemoStreamingBlock = React.memo(StreamingBlock);

function EscapeHandler({
	busy,
	onExit,
	onDetach,
}: { busy: boolean; onExit: () => void; onDetach: () => void }) {
	useInput((_input, key) => {
		if (key.escape) {
			if (busy) onDetach();
			else onExit();
		}
	});
	return null;
}

const InputArea = React.memo(function InputArea({
	busy,
	layout,
	onSubmit,
}: {
	busy: boolean;
	layout: DashboardLayout;
	onSubmit: (value: string) => void;
}) {
	const { isRawModeSupported } = useStdin();
	const [input, setInput] = useState("");
	const boxWidth = layout.width - 4;
	const innerWidth = boxWidth - 4;

	return (
		<Box paddingX={2} flexDirection="column" width={layout.width}>
			<Box
				borderStyle="round"
				borderColor={busy ? colors.muted : colors.accent}
				paddingX={1}
				paddingY={0}
				width={boxWidth}
			>
				{isRawModeSupported ? (
					<Box>
						<Text color={colors.coral} bold>{">"}</Text>
						<Text color={colors.textDim}> </Text>
						<TextInput
							value={input}
							onChange={setInput}
							onSubmit={(v) => {
								setInput("");
								onSubmit(v);
							}}
							focus={!busy}
						/>
						{!input && !busy && (
							<Text color={colors.muted}>
								{fit("Escribe tu mensaje o /help para ver comandos...", innerWidth - 2)}
							</Text>
						)}
					</Box>
				) : (
					<Text color={colors.muted}>
						{fit(
							"stdin no interactivo; abre esto en tu terminal para escribir.",
							innerWidth,
						)}
					</Text>
				)}
			</Box>
		</Box>
	);
});

const TOOL_HTML_RE = /<!-- tool:[\w.-]+:(?:ok|error) -->/g;
const CONTINUATION_CHECKPOINT_RE =
	/<!-- octopus-continuation-checkpoint[\s\S]*?-->\n?/g;
const XML_TAGS = ["environment_details", "thinking", "observation", "tool_call", "tool_response", "tool_result", "attempt", "scratchpad", "system_prompt", "antml", "thinking_block"];
const TAGGED_LINE_RE = /^\s*<(?:environment_details|thinking|observation|tool_call|tool_response|tool_result|attempt|scratchpad|system_prompt|antml|thinking_block)[\s>\/]/i;
const CLOSE_TAG_RE = /^\s*<\/(?:environment_details|thinking|observation|tool_call|tool_response|tool_result|attempt|scratchpad|system_prompt|antml|thinking_block)\s*>/i;

function cleanStreamText(raw: string): string {
	let cleaned = raw
		.replace(TOOL_HTML_RE, "")
		.replace(CONTINUATION_CHECKPOINT_RE, "");
	const lines = cleaned.split("\n");
	const result: string[] = [];
	let insideBlock = false;
	for (const line of lines) {
		if (TAGGED_LINE_RE.test(line)) {
			insideBlock = true;
			continue;
		}
		if (insideBlock) {
			if (CLOSE_TAG_RE.test(line)) {
				insideBlock = false;
			}
			continue;
		}
		if (/<[a-zA-Z][\w.-]*[\s>\/]/.test(line) && XML_TAGS.some(tag => line.includes(`<${tag}`))) {
			continue;
		}
		result.push(line);
	}
	return result.join("\n").trim();
}

export function OctopusApp({ session, onExit }: AppProps) {
	const app = useApp();
	const { isRawModeSupported } = useStdin();
	const [status, setStatus] = useState<ConsoleStatus>();
	const [tools, setTools] = useState<unknown>([]);
	const [skills, setSkills] = useState<unknown>([]);
	const [busy, setBusy] = useState(false);
	const [messages, setMessages] = useState<Message[]>([]);
	const [mascot, setMascot] = useState<MascotProfile>(() => getMascotById("pulpo-octavio"));
	const [stream, dispatchStream] = useReducer(streamReducer, {
		liveResponse: "",
		activity: null,
	});
	const [sid] = useState(() => Date.now().toString(36).slice(-8));
	const [toolsReady, setToolsReady] = useState<unknown>([]);
	const [skillsReady, setSkillsReady] = useState<unknown>([]);
	const terminal = useTerminalSize();

	const layout = useMemo(
		() => layoutFor(terminal.columns, terminal.rows),
		[terminal.columns, terminal.rows],
	);

	useEffect(() => {
		void Promise.all([
			session.getStatus(),
			session.getTools(),
			session.getSkills(),
			session.getConfig("mascots.defaultId"),
		]).then(([nextStatus, nextTools, nextSkills, mascotId]) => {
			setStatus(nextStatus);
			setTools(nextTools);
			setSkills(nextSkills);
			setToolsReady(nextTools);
			setSkillsReady(nextSkills);
			setMascot(getMascotById(typeof mascotId === "string" ? mascotId : undefined));
		});
	}, [session]);

	const DYNAMIC_OVERHEAD = 10;
	const maxDynamicRows = Math.max(4, terminal.rows - DYNAMIC_OVERHEAD);
	const maxMessages = Math.max(1, Math.min(12, Math.floor(maxDynamicRows / 3)));
	const visibleMessages = useMemo(() => {
		return messages.slice(-maxMessages);
	}, [messages, maxMessages]);

	const streamBuffer = useRef("");
	const streamRaf = useRef<ReturnType<typeof setTimeout> | null>(null);
	const requestDetachRef = useRef<(() => void) | null>(null);
	const currentActivityRef = useRef<StreamState["activity"]>(null);
	const [backgroundStreams, setBackgroundStreams] = useState(0);
	const [backgroundActivity, setBackgroundActivity] = useState<StreamState["activity"]>(null);
	const flushStream = useCallback(() => {
		const text = streamBuffer.current;
		if (text) dispatchStream({ type: "SET_RESPONSE", text });
		streamRaf.current = null;
	}, []);

	function detachStreamInBackground(
		streamIter: AsyncGenerator<StreamEvent>,
		initialResponse: string,
		reason: string,
		pendingNext?: Promise<IteratorResult<StreamEvent>>,
	): void {
		const messageId = uid();
		const initialText = cleanStreamText(initialResponse);
		const initialContent = initialText
			? `${initialText}\n\n[${reason}]`
			: `[${reason}]`;

		setMessages((m) => [
			...m,
			{ id: messageId, role: initialText ? "assistant" : "system", content: initialContent },
		]);
		if (streamRaf.current) {
			clearTimeout(streamRaf.current);
			streamRaf.current = null;
		}
		dispatchStream({ type: "RESET" });
		streamBuffer.current = "";
		setBackgroundStreams((count) => count + 1);
		setBackgroundActivity(
			currentActivityRef.current ?? {
				status: "tool",
				detail: reason,
			},
		);

		void (async () => {
			let response = initialResponse;
			let nextResult = pendingNext;
			try {
				while (true) {
					const result = nextResult ? await nextResult : await streamIter.next();
					nextResult = undefined;
					if (result.done) break;
					const event = result.value;
					if (event.type === "content") response += event.content;
					if (event.type === "status") {
						setBackgroundActivity({
							status: event.status,
							toolName: event.toolName,
							detail: event.detail,
						});
					}
				}

				const finalText = cleanStreamText(response);
				setMessages((m) =>
					m.map((message) =>
						message.id === messageId
							? {
									id: messageId,
									role: "assistant",
									content: finalText || "El agente terminó sin contenido adicional.",
								}
							: message,
					),
				);
			} catch (err) {
				const finalText = cleanStreamText(response);
				const errorText = err instanceof Error ? err.message : String(err);
				setMessages((m) =>
					m.map((message) =>
						message.id === messageId
							? {
									id: messageId,
									role: finalText ? "assistant" : "system",
									content: `${finalText || reason}\n\n[La respuesta en segundo plano terminó con error: ${errorText}]`,
								}
							: message,
					),
				);
			} finally {
				setBackgroundStreams((count) => Math.max(0, count - 1));
				setBackgroundActivity(null);
				currentActivityRef.current = null;
			}
		})();
	}

	async function exit() {
		await session.shutdown();
		await onExit?.();
		app.exit();
	}

	async function runCommand(raw: string): Promise<void> {
		const [command = "", ...args] = raw.trim().split(/\s+/);
		const cmd = command.toLowerCase();
		if (cmd === "/exit" || cmd === "/quit") return exit();
		if (cmd === "/clear") {
			await session.clearContext();
			setMessages([]);
			return;
		}
		if (cmd === "/open" || cmd === "/web") {
			openUrl(session.webUrl);
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: `Opened ${session.webUrl}` },
			]);
			return;
		}
		if (cmd === "/status") {
			const s = await session.getStatus();
			setStatus(s);
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: compactJson(s) },
			]);
			return;
		}
		if (cmd === "/tools") {
			const t = await session.getTools();
			setTools(t);
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: compactJson(t) },
			]);
			return;
		}
		if (cmd === "/skills") {
			const s = await session.getSkills();
			setSkills(s);
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: compactJson(s) },
			]);
			return;
		}
		if (cmd === "/mascots") {
			setMessages((m) => [
				...m,
				{
					id: uid(),
					role: "system",
					content: getMascotOptions()
						.map((item) => `${item.id} - ${item.nombre} (${item.animal}): ${item.tagline}`)
						.join("\n"),
				},
			]);
			return;
		}
		if (cmd === "/mascot") {
			const nextId = args[0];
			const nextMascot = getMascotById(nextId);
			if (!nextId || nextMascot.id !== nextId) {
				setMessages((m) => [
					...m,
					{
						id: uid(),
						role: "system",
						content: `Uso: /mascot <id>\nDisponibles: ${getMascotOptions().map((item) => item.id).join(", ")}`,
					},
				]);
				return;
			}
			if (session.setConfig) await session.setConfig("mascots.defaultId", nextMascot.id);
			setMascot(nextMascot);
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: `Mascota activa: ${nextMascot.nombre} (${nextMascot.animal})` },
			]);
			return;
		}
		if (cmd === "/memory") {
			const memory = await session.getMemory();
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: compactJson(memory) },
			]);
			return;
		}
		if (cmd === "/doctor") {
			setMessages((m) => [
				...m,
				{
					id: uid(),
					role: "system",
					content: `Server: ${status?.status ?? "unknown"}\nDashboard: ${session.webUrl}`,
				},
			]);
			return;
		}
		if (cmd === "/config") {
			const key = args[0] === "get" ? args[1] : args[0];
			const config = await session.getConfig(key);
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: compactJson(config) },
			]);
			return;
		}
		if (cmd === "/agents") {
			const agents = await session.getAgents();
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: namedList(agents) },
			]);
			return;
		}
		if (cmd === "/tasks") {
			const tasks = await session.getTasks();
			setMessages((m) => [
				...m,
				{ id: uid(), role: "system", content: namedList(tasks) },
			]);
			return;
		}
		setMessages((m) => [
			...m,
			{
				id: uid(),
				role: "system",
				content:
					"/help /exit /clear /status /tools /skills /mascots /mascot /memory /web /doctor /config /agents /tasks",
			},
		]);
	}

const RETRYABLE_PATTERNS = /(?:500|502|503|504|network error|timeout|idle|ECONNRESET|ECONNREFUSED)/i;

function getPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_RETRIES = getPositiveIntEnv("OCTOPUS_TUI_MAX_RETRIES", 3);
const INITIAL_IDLE_TIMEOUT_MS = getPositiveIntEnv(
	"OCTOPUS_TUI_INITIAL_IDLE_TIMEOUT_MS",
	15 * 60 * 1000,
);
const CONTENT_IDLE_TIMEOUT_MS = getPositiveIntEnv(
	"OCTOPUS_TUI_CONTENT_IDLE_TIMEOUT_MS",
	15 * 60 * 1000,
);
const STREAM_TIMEOUT_MS = getPositiveIntEnv(
	"OCTOPUS_TUI_STREAM_TIMEOUT_MS",
	4 * 60 * 60 * 1000,
);

function isRetryableError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return RETRYABLE_PATTERNS.test(msg);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class StreamIdleTimeoutError extends Error {
	constructor(public pendingNext: Promise<IteratorResult<StreamEvent>>) {
		super("Stream idle timeout");
		this.name = "StreamIdleTimeoutError";
	}
}

class StreamDetachRequestedError extends Error {
	constructor(public pendingNext: Promise<IteratorResult<StreamEvent>>) {
		super("Stream detached by user");
		this.name = "StreamDetachRequestedError";
	}
}

async function submit(value: string): Promise<void> {
		const trimmed = value.trim();
		if (!trimmed || busy) return;
		if (backgroundStreams > 0 && !trimmed.startsWith("/")) {
			setMessages((m) => [
				...m,
				{
					id: uid(),
					role: "system",
					content: "Hay una respuesta del agente trabajando en segundo plano. Puedes usar comandos como /status, /tasks o /exit; espera a que termine antes de enviar otro mensaje al agente.",
				},
			]);
			return;
		}
		setBusy(true);
		dispatchStream({ type: "RESET" });
		streamBuffer.current = "";
		currentActivityRef.current = null;
		setMessages((m) => [...m, { id: uid(), role: "user", content: trimmed }]);
		try {
			if (trimmed.startsWith("/")) {
				await runCommand(trimmed);
			} else {
				let lastErr: unknown = null;
				let lastAttempt = 0;
				let retrying = false;
				let detachedToBackground = false;

				for (lastAttempt = 1; lastAttempt <= MAX_RETRIES; lastAttempt++) {
					try {
						let response = "";
						let lastFlush = 0;
						let lastActivity = 0;
						const FLUSH_MS = 550;
						const streamStart = Date.now();
						const streamIter = session.streamMessage(trimmed);
						let timedOut = false;
						let streamCompleted = false;
						let shouldCloseStream = false;
						let detachRequested = false;
						let detachWake: (() => void) | null = null;
						requestDetachRef.current = () => {
							detachRequested = true;
							detachWake?.();
						};

						if (retrying) {
							currentActivityRef.current = { status: "thinking", detail: `Reintentando (${lastAttempt}/${MAX_RETRIES})...` };
							dispatchStream({
								type: "SET_ACTIVITY",
								activity: currentActivityRef.current,
							});
						}

						const nextEvent = async () => {
							let timer: ReturnType<typeof setTimeout> | undefined;
							const pendingNext = streamIter.next();
							const timeSinceActivity = Date.now() - lastActivity;
							const hasRecentActivity = timeSinceActivity < 30_000;
							const timeoutMs = hasRecentActivity
								? 60_000
								: response.trim()
									? CONTENT_IDLE_TIMEOUT_MS
									: INITIAL_IDLE_TIMEOUT_MS;
							try {
								return await Promise.race([
									pendingNext,
									new Promise<IteratorResult<StreamEvent>>((_, reject) => {
										timer = setTimeout(
											() => reject(new StreamIdleTimeoutError(pendingNext)),
											timeoutMs,
										);
									}),
									new Promise<IteratorResult<StreamEvent>>((_, reject) => {
										if (detachRequested) {
											reject(new StreamDetachRequestedError(pendingNext));
											return;
										}
										detachWake = () => reject(new StreamDetachRequestedError(pendingNext));
									}),
								]);
							} finally {
								if (timer) clearTimeout(timer);
								detachWake = null;
							}
						};
						try {
							while (Date.now() - streamStart < STREAM_TIMEOUT_MS) {
								const result = await nextEvent();
								if (result.done) {
									streamCompleted = true;
									break;
								}
								const event = result.value;
								if (event.type === "status") {
									lastActivity = Date.now();
									currentActivityRef.current = {
										status: event.status,
										toolName: event.toolName,
										detail: event.detail,
									};
									if (
										stream.activity?.status !== event.status ||
										stream.activity?.toolName !== event.toolName ||
										stream.activity?.detail !== event.detail
									) {
										dispatchStream({
											type: "SET_ACTIVITY",
											activity: currentActivityRef.current,
										});
									}
								}
								if (event.type === "content") {
									response += event.content;
									const now = Date.now();
									streamBuffer.current = response;
									if (now - lastFlush >= FLUSH_MS) {
										lastFlush = now;
										if (streamRaf.current) clearTimeout(streamRaf.current);
										streamRaf.current = null;
										dispatchStream({ type: "SET_RESPONSE", text: response });
									} else if (!streamRaf.current) {
										streamRaf.current = setTimeout(() => {
											flushStream();
										}, FLUSH_MS);
									}
								}
							}
							if (!streamCompleted && Date.now() - streamStart >= STREAM_TIMEOUT_MS) {
								timedOut = true;
								detachedToBackground = true;
								requestDetachRef.current = null;
								detachStreamInBackground(
									streamIter,
									response,
									"La respuesta superó el tiempo máximo visible; el agente sigue trabajando en segundo plano",
								);
							}
						} catch (streamErr) {
							if (streamErr instanceof StreamIdleTimeoutError || streamErr instanceof StreamDetachRequestedError) {
								detachedToBackground = true;
								requestDetachRef.current = null;
								detachStreamInBackground(
									streamIter,
									response,
									streamErr instanceof StreamDetachRequestedError
										? "Desacoplé esta respuesta; el agente sigue trabajando en segundo plano"
										: "El stream quedó inactivo; el agente sigue trabajando en segundo plano",
									streamErr.pendingNext,
								);
							} else if (response.trim()) {
								timedOut = true;
								shouldCloseStream = true;
							} else {
								lastErr = streamErr;
								const cancelStream = streamIter.return?.(undefined);
								void cancelStream?.catch(() => {});
								if (isRetryableError(streamErr) && lastAttempt < MAX_RETRIES) {
									const delay = 2000 * (2 ** (lastAttempt - 1));
									currentActivityRef.current = { status: "thinking", detail: `Error del servidor. Reintentando en ${delay / 1000}s...` };
									dispatchStream({
										type: "SET_ACTIVITY",
										activity: currentActivityRef.current,
									});
									await sleep(delay);
									retrying = true;
									dispatchStream({ type: "RESET" });
									streamBuffer.current = "";
									continue;
								}
								throw streamErr;
							}
						} finally {
							if (shouldCloseStream && !detachedToBackground) {
								const cancelStream = streamIter.return?.(undefined);
								void cancelStream?.catch(() => {});
							}
						}
						if (detachedToBackground) {
							lastErr = null;
							break;
						}
						if (streamRaf.current) {
							clearTimeout(streamRaf.current);
							streamRaf.current = null;
						}
						dispatchStream({ type: "RESET" });
						const cleaned = cleanStreamText(response);
						if (cleaned.trim())
							setMessages((m) => [
								...m,
								{ id: uid(), role: "assistant", content: cleaned + (timedOut ? "\n\n⚠️ Stream timed out — partial response shown." : "") },
							]);
						lastErr = null;
						requestDetachRef.current = null;
						break;
					} catch (retryErr) {
						lastErr = retryErr;
						if (isRetryableError(retryErr) && lastAttempt < MAX_RETRIES) {
							const delay = 2000 * (2 ** (lastAttempt - 1));
							currentActivityRef.current = { status: "thinking", detail: `Error del servidor. Reintentando en ${delay / 1000}s...` };
							dispatchStream({
								type: "SET_ACTIVITY",
								activity: currentActivityRef.current,
							});
							await sleep(delay);
							retrying = true;
							dispatchStream({ type: "RESET" });
							streamBuffer.current = "";
							continue;
						}
						break;
					}
				}

				if (lastErr) {
					dispatchStream({ type: "RESET" });
					setMessages((m) => [
						...m,
						{
							id: uid(),
							role: "system",
							content: `Error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
						},
					]);
				}
			}
		} catch (err) {
			dispatchStream({ type: "RESET" });
			setMessages((m) => [
				...m,
				{
					id: uid(),
					role: "system",
					content: `Error: ${err instanceof Error ? err.message : String(err)}`,
				},
			]);
		} finally {
			requestDetachRef.current = null;
			try {
				setStatus(await session.getStatus());
			} catch {
				// Keep the last known status if the refresh endpoint is temporarily unavailable.
			}
			setBusy(false);
		}
	}

	return (
		<Box flexDirection="column" width={layout.width}>
			{isRawModeSupported && (
				<EscapeHandler
					busy={busy}
					onExit={() => void exit()}
					onDetach={() => requestDetachRef.current?.()}
				/>
			)}
			{busy ? (
				<MemoCompactHeader layout={layout} busy={busy} />
			) : (
				<>
					<MemoPixelHeader layout={layout} />
					<MemoDashboard tools={toolsReady} skills={skillsReady} layout={layout} sid={sid} mascot={mascot} status={status} />
				</>
			)}
			{visibleMessages.length > 0 && (
				<Box flexDirection="column" paddingX={2} width={layout.width - 2}>
					{visibleMessages.map((message) => (
						<MemoChatLine key={message.id} msg={message} width={layout.width - 4} />
					))}
				</Box>
			)}
			{backgroundStreams > 0 && !busy && (
				<>
					<MemoAnimatedActivity
						status={backgroundActivity?.status ?? "tool"}
						toolName={backgroundActivity?.toolName}
						detail={
							backgroundActivity?.detail ??
							(backgroundStreams === 1
								? "El agente sigue trabajando en segundo plano. Comandos disponibles; espera para enviar otro mensaje."
								: `${backgroundStreams} respuestas siguen trabajando en segundo plano. Comandos disponibles; espera para enviar otro mensaje.`)
						}
						width={layout.width}
					/>
					<Box paddingX={2} width={layout.width - 2}>
						<Text color={colors.warn}>
							Input desbloqueado: puedes usar comandos mientras Octopus termina esta tarea.
						</Text>
					</Box>
				</>
			)}
			{busy && stream.activity && !stream.liveResponse && (
				<MemoAnimatedActivity
					status={stream.activity.status}
					toolName={stream.activity.toolName}
					detail={stream.activity.detail}
					width={layout.width}
				/>
			)}
			{busy && stream.liveResponse && (
				<>
					{stream.activity && (
						<Box paddingX={2} width={layout.width - 2}>
							<ActivityBar
								status={stream.activity.status}
								toolName={stream.activity.toolName}
								detail={stream.activity.detail}
								busy
							/>
						</Box>
					)}
					<MemoStreamingBlock
						text={cleanStreamText(stream.liveResponse)}
						width={layout.width - 2}
						busy={busy}
						hasContent={!!stream.liveResponse}
						maxLines={Math.max(5, maxDynamicRows - 6)}
					/>
				</>
			)}
			<InputArea busy={busy} layout={layout} onSubmit={(v) => void submit(v)} />
		</Box>
	);
}
