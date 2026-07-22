import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	ArtifactViewer,
	type Artifact,
	type ArtifactVersion,
} from "../components/artifacts/ArtifactViewer.js";
import { AppIcon, type AppIconName } from "../components/ui/AppIcon.js";
import { showToast } from "../components/ui/Toast.js";
import { API_BASE, apiDelete, apiGet } from "../hooks/useApi.js";

const SKELETONS = ["artifact-1", "artifact-2", "artifact-3", "artifact-4", "artifact-5", "artifact-6"];
const PAGE_SIZE = 24;

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function currentVersion(artifact: Artifact): ArtifactVersion | undefined {
	return artifact.versions.find((version) => version.id === artifact.currentVersionId) ?? artifact.versions[0];
}

function placeholderIcon(kind: Artifact["kind"]): AppIconName {
	if (kind === "video") return "video";
	if (kind === "audio") return "music";
	if (kind === "image") return "image";
	return "file";
}

export const MediaLibraryPage: React.FC = () => {
	const [artifacts, setArtifacts] = useState<Artifact[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const [filter, setFilter] = useState<"all" | "image" | "video" | "audio" | "document">("all");
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const dialogRef = useRef<HTMLDialogElement | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const data = await apiGet<Artifact[]>("/api/artifacts");
			setArtifacts(Array.isArray(data) ? data : []);
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : "Error al cargar artifacts");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (!selectedKey) return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		if (!dialog.open) dialog.showModal();
		return () => {
			document.body.style.overflow = overflow;
			if (dialog.open) dialog.close();
		};
	}, [selectedKey]);

	const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const files = event.target.files;
		if (!files?.length) return;
		setUploading(true);
		for (const file of Array.from(files)) {
			try {
				const body = new FormData();
				body.append("file", file);
				const response = await fetch(`${API_BASE}/api/media/upload`, { method: "POST", body });
				if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Upload failed");
				showToast("success", `${file.name} subido`);
			} catch (uploadError) {
				showToast("error", uploadError instanceof Error ? uploadError.message : `Error subiendo ${file.name}`);
			}
		}
		setUploading(false);
		event.target.value = "";
		await load();
	};

	const removeCurrentVersion = async (artifact: Artifact) => {
		const version = currentVersion(artifact);
		if (!version) return;
		if (deleteConfirm !== version.id) {
			setDeleteConfirm(version.id);
			return;
		}
		try {
			await apiDelete(`/api/media/${version.id}`);
			setDeleteConfirm(null);
			setSelectedKey(null);
			showToast("success", `${version.filename} eliminado`);
			await load();
		} catch {
			showToast("error", "No se pudo eliminar el artifact");
		}
	};

	const selected = artifacts.find((artifact) => artifact.key === selectedKey);
	const filtered = artifacts.filter((artifact) => {
		if (filter === "all") return true;
		if (filter === "document") return !["image", "video", "audio"].includes(artifact.kind);
		return artifact.kind === filter;
	});
	const visible = filtered.slice(0, visibleCount);

	return (
		<div className="page-shell">
			<div className="animate-fade-in" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
				<div>
					<h1 style={{ margin: "0 0 6px", color: "#f4f4f5", fontSize: "1.6rem", fontWeight: 750, letterSpacing: "-.02em" }}>Biblioteca de medios</h1>
					<p style={{ margin: 0, color: "#a1a1aa", fontSize: ".95rem" }}>Imágenes, vídeos, audio y documentos con versiones, vistas previas y anotaciones</p>
				</div>
				<label style={{ padding: "10px 18px", borderRadius: 10, background: uploading ? "#27272a" : "#4f46e5", color: uploading ? "#71717a" : "white", fontSize: 13, fontWeight: 700, cursor: uploading ? "wait" : "pointer" }}>
					{uploading ? "Subiendo..." : "Subir archivos"}
					<input type="file" name="artifact-upload" multiple disabled={uploading} onChange={upload} accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.ods,.odt,.odp,.csv,.tsv,.json,.txt,.md,.html,.xml,.yaml,.yml,.py,.js,.ts,.sql,.sqlite,.db" style={{ display: "none" }} />
				</label>
			</div>

			{artifacts.length > 0 && (
				<div className="toolbar-wrap" style={{ marginBottom: 18 }}>
					{(["all", "image", "video", "audio", "document"] as const).map((value) => (
						<button key={value} type="button" onClick={() => { setFilter(value); setVisibleCount(PAGE_SIZE); }} style={{ padding: "8px 12px", borderRadius: 999, border: `1px solid ${filter === value ? "#6366f1" : "#27272a"}`, background: filter === value ? "rgba(99,102,241,.16)" : "#18181b", color: filter === value ? "#a5b4fc" : "#a1a1aa", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
							{value === "all" ? "Todos" : value === "document" ? "Documentos" : value === "image" ? "Imágenes" : value === "video" ? "Vídeos" : "Audio"}
						</button>
					))}
				</div>
			)}

			{error ? (
				<div style={{ padding: 32, border: "1px solid rgba(239,68,68,.3)", borderRadius: 14, color: "#fca5a5", textAlign: "center" }}>{error}<br /><button type="button" onClick={() => void load()} style={{ marginTop: 12 }}>Reintentar</button></div>
			) : loading ? (
				<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 16 }}>{SKELETONS.map((key) => <div key={key} className="skeleton" style={{ height: 220, borderRadius: 14 }} />)}</div>
			) : artifacts.length === 0 ? (
				<div style={{ padding: "70px 20px", textAlign: "center", color: "#71717a", border: "1px dashed #27272a", borderRadius: 16 }}><AppIcon name="folder" size={54} /><div style={{ marginTop: 14, color: "#a1a1aa", fontWeight: 700 }}>Aún no hay artifacts</div></div>
			) : filtered.length === 0 ? (
				<div style={{ padding: 48, textAlign: "center", color: "#71717a" }}>No hay artifacts para este filtro.</div>
			) : (
				<>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 16 }}>
					{visible.map((artifact) => {
						const version = currentVersion(artifact);
						if (!version) return null;
						return (
							<button key={artifact.key} type="button" className="hover-lift" onClick={() => setSelectedKey(artifact.key)} style={{ padding: 0, textAlign: "left", borderRadius: 14, background: "rgba(24,24,27,.7)", border: "1px solid #27272a", overflow: "hidden", cursor: "pointer" }}>
								<div style={{ height: 145, display: "grid", placeItems: "center", background: "#111113", overflow: "hidden", position: "relative" }}>
									{artifact.kind === "image" ? <img src={absoluteUrl(version.url)} alt={artifact.title} loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "#71717a" }}><AppIcon name={placeholderIcon(artifact.kind)} size={48} strokeWidth={1.35} /></span>}
									{artifact.versions.length > 1 && <span style={{ position: "absolute", top: 9, right: 9, padding: "4px 7px", borderRadius: 999, background: "rgba(9,9,11,.85)", color: "#c7d2fe", fontSize: 10, fontWeight: 800 }}>{artifact.versions.length} versiones</span>}
								</div>
								<div style={{ padding: 12 }}>
									<div style={{ color: "#f4f4f5", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{artifact.title}</div>
									<div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 6, color: "#a1a1aa", fontSize: 11 }}><span>{formatSize(version.size)} · {artifact.kind.toUpperCase()}</span>{artifact.annotationCount > 0 && <span>{artifact.annotationCount} notas</span>}</div>
								</div>
							</button>
						);
					})}
				</div>
					{visible.length < filtered.length && (
						<div style={{ display: "grid", placeItems: "center", gap: 8, marginTop: 22 }}>
							<button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)} style={{ padding: "10px 18px", border: "1px solid #3f3f46", borderRadius: 10, background: "#18181b", color: "#e4e4e7", fontWeight: 700, cursor: "pointer" }}>Cargar más</button>
							<span style={{ color: "#71717a", fontSize: 12 }}>Mostrando {visible.length} de {filtered.length}</span>
						</div>
					)}
				</>
			)}

			{selected && createPortal(
				<dialog ref={dialogRef} aria-modal="true" aria-label="Visor de artifact" onCancel={(event) => { event.preventDefault(); setSelectedKey(null); }} onKeyDown={(event) => { if (event.key === "Escape") setSelectedKey(null); }} onClick={(event) => { if (event.target === event.currentTarget) setSelectedKey(null); }} style={{ position: "fixed", inset: 0, width: "100vw", height: "100dvh", maxWidth: "none", maxHeight: "none", boxSizing: "border-box", margin: 0, padding: 16, border: 0, background: "rgba(0,0,0,.82)", backdropFilter: "blur(5px)", display: "grid", placeItems: "center", zIndex: 10000 }}>
					<div className="artifact-viewer-shell" style={{ position: "relative" }}>
						<ArtifactViewer artifact={selected} onClose={() => setSelectedKey(null)} />
						<button type="button" className="artifact-delete-button" onClick={() => void removeCurrentVersion(selected)} style={{ position: "absolute", bottom: 14, left: 14, padding: "7px 10px", border: "1px solid rgba(239,68,68,.35)", borderRadius: 8, background: "rgba(127,29,29,.25)", color: "#fca5a5", cursor: "pointer", zIndex: 2 }}>{deleteConfirm === currentVersion(selected)?.id ? "Confirmar eliminación" : "Eliminar versión actual"}</button>
					</div>
				</dialog>,
				document.body,
			)}
		</div>
	);
};

function absoluteUrl(url: string): string {
	return url.startsWith("http") ? url : `${API_BASE}${url}`;
}
