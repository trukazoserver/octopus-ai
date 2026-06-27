import type { AppIconName } from "../components/ui/AppIcon.js";

export type FileKind =
	| "image"
	| "audio"
	| "video"
	| "code"
	| "spreadsheet"
	| "document"
	| "pdf"
	| "archive"
	| "text"
	| "file";

export interface FileCategory {
	kind: FileKind;
	/** AppIcon name to render for this category (images render a thumbnail instead). */
	icon: AppIconName;
	/** Short human label, e.g. "PDF", "Hoja de cálculo". */
	label: string;
	/** Accent color (hex) used for the icon badge / chip. */
	accent: string;
}

const TEXT_EXTS = new Set([
	".txt", ".md", ".markdown", ".log", ".ini", ".env", ".toml", ".rtf",
]);
const CODE_EXTS = new Set([
	".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rs", ".go",
	".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".php", ".rb",
	".pl", ".sh", ".bash", ".zsh", ".lua", ".swift", ".kt", ".scala",
	".r", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".dart",
	".json", ".xml", ".yaml", ".yml", ".html", ".htm", ".sql",
]);
const SHEET_EXTS = new Set([".xls", ".xlsx", ".ods", ".csv", ".tsv"]);
const DOC_EXTS = new Set([".doc", ".docx", ".odt", ".odp", ".ppt", ".pptx"]);
const ARCHIVE_EXTS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"]);

function extOf(name: string): string {
	const i = name.lastIndexOf(".");
	return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function fileCategory(name: string, mime?: string): FileCategory {
	const mimeLow = (mime ?? "").toLowerCase();
	const ext = extOf(name);

	if (mimeLow.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].includes(ext)) {
		return { kind: "image", icon: "file", label: "Imagen", accent: "#8b5cf6" };
	}
	if (mimeLow.startsWith("audio/") || [".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) {
		return { kind: "audio", icon: "music", label: "Audio", accent: "#f59e0b" };
	}
	if (mimeLow.startsWith("video/") || [".mp4", ".webm", ".mov", ".ogv"].includes(ext)) {
		return { kind: "video", icon: "video", label: "Video", accent: "#ef4444" };
	}
	if (ext === ".pdf") {
		return { kind: "pdf", icon: "file", label: "PDF", accent: "#dc2626" };
	}
	if (SHEET_EXTS.has(ext)) {
		return { kind: "spreadsheet", icon: "database", label: "Hoja de cálculo", accent: "#16a34a" };
	}
	if (CODE_EXTS.has(ext)) {
		return { kind: "code", icon: "code", label: "Código", accent: "#0ea5e9" };
	}
	if (ARCHIVE_EXTS.has(ext)) {
		return { kind: "archive", icon: "folder", label: "Archivo comprimido", accent: "#a16207" };
	}
	if (DOC_EXTS.has(ext)) {
		return { kind: "document", icon: "file", label: "Documento", accent: "#2563eb" };
	}
	if (TEXT_EXTS.has(ext)) {
		return { kind: "text", icon: "file", label: "Texto", accent: "#64748b" };
	}
	return { kind: "file", icon: "file", label: "Archivo", accent: "#64748b" };
}

/** Format a byte size as a compact human string. */
export function formatFileSize(bytes: number): string {
	if (!bytes || bytes < 1024) return `${bytes ?? 0} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Emoji glyph for a file kind (used in HTML-string renderers where a React icon isn't available). */
export function fileEmoji(kind: FileKind): string {
	switch (kind) {
		case "pdf":
			return "📕";
		case "document":
			return "📄";
		case "spreadsheet":
			return "📊";
		case "code":
			return "💻";
		case "archive":
			return "🗜️";
		case "text":
			return "📃";
		case "audio":
			return "🎵";
		case "video":
			return "🎬";
		case "image":
			return "🖼️";
		default:
			return "📎";
	}
}

export interface FileTypeBadge {
	/** Short uppercase format tag for the tile, e.g. "XLSX", "PDF", "PPTX". */
	label: string;
	/** Brand/background color (hex). */
	bg: string;
	/** Foreground (text) color (hex). */
	fg: string;
}

// Brand-ish colors so office formats are instantly distinguishable.
const BADGE_BG = {
	pdf: "#E5142B", // red
	excel: "#217346", // Excel green
	powerpoint: "#C43E1C", // PowerPoint orange-red
	word: "#2B579A", // Word blue
	code: "#0EA5E9", // cyan
	archive: "#B45309", // amber-brown
	text: "#475569", // slate
	audio: "#D97706", // amber
	video: "#DB2777", // pink-red
	generic: "#475569",
} as const;

// Per-extension short label (precise format). Falls back to the uppercased ext.
const EXT_BADGE: Record<string, { label: string; bg: string }> = {
	".pdf": { label: "PDF", bg: BADGE_BG.pdf },
	".xls": { label: "XLS", bg: BADGE_BG.excel },
	".xlsx": { label: "XLSX", bg: BADGE_BG.excel },
	".xlsm": { label: "XLSM", bg: BADGE_BG.excel },
	".ods": { label: "ODS", bg: BADGE_BG.excel },
	".csv": { label: "CSV", bg: BADGE_BG.excel },
	".tsv": { label: "TSV", bg: BADGE_BG.excel },
	".ppt": { label: "PPT", bg: BADGE_BG.powerpoint },
	".pptx": { label: "PPTX", bg: BADGE_BG.powerpoint },
	".pps": { label: "PPS", bg: BADGE_BG.powerpoint },
	".odp": { label: "ODP", bg: BADGE_BG.powerpoint },
	".doc": { label: "DOC", bg: BADGE_BG.word },
	".docx": { label: "DOCX", bg: BADGE_BG.word },
	".rtf": { label: "RTF", bg: BADGE_BG.word },
	".odt": { label: "ODT", bg: BADGE_BG.word },
	".zip": { label: "ZIP", bg: BADGE_BG.archive },
	".rar": { label: "RAR", bg: BADGE_BG.archive },
	".7z": { label: "7Z", bg: BADGE_BG.archive },
	".tar": { label: "TAR", bg: BADGE_BG.archive },
	".gz": { label: "GZ", bg: BADGE_BG.archive },
	".bz2": { label: "BZ2", bg: BADGE_BG.archive },
	".txt": { label: "TXT", bg: BADGE_BG.text },
	".md": { label: "MD", bg: BADGE_BG.text },
	".markdown": { label: "MD", bg: BADGE_BG.text },
	".log": { label: "LOG", bg: BADGE_BG.text },
	".mp3": { label: "MP3", bg: BADGE_BG.audio },
	".wav": { label: "WAV", bg: BADGE_BG.audio },
	".ogg": { label: "OGG", bg: BADGE_BG.audio },
	".m4a": { label: "M4A", bg: BADGE_BG.audio },
	".mp4": { label: "MP4", bg: BADGE_BG.video },
	".webm": { label: "WEBM", bg: BADGE_BG.video },
	".mov": { label: "MOV", bg: BADGE_BG.video },
};

/**
 * A compact, brand-colored format badge for a file (e.g. green "XLSX", red
 * "PDF", orange "PPTX", blue "DOCX"). Used for attachment thumbnails so each
 * file type is instantly recognizable. Code/data files fall back to their
 * uppercased extension on a code-color tile.
 */
export function fileTypeBadge(name: string, mime?: string): FileTypeBadge {
	const ext = extOf(name);
	const mapped = EXT_BADGE[ext];
	if (mapped) return { label: mapped.label, bg: mapped.bg, fg: "#ffffff" };
	const cat = fileCategory(name, mime);
	if (cat.kind === "code") {
		return {
			label: ext.replace(/^\./, "").toUpperCase().slice(0, 4) || "CODE",
			bg: BADGE_BG.code,
			fg: "#ffffff",
		};
	}
	return {
		label: ext.replace(/^\./, "").toUpperCase().slice(0, 4) || "FILE",
		bg: BADGE_BG.generic,
		fg: "#ffffff",
	};
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * A premium-style file icon as an inline SVG string: a brand-colored document
 * silhouette with a folded corner and the format label on a contrasting band.
 * Parameterized by color + label so every file type gets a distinct, recognizable
 * icon (green XLSX, red PDF, orange PPTX, blue DOCX, …) without per-type assets.
 * `height` is the rendered height in px (width follows the 40:48 aspect).
 */
export function fileIconSvg(color: string, label: string, height = 32): string {
	const width = Math.round((height * 40) / 48);
	const len = label.length;
	const fontSize = len > 3 ? 7.6 : len > 2 ? 8.4 : 9.2;
	return (
		`<svg viewBox="0 0 40 48" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
		// document body with folded top-right corner
		`<path d="M8 4 h15 l9 9 v29 a3 3 0 0 1 -3 3 H8 a3 3 0 0 1 -3 -3 V7 a3 3 0 0 1 3 -3 z" fill="${color}"/>` +
		// folded corner (depth)
		`<path d="M23 4 l9 9 h-9 z" fill="#000000" fill-opacity="0.18"/>` +
		// label band
		`<rect x="6.5" y="27" width="24" height="12" rx="2.5" fill="#000000" fill-opacity="0.24"/>` +
		// label text
		`<text x="18.5" y="35.6" text-anchor="middle" font-family="ui-sans-serif,system-ui,'Segoe UI',Arial,sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff" letter-spacing="0.4">${escapeXml(label)}</text>` +
		`</svg>`
	);
}
