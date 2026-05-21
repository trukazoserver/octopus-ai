import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppIcon, type AppIconName } from "../components/ui/AppIcon.js";
import { showToast } from "../components/ui/Toast.js";
import { API_BASE, apiDelete, apiGet } from "../hooks/useApi.js";

const MEDIA_SKELETON_KEYS = [
	"media-1",
	"media-2",
	"media-3",
	"media-4",
	"media-5",
	"media-6",
];

interface MediaItem {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	createdAt: string;
	description?: string;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mime: string): boolean {
	return mime.startsWith("image/");
}

function isVideo(mime: string): boolean {
	return mime.startsWith("video/");
}

function isAudio(mime: string): boolean {
	return mime.startsWith("audio/");
}

function mediaCreatedAtMs(item: MediaItem): number {
	const time = Date.parse(item.createdAt);
	return Number.isFinite(time) ? time : 0;
}

function sortMediaNewestFirst(items: MediaItem[]): MediaItem[] {
	return [...items].sort((a, b) => mediaCreatedAtMs(b) - mediaCreatedAtMs(a));
}

function mediaPlaceholderIcon(mime: string): AppIconName {
	if (isVideo(mime)) return "video";
	if (isAudio(mime)) return "music";
	return "file";
}

export const MediaLibraryPage: React.FC = () => {
	const [items, setItems] = useState<MediaItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const [preview, setPreview] = useState<string | null>(null);
	const [typeFilter, setTypeFilter] = useState<
		"all" | "image" | "video" | "audio" | "document"
	>("all");
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const previewDialogRef = useRef<HTMLDialogElement | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const data = await apiGet<MediaItem[]>("/api/media");
			setItems(Array.isArray(data) ? sortMediaNewestFirst(data) : []);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error al cargar medios");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		if (!preview) return;
		const dialog = previewDialogRef.current;
		if (!dialog) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		try {
			if (!dialog.open) dialog.showModal();
		} catch {
			dialog.setAttribute("open", "");
		}
		dialog.focus();

		return () => {
			document.body.style.overflow = previousOverflow;
			if (dialog.open) dialog.close();
		};
	}, [preview]);

	const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files || files.length === 0) return;
		setUploading(true);
		for (const file of Array.from(files)) {
			try {
				const form = new FormData();
				form.append("file", file);
				const res = await fetch(`${API_BASE}/api/media/upload`, {
					method: "POST",
					body: form,
				});
				if (!res.ok) throw new Error("Upload failed");
				showToast("success", `${file.name} subido`);
			} catch (err) {
				showToast("error", `Error subiendo ${file.name}`);
			}
		}
		setUploading(false);
		await load();
		e.target.value = "";
	};

	const handleDelete = async (id: string, filename: string) => {
		if (deleteConfirm !== id) {
			setDeleteConfirm(id);
			return;
		}
		try {
			await apiDelete(`/api/media/${id}`);
			showToast("success", `${filename} eliminado`);
			setDeleteConfirm(null);
			setPreview((current) => (current === id ? null : current));
			await load();
		} catch (err) {
			showToast("error", "Error al eliminar");
		}
	};

	const mediaUrl = (id: string) => `${API_BASE}/api/media/file/${id}`;
	const handleCopyUrl = async (id: string) => {
		try {
			if (!navigator.clipboard) {
				throw new Error("El portapapeles no está disponible en este contexto");
			}
			await navigator.clipboard.writeText(mediaUrl(id));
			showToast("success", "URL copiada");
		} catch (err) {
			showToast(
				"error",
				err instanceof Error ? err.message : "No se pudo copiar la URL",
			);
		}
	};
	const filteredItems = items.filter((item) => {
		if (typeFilter === "all") return true;
		if (typeFilter === "image") return isImage(item.mimetype);
		if (typeFilter === "video") return isVideo(item.mimetype);
		if (typeFilter === "audio") return isAudio(item.mimetype);
		return (
			!isImage(item.mimetype) &&
			!isVideo(item.mimetype) &&
			!isAudio(item.mimetype)
		);
	});

	return (
		<div className="page-shell">
			<div
				className="animate-fade-in"
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "flex-start",
					marginBottom: "24px",
					flexWrap: "wrap",
					gap: "16px",
				}}
			>
				<div>
					<h1
						style={{
							fontSize: "1.6rem",
							fontWeight: 700,
							color: "#f4f4f5",
							margin: "0 0 6px",
							letterSpacing: "-0.02em",
						}}
					>
						Biblioteca de Medios
					</h1>
					<p style={{ fontSize: "0.95rem", color: "#a1a1aa", margin: 0 }}>
						Archivos multimedia generados por el agente
					</p>
				</div>
				<label
					style={{
						padding: "10px 20px",
						borderRadius: "10px",
						border: "none",
						background: uploading ? "#27272a" : "#6366f1",
						color: uploading ? "#52525b" : "#fff",
						fontSize: "0.85rem",
						fontWeight: 600,
						cursor: uploading ? "not-allowed" : "pointer",
						fontFamily: "inherit",
						transition: "all 0.15s",
						display: "inline-flex",
						alignItems: "center",
						gap: "8px",
					}}
				>
					{uploading ? "Subiendo..." : "↑ Subir archivo"}
					<input
						id="media-upload"
						name="mediaUpload"
						type="file"
						multiple
						onChange={handleUpload}
						disabled={uploading}
						accept="image/*,video/*,audio/*,.pdf,.json,.csv,.txt"
						style={{ display: "none" }}
					/>
				</label>
			</div>

			{!loading && !error && items.length > 0 && (
				<div className="toolbar-wrap" style={{ marginBottom: "18px" }}>
					{(["all", "image", "video", "audio", "document"] as const).map(
						(filter) => (
							<button
								key={filter}
								type="button"
								onClick={() => setTypeFilter(filter)}
								style={{
									padding: "8px 12px",
									borderRadius: "999px",
									border: `1px solid ${typeFilter === filter ? "#6366f1" : "#27272a"}`,
									background:
										typeFilter === filter ? "rgba(99,102,241,0.16)" : "#18181b",
									color: typeFilter === filter ? "#a5b4fc" : "#a1a1aa",
									fontSize: "0.8rem",
									fontWeight: 700,
									cursor: "pointer",
								}}
							>
								{filter === "all"
									? "Todos"
									: filter === "image"
										? "Imágenes"
										: filter === "video"
											? "Videos"
											: filter === "audio"
												? "Audio"
												: "Documentos"}
							</button>
						),
					)}
				</div>
			)}

			{error ? (
				<div
					style={{
						padding: "32px",
						borderRadius: "16px",
						border: "1px solid rgba(239,68,68,0.25)",
						background: "rgba(239,68,68,0.08)",
						color: "#fca5a5",
						textAlign: "center",
					}}
				>
					<div style={{ fontWeight: 700, marginBottom: 8 }}>
						No se pudo cargar la biblioteca
					</div>
					<div style={{ fontSize: "0.85rem", marginBottom: 14 }}>{error}</div>
					<button
						type="button"
						onClick={load}
						style={{
							padding: "8px 14px",
							borderRadius: 8,
							border: "1px solid #ef4444",
							background: "transparent",
							color: "#fca5a5",
							cursor: "pointer",
						}}
					>
						Reintentar
					</button>
				</div>
			) : loading ? (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
						gap: "16px",
					}}
				>
					{MEDIA_SKELETON_KEYS.map((key) => (
						<div
							key={key}
							className="skeleton"
							style={{ height: "200px", borderRadius: "12px" }}
						/>
					))}
				</div>
			) : items.length === 0 ? (
				<div
					style={{
						textAlign: "center",
						padding: "64px 20px",
						color: "#52525b",
					}}
				>
					<div
						style={{
							display: "flex",
							justifyContent: "center",
							marginBottom: "16px",
						}}
					>
						<AppIcon name="folder" size={56} strokeWidth={1.35} />
					</div>
					<div
						style={{
							fontSize: "1.1rem",
							fontWeight: 600,
							color: "#71717a",
							marginBottom: "8px",
						}}
					>
						Sin archivos multimedia
					</div>
					<div style={{ fontSize: "0.85rem", marginBottom: "16px" }}>
						Los archivos que el agente genere aparecerán aquí. También puedes
						subir tus propios recursos.
					</div>
					<label
						style={{
							display: "inline-flex",
							padding: "10px 18px",
							borderRadius: "10px",
							background: "#6366f1",
							color: "#fff",
							cursor: "pointer",
							fontWeight: 700,
						}}
					>
						Subir primer archivo
						<input
							id="media-empty-upload"
							name="mediaUpload"
							type="file"
							multiple
							onChange={handleUpload}
							accept="image/*,video/*,audio/*,.pdf,.json,.csv,.txt"
							style={{ display: "none" }}
						/>
					</label>
				</div>
			) : filteredItems.length === 0 ? (
				<div
					style={{
						padding: "48px 20px",
						borderRadius: "16px",
						border: "1px dashed #27272a",
						textAlign: "center",
						color: "#a1a1aa",
					}}
				>
					No hay archivos para este filtro.
				</div>
			) : (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
						gap: "16px",
					}}
				>
					{filteredItems.map((item) => (
						<button
							key={item.id}
							type="button"
							className="hover-lift"
							style={{
								padding: 0,
								textAlign: "left",
								borderRadius: "14px",
								background: "rgba(24,24,27,0.6)",
								border: "1px solid #27272a",
								overflow: "hidden",
								transition: "all 0.2s",
								cursor: "pointer",
							}}
							onClick={() => setPreview(item.id)}
						>
							<div
								style={{
									height: "140px",
									background: "#18181b",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									overflow: "hidden",
								}}
							>
								{isImage(item.mimetype) ? (
									<img
										src={mediaUrl(item.id)}
										alt={item.filename}
										style={{
											width: "100%",
											height: "100%",
											objectFit: "cover",
										}}
									/>
								) : (
									<span style={{ color: "#71717a" }}>
										<AppIcon
											name={mediaPlaceholderIcon(item.mimetype)}
											size={48}
											strokeWidth={1.35}
										/>
									</span>
								)}
							</div>
							<div style={{ padding: "12px" }}>
								<div
									style={{
										fontSize: "0.85rem",
										fontWeight: 600,
										color: "#f4f4f5",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
									}}
								>
									{item.filename}
								</div>
								<div
									style={{
										fontSize: "0.7rem",
										color: "#71717a",
										marginTop: "4px",
									}}
								>
									{formatSize(item.size)} ·{" "}
									{item.mimetype.split("/")[1]?.toUpperCase()}
								</div>
							</div>
						</button>
					))}
				</div>
			)}

			{/* Preview modal */}
			{preview &&
				createPortal(
					<dialog
						ref={previewDialogRef}
						aria-modal="true"
						aria-label="Vista previa de archivo"
						tabIndex={-1}
						style={{
							position: "fixed",
							inset: 0,
							width: "100vw",
							height: "100dvh",
							maxWidth: "none",
							maxHeight: "none",
							zIndex: 10000,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							background: "rgba(0,0,0,0.8)",
							backdropFilter: "blur(4px)",
							animation: "fadeInFast 0.15s ease-out",
							border: 0,
							boxSizing: "border-box",
							margin: 0,
							padding: "24px",
						}}
						onClick={(event) => {
							if (event.target === event.currentTarget) setPreview(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") setPreview(null);
						}}
						onCancel={(event) => {
							event.preventDefault();
							setPreview(null);
						}}
					>
						<div
							style={{
								position: "relative",
								maxWidth: "90vw",
								maxHeight: "90vh",
							}}
						>
							{(() => {
								const item = items.find((i) => i.id === preview);
								if (!item) return null;
								return (
									<div style={{ textAlign: "center" }}>
										{isImage(item.mimetype) ? (
											<img
												src={mediaUrl(item.id)}
												alt={item.filename}
												style={{
													maxWidth: "90vw",
													maxHeight: "80vh",
													borderRadius: "12px",
												}}
											/>
										) : isVideo(item.mimetype) ? (
											<video
												src={mediaUrl(item.id)}
												controls
												style={{
													maxWidth: "90vw",
													maxHeight: "80vh",
													borderRadius: "12px",
												}}
											>
												<track kind="captions" label="Sin subtitulos" />
											</video>
										) : isAudio(item.mimetype) ? (
											<audio
												src={mediaUrl(item.id)}
												controls
												style={{ width: "min(400px, 88vw)" }}
											>
												<track kind="captions" label="Sin subtitulos" />
											</audio>
										) : (
											<div style={{ padding: "40px", color: "#a1a1aa" }}>
												<a
													href={mediaUrl(item.id)}
													download={item.filename}
													style={{
														color: "#818cf8",
														textDecoration: "underline",
														fontSize: "1.1rem",
													}}
												>
													Descargar {item.filename}
												</a>
											</div>
										)}
										<div
											style={{
												marginTop: "12px",
												display: "flex",
												justifyContent: "center",
												gap: "12px",
											}}
										>
											<span style={{ color: "#f4f4f5", fontSize: "0.9rem" }}>
												{item.filename}
											</span>
											<span style={{ color: "#71717a", fontSize: "0.85rem" }}>
												{formatSize(item.size)}
											</span>
											<button
												type="button"
												onClick={() =>
													void handleDelete(item.id, item.filename)
												}
												style={{
													padding: "4px 12px",
													borderRadius: "6px",
													border: "1px solid rgba(239,68,68,0.3)",
													background: "rgba(239,68,68,0.1)",
													color: "#ef4444",
													fontSize: "0.75rem",
													cursor: "pointer",
												}}
											>
												{deleteConfirm === item.id ? "Confirmar" : "Eliminar"}
											</button>
											<a
												href={mediaUrl(item.id)}
												download={item.filename}
												style={{
													padding: "4px 12px",
													borderRadius: "6px",
													border: "1px solid #3f3f46",
													color: "#a5b4fc",
													fontSize: "0.75rem",
													textDecoration: "none",
												}}
											>
												Descargar
											</a>
											<button
												type="button"
												onClick={() => void handleCopyUrl(item.id)}
												style={{
													padding: "4px 12px",
													borderRadius: "6px",
													border: "1px solid #3f3f46",
													background: "#18181b",
													color: "#a1a1aa",
													fontSize: "0.75rem",
													cursor: "pointer",
												}}
											>
												Copiar URL
											</button>
										</div>
									</div>
								);
							})()}
							<button
								type="button"
								aria-label="Cerrar vista previa"
								onClick={() => setPreview(null)}
								style={{
									position: "absolute",
									top: "-40px",
									right: 0,
									background: "none",
									border: "none",
									color: "#a1a1aa",
									fontSize: "1.5rem",
									cursor: "pointer",
								}}
							>
								✕
							</button>
						</div>
					</dialog>,
					document.body,
				)}
		</div>
	);
};
