import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiGet, apiPost } from "../../hooks/useApi.js";
import { AppIcon } from "../ui/AppIcon.js";

export interface ArtifactVersion {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	createdAt: string;
	description?: string;
	url: string;
}

export interface Artifact {
	key: string;
	title: string;
	kind: "image" | "pdf" | "office" | "audio" | "video" | "document";
	currentVersionId: string;
	versions: ArtifactVersion[];
	annotationCount: number;
}

interface Annotation {
	id: string;
	versionId: string;
	body: string;
	pageNumber?: number | null;
	createdAt: string;
}

interface ArtifactViewerProps {
	artifact: Artifact;
	onClose: () => void;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function absoluteUrl(url: string): string {
	return url.startsWith("http") ? url : `${API_BASE}${url}`;
}

export const ArtifactViewer: React.FC<ArtifactViewerProps> = ({ artifact, onClose }) => {
	const [versionId, setVersionId] = useState(artifact.currentVersionId);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const [annotationBody, setAnnotationBody] = useState("");
	const [pageNumber, setPageNumber] = useState("");
	const [saving, setSaving] = useState(false);
	const version = useMemo(
		() => artifact.versions.find((item) => item.id === versionId) ?? artifact.versions[0],
		[artifact.versions, versionId],
	);

	const loadAnnotations = useCallback(async () => {
		if (!version) return;
		try {
			const rows = await apiGet<Annotation[]>(
				`/api/artifacts/${encodeURIComponent(artifact.key)}/annotations?versionId=${encodeURIComponent(version.id)}`,
			);
			setAnnotations(Array.isArray(rows) ? rows : []);
		} catch {
			setAnnotations([]);
		}
	}, [artifact.key, version]);

	useEffect(() => {
		if (!version) return;
		setPreviewError(null);
		void loadAnnotations();
		if (artifact.kind === "office") {
			setPreviewLoading(true);
			setPreviewUrl(null);
			void apiPost(`/api/artifacts/${encodeURIComponent(artifact.key)}/preview`, {
				versionId: version.id,
			})
				.then((result) => {
					const url = typeof result.url === "string" ? result.url : "";
					if (!url) throw new Error("El servidor no devolvió una vista previa");
					setPreviewUrl(absoluteUrl(url));
				})
				.catch((error) => setPreviewError(error instanceof Error ? error.message : String(error)))
				.finally(() => setPreviewLoading(false));
		} else {
			setPreviewUrl(absoluteUrl(version.url));
			setPreviewLoading(false);
		}
	}, [artifact.key, artifact.kind, loadAnnotations, version]);

	const saveAnnotation = async () => {
		if (!version || !annotationBody.trim()) return;
		setSaving(true);
		try {
			await apiPost(`/api/artifacts/${encodeURIComponent(artifact.key)}/annotations`, {
				versionId: version.id,
				body: annotationBody.trim(),
				pageNumber: pageNumber ? Number(pageNumber) : undefined,
			});
			setAnnotationBody("");
			setPageNumber("");
			await loadAnnotations();
		} finally {
			setSaving(false);
		}
	};

	if (!version) return null;
	return (
		<div className="artifact-viewer" style={{ width: "min(1240px, 96vw)", height: "min(860px, 92vh)", display: "grid", gridTemplateRows: "auto 1fr", background: "#09090b", border: "1px solid #27272a", borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,.55)" }}>
			<header style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: "1px solid #27272a", background: "#111113" }}>
				<div style={{ minWidth: 0, flex: 1 }}>
					<div style={{ color: "#f4f4f5", fontWeight: 750, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artifact.title}</div>
					<div style={{ color: "#71717a", fontSize: 12, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{formatSize(version.size)} · {version.mimetype} · {new Date(version.createdAt).toLocaleString()}</div>
				</div>
				{artifact.versions.length > 1 && (
					<select value={version.id} onChange={(event) => setVersionId(event.target.value)} style={{ background: "#18181b", color: "#e4e4e7", border: "1px solid #3f3f46", borderRadius: 8, padding: "7px 10px" }}>
						{artifact.versions.map((item, index) => <option key={item.id} value={item.id}>Versión {artifact.versions.length - index} · {new Date(item.createdAt).toLocaleDateString()}</option>)}
					</select>
				)}
				<a href={absoluteUrl(version.url)} download={version.filename} style={{ color: "#a5b4fc", textDecoration: "none", padding: "7px 10px", border: "1px solid #3f3f46", borderRadius: 8 }}>Descargar</a>
				<button type="button" onClick={onClose} aria-label="Cerrar visor" style={{ width: 34, height: 34, display: "grid", placeItems: "center", border: 0, borderRadius: 8, background: "#27272a", color: "#d4d4d8", cursor: "pointer", fontSize: 20 }}>×</button>
			</header>
			<div className="artifact-viewer-body" style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 310px" }}>
				<section style={{ minWidth: 0, minHeight: 0, display: "grid", placeItems: "center", background: "#050506", overflow: "hidden" }}>
					{previewLoading ? <div style={{ color: "#a1a1aa" }}>Generando vista previa validada...</div> : previewError ? (
						<div style={{ maxWidth: 520, padding: 24, textAlign: "center", color: "#fca5a5" }}><AppIcon name="warning" size={32} /><div style={{ marginTop: 12 }}>{previewError}</div><a href={absoluteUrl(version.url)} download={version.filename} style={{ display: "inline-block", marginTop: 16, color: "#a5b4fc" }}>Descargar original</a></div>
					) : previewUrl && (artifact.kind === "pdf" || artifact.kind === "office") ? (
						<iframe title={`Vista previa de ${version.filename}`} src={previewUrl} style={{ width: "100%", height: "100%", border: 0, background: "white" }} />
					) : previewUrl && artifact.kind === "image" ? (
						<img src={previewUrl} alt={version.filename} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
					) : previewUrl && artifact.kind === "video" ? (
						<video src={previewUrl} controls style={{ maxWidth: "100%", maxHeight: "100%" }}><track kind="captions" label="Sin subtítulos" /></video>
					) : previewUrl && artifact.kind === "audio" ? (
						<audio src={previewUrl} controls><track kind="captions" label="Sin subtítulos" /></audio>
					) : (
						<div style={{ textAlign: "center", color: "#a1a1aa" }}><AppIcon name="file" size={48} /><div style={{ marginTop: 12 }}>Este formato se revisa descargándolo o con las tools de inspección.</div></div>
					)}
				</section>
				<aside style={{ minHeight: 0, borderLeft: "1px solid #27272a", background: "#111113", display: "grid", gridTemplateRows: "auto 1fr auto" }}>
					<div style={{ padding: 14, borderBottom: "1px solid #27272a", color: "#e4e4e7", fontWeight: 700 }}>Anotaciones · {annotations.length}</div>
					<div style={{ overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
						{annotations.length === 0 ? <div style={{ color: "#71717a", fontSize: 13, padding: 8 }}>Aún no hay observaciones para esta versión.</div> : annotations.map((annotation) => (
							<div key={annotation.id} style={{ padding: 11, border: "1px solid #27272a", borderRadius: 10, background: "#18181b" }}>
								{annotation.pageNumber ? <div style={{ color: "#818cf8", fontSize: 11, fontWeight: 700, marginBottom: 5 }}>Página/slide {annotation.pageNumber}</div> : null}
								<div style={{ color: "#d4d4d8", fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{annotation.body}</div>
								<div style={{ color: "#52525b", fontSize: 10, marginTop: 7 }}>{new Date(annotation.createdAt).toLocaleString()}</div>
							</div>
						))}
					</div>
					<div style={{ padding: 12, borderTop: "1px solid #27272a", display: "grid", gap: 8 }}>
						<input name="artifact-page-number" value={pageNumber} onChange={(event) => setPageNumber(event.target.value.replace(/\D/g, ""))} placeholder="Página o slide (opcional)" style={{ background: "#09090b", color: "#e4e4e7", border: "1px solid #3f3f46", borderRadius: 8, padding: "8px 10px" }} />
						<textarea name="artifact-annotation" value={annotationBody} onChange={(event) => setAnnotationBody(event.target.value)} placeholder="Describe el cambio exacto..." rows={3} style={{ resize: "vertical", background: "#09090b", color: "#e4e4e7", border: "1px solid #3f3f46", borderRadius: 8, padding: "9px 10px", fontFamily: "inherit" }} />
						<button type="button" disabled={saving || !annotationBody.trim()} onClick={() => void saveAnnotation()} style={{ padding: "9px 12px", border: 0, borderRadius: 8, background: saving || !annotationBody.trim() ? "#27272a" : "#4f46e5", color: "white", fontWeight: 700, cursor: saving ? "wait" : "pointer" }}>{saving ? "Guardando..." : "Añadir anotación"}</button>
					</div>
				</aside>
			</div>
		</div>
	);
};
