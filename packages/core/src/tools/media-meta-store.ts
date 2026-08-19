/**
 * Store compartido del índice de media (~/.octopus/media/meta.json).
 *
 * Antes había dos copias independientes (transport/server.ts y tools/media.ts)
 * que releían y re-parseaban el JSON completo (~1MB con 1400+ items) en cada
 * save/resolve de las tools — puro bloqueo del event loop. Esta versión
 * cachea por mtime, mantiene el índice id→item junto al cache, escribe de
 * forma ATÓMICA (tmp + rename, con flush debounced) y reconcilia al arranque
 * los archivos que quedaron huérfanos del índice.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MEDIA_DIR = join(homedir(), ".octopus", "media");
export const MEDIA_META_PATH = join(MEDIA_DIR, "meta.json");
let mediaMetaTmpPath = `${MEDIA_META_PATH}.tmp`;

/** Solo tests: redirige el store a un directorio temporal y resetea el cache. */
export function setMediaMetaPathsForTests(paths: {
	mediaDir: string;
	metaPath: string;
}): void {
	(globalThis as Record<string, unknown>).__octopusMediaDirForTests =
		paths.mediaDir;
	(globalThis as Record<string, unknown>).__octopusMediaMetaPathForTests =
		paths.metaPath;
	mediaMetaTmpPath = `${paths.metaPath}.tmp`;
	cachedItems = [];
	cachedMtime = 0;
	cachedIndex = new Map();
	everLoaded = false;
	reconciled = false;
	dirty = false;
}

function mediaDir(): string {
	const override = (globalThis as Record<string, unknown>)
		.__octopusMediaDirForTests;
	return typeof override === "string" ? override : MEDIA_DIR;
}

function mediaMetaPath(): string {
	const override = (globalThis as Record<string, unknown>)
		.__octopusMediaMetaPathForTests;
	return typeof override === "string" ? override : MEDIA_META_PATH;
}

export interface MediaMetaItem {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	createdAt: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

let cachedItems: MediaMetaItem[] = [];
let cachedMtime = 0;
let cachedIndex = new Map<string, MediaMetaItem>();
let everLoaded = false;
let reconciled = false;

function rebuildIndex(items: MediaMetaItem[]): void {
	cachedIndex = new Map(
		items.flatMap((item) => [
			[item.id, item],
			[item.filename, item],
		]),
	);
}

function ensureMediaDir(): void {
	const dir = mediaDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Lista de items. Barato cuando el archivo no cambió (un statSync); re-lee y
 * re-parsea solo cuando el mtime avanza.
 *
 * Si el parse falla (p. ej. otra escritura en vuelo), NO se limpia el cache:
 * antes un catch vacío dejaba el índice en [] y todas las URLs de media
 * devolvían 404 hasta el siguiente flush — y un save en esa ventana
 * reemplazaba el meta completo perdiendo entradas para siempre.
 */
export function loadMediaMeta(): MediaMetaItem[] {
	ensureMediaDir();
	try {
		const metaPath = mediaMetaPath();
		const stat = statSync(metaPath);
		if (stat.mtimeMs === cachedMtime) {
			everLoaded = true;
			return cachedItems;
		}
		const parsed = JSON.parse(readFileSync(metaPath, "utf-8"));
		cachedItems = Array.isArray(parsed) ? (parsed as MediaMetaItem[]) : [];
		cachedMtime = stat.mtimeMs;
		everLoaded = true;
		rebuildIndex(cachedItems);
	} catch {
		if (!everLoaded) {
			cachedItems = [];
			cachedMtime = 0;
			rebuildIndex(cachedItems);
		}
		// Con cache previo se conserva el último estado válido.
	}
	everLoaded = true;
	if (!reconciled) {
		reconciled = true;
		reconcileOrphanMediaFiles(cachedItems);
	}
	return cachedItems;
}

/** Índice id|filename → item, consistente con el último loadMediaMeta(). */
export function getMediaMetaIndex(): Map<string, MediaMetaItem> {
	loadMediaMeta();
	return cachedIndex;
}

/** Busca un item por filename o por id (sin extensión). */
export function findMediaMetaByNameOrId(nameOrId: string): MediaMetaItem | undefined {
	return (
		getMediaMetaIndex().get(nameOrId) ??
		getMediaMetaIndex().get(nameOrId.split(".")[0] ?? "")
	);
}

/**
 * Persiste el índice completo y refresca el cache.
 *
 * El cache se actualiza YA (los lectores del mismo proceso ven el cambio al
 * instante) y la escritura a disco se debouncea: en este disco escribir los
 * ~1MB del meta.json cuesta ~500ms (antivirus escaneando el mismo archivo una
 * y otra vez), así que ráfagas de saves (keyframes de video, workflows de
 * imágenes) se coalescen en una sola escritura. La escritura es atómica
 * (tmp + rename) para que un lector concurrente jamás vea el archivo a medio
 * escribir. El flush también corre al salir del proceso.
 */
const MEDIA_META_FLUSH_DEBOUNCE_MS = 750;
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

export async function saveMediaMeta(items: MediaMetaItem[]): Promise<void> {
	ensureMediaDir();
	cachedItems = items;
	rebuildIndex(items);
	everLoaded = true;
	dirty = true;
	if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
	pendingFlushTimer = setTimeout(() => {
		pendingFlushTimer = null;
		void flushMediaMetaToDisk();
	}, MEDIA_META_FLUSH_DEBOUNCE_MS);
	pendingFlushTimer.unref?.();
}

async function flushMediaMetaToDisk(): Promise<void> {
	if (!dirty) return;
	dirty = false;
	try {
		const serialized = JSON.stringify(cachedItems, null, 2);
		await fs.writeFile(mediaMetaTmpPath, serialized, "utf-8");
		renameSync(mediaMetaTmpPath, mediaMetaPath());
		cachedMtime = statSync(mediaMetaPath()).mtimeMs;
	} catch {
		// Reintentar en el próximo save/exit.
		dirty = true;
	}
}

/** Flush síncrono de emergencia (process exit). Best-effort. */
export function flushPendingMediaMetaSync(): void {
	if (pendingFlushTimer) {
		clearTimeout(pendingFlushTimer);
		pendingFlushTimer = null;
	}
	if (!dirty) return;
	dirty = false;
	try {
		writeFileSync(mediaMetaTmpPath, JSON.stringify(cachedItems, null, 2), "utf-8");
		renameSync(mediaMetaTmpPath, mediaMetaPath());
		cachedMtime = statSync(mediaMetaPath()).mtimeMs;
	} catch {
		/* best-effort */
	}
}

process.on("exit", flushPendingMediaMetaSync);

const MEDIA_ID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]+)$/;
const EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".pdf": "application/pdf",
	".json": "application/json",
	".csv": "text/csv",
	".txt": "text/plain",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Recupera archivos UUID del directorio de media que perdieron su entrada del
 * meta (p. ej. por una carrera de escrituras del pasado). Se ignora lo
 * auxiliar (posters, previews, tmp) y las imágenes diminutas (<1KB, casi
 * siempre placeholders basura de tools que fallaron).
 */
function reconcileOrphanMediaFiles(items: MediaMetaItem[]): void {
	try {
		const known = new Set(
			items.flatMap((item) => [item.id, item.filename]),
		);
		let recovered = 0;
		const recoveredItems: MediaMetaItem[] = [];
		const dir = mediaDir();
		for (const file of readdirSync(dir)) {
			const match = MEDIA_ID_FILE_RE.exec(file);
			if (!match) continue;
			const ext = match[1].toLowerCase();
			const mimetype = EXT_MIME[ext];
			if (!mimetype) continue;
			const id = file.slice(0, file.length - ext.length);
			if (known.has(id) || known.has(file)) continue;
			let stats;
			try {
				stats = statSync(join(dir, file));
			} catch {
				continue;
			}
			if (!stats.isFile()) continue;
			if (mimetype.startsWith("image/") && stats.size < 1024) continue;
			recoveredItems.push({
				id,
				filename: file,
				mimetype,
				size: stats.size,
				createdAt: new Date(stats.mtimeMs).toISOString(),
				description: "(recuperado del disco)",
			});
			recovered++;
			if (recovered >= 500) break;
		}
		if (recoveredItems.length === 0) return;
		cachedItems = [...items, ...recoveredItems];
		rebuildIndex(cachedItems);
		dirty = true;
		console.log(
			`[media-meta-store] Recuperadas ${recoveredItems.length} entradas de media huérfanas del disco.`,
		);
		void flushMediaMetaToDisk();
	} catch {
		/* best-effort: no romper el primer load por la reconciliación */
	}
}

/**
 * Utilidad de mantenimiento: elimina del índice (y del disco) imágenes
 * diminutas que son placeholders de tools fallidas (p. ej. PNGs de 1x1).
 * Devuelve cuántas se eliminaron.
 */
export async function purgeDegeneratePlaceholderImages(): Promise<number> {
	const items = loadMediaMeta();
	const keep: MediaMetaItem[] = [];
	let removed = 0;
	for (const item of items) {
		const degenerate =
			item.mimetype.startsWith("image/") &&
			item.size < 256 &&
			/^Generated by /.test(item.description ?? "");
		if (!degenerate) {
			keep.push(item);
			continue;
		}
		removed++;
		try {
			await fs.rm(join(mediaDir(), item.filename), { force: true });
		} catch {
			/* el archivo puede no existir; la entrada se quita igual */
		}
	}
	if (removed > 0) await saveMediaMeta(keep);
	return removed;
}
