/**
 * Media content validation.
 *
 * Keeps broken / placeholder payloads (failed image generations, web-scrape
 * fragments, shell error output, etc.) out of the media library by checking
 * that the bytes actually look like the media type they claim to be.
 *
 * Shared by tools/media.ts (agent save/import tools) and transport/server.ts
 * (HTTP upload/save endpoints) so every write path is guarded the same way.
 */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac"]);

export function fileExtension(filename?: string): string {
	return (filename || "").split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Detect the media MIME type from magic bytes. Returns null when the bytes do
 * not start with any known image/video/audio signature (i.e. the payload is
 * almost certainly not real media).
 */
export function detectMediaKind(buf: Buffer): string | null {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return "image/png";
	}
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return "image/jpeg";
	}
	if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
		return "image/gif";
	}
	if (
		buf.length >= 12 &&
		buf.subarray(0, 4).toString("latin1") === "RIFF" &&
		buf.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return "image/webp";
	}
	if (
		buf.length >= 12 &&
		buf.subarray(0, 4).toString("latin1") === "RIFF" &&
		buf.subarray(8, 12).toString("latin1") === "WAVE"
	) {
		return "audio/wav";
	}
	if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
		return "video/mp4";
	}
	if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
		return "video/webm";
	}
	if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "OggS") {
		return "audio/ogg";
	}
	if (buf.length >= 3 && buf.subarray(0, 3).toString("latin1") === "ID3") {
		return "audio/mpeg";
	}
	if (
		buf.length >= 2 &&
		buf[0] === 0xff &&
		(buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)
	) {
		return "audio/mpeg";
	}
	return null;
}

export interface MediaValidationResult {
	valid: boolean;
	reason?: string;
	detected?: string | null;
}

/**
 * Validate that `buffer` is coherent with the declared `mimeType` / `filename`.
 *
 * Non-media types (PDF, JSON, CSV, text, octet-stream, ...) are accepted as-is
 * — only payloads that claim to be image/video/audio are checked, since those
 * are the ones that render as broken thumbnails when corrupted.
 */
export function validateMediaBytes(
	buffer: Buffer,
	mimeType?: string,
	filename?: string,
): MediaValidationResult {
	const ext = fileExtension(filename);
	const declaredKind = (mimeType || "").split("/")[0];
	const isImage = declaredKind === "image" || IMAGE_EXTS.has(ext);
	const isVideo = declaredKind === "video" || VIDEO_EXTS.has(ext);
	const isAudio = declaredKind === "audio" || AUDIO_EXTS.has(ext);

	// SVG is text/XML, not covered by binary magic bytes.
	if (mimeType === "image/svg+xml" || ext === "svg") {
		const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("utf8").toLowerCase();
		if (head.includes("<svg")) return { valid: true, detected: "image/svg+xml" };
		return {
			valid: false,
			reason: "El contenido no es un SVG válido (falta la etiqueta <svg>).",
			detected: null,
		};
	}

	if (!isImage && !isVideo && !isAudio) {
		return { valid: true };
	}

	const detected = detectMediaKind(buffer);
	if (!detected) {
		return {
			valid: false,
			reason:
				"El contenido no tiene una cabecera de imagen/video/audio válida. Probablemente sea el resultado de un error o de una generación fallida; no se guardará en la biblioteca de medios.",
			detected: null,
		};
	}

	const expectedKind = isImage ? "image" : isVideo ? "video" : "audio";
	const detectedKind = detected.split("/")[0];
	if (expectedKind !== detectedKind) {
		return {
			valid: false,
			reason: `El contenido detectado (${detected}) no coincide con el tipo declarado (${mimeType || ext}).`,
			detected,
		};
	}

	return { valid: true, detected };
}
