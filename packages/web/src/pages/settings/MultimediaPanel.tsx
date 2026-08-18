import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Select,
	StatusBadge,
	Toggle,
} from "../../components/ConfigSection.js";
import {
	ApiError,
	apiGet,
	apiPost,
	apiPutJson,
} from "../../hooks/useApi.js";

interface MediaCatalogEntry {
	provider: "openai" | "gemini" | "vertex";
	model: string;
	transport:
		| "openai-images"
		| "generate-content"
		| "interactions"
		| "video-lro";
	label: string;
	mediaType: "image" | "video";
	available: boolean;
	capabilities: string[];
	endpointFamily: string;
}

interface MediaJob {
	id: string;
	status: string;
	mediaType: string;
	provider: string;
	model?: string;
	prompt?: string;
	progress: number;
	error?: string;
}

interface MultimediaRouteConfig {
	provider: MediaCatalogEntry["provider"];
	model: string;
	transport: MediaCatalogEntry["transport"];
}

interface MultimediaModeConfig {
	enabled: boolean;
	openaiAuthMode?: "inherit" | "api-key" | "codex";
	primary: MultimediaRouteConfig;
	fallbacks: MultimediaRouteConfig[];
	pollIntervalMs?: number;
	maxPollMs?: number;
}

interface MultimediaSettingsData {
	image: MultimediaModeConfig;
	video: MultimediaModeConfig;
}

interface MultimediaSettingsResponse {
	section: "multimedia";
	revision: string;
	data: MultimediaSettingsData;
	applied?: boolean;
	warnings: string[];
}

const panelStyle: React.CSSProperties = {
	padding: "18px",
	borderRadius: "14px",
	border: "1px solid #27272a",
	background: "#09090b",
};

const mutedPanelStyle: React.CSSProperties = {
	...panelStyle,
	background: "linear-gradient(180deg, #151821 0%, #0c0e13 100%)",
};

const primaryButtonStyle: React.CSSProperties = {
	padding: "9px 14px",
	borderRadius: "10px",
	border: "1px solid #2a2a2a",
	background: "#f4f4f5",
	color: "#050505",
	fontSize: "0.85rem",
	fontWeight: 800,
	cursor: "pointer",
	fontFamily: "inherit",
};

const secondaryButtonStyle: React.CSSProperties = {
	...primaryButtonStyle,
	border: "1px solid #343a46",
	background: "transparent",
	color: "#d4d4d8",
};

const dangerButtonStyle: React.CSSProperties = {
	...primaryButtonStyle,
	border: "1px solid rgba(239, 68, 68, 0.35)",
	background: "rgba(239, 68, 68, 0.1)",
	color: "#f87171",
};

export const MultimediaPanel: React.FC<{ credentialRevision?: number }> = ({
	credentialRevision = 0,
}) => {
	const [routes, setRoutes] = useState<MediaCatalogEntry[]>([]);
	const [jobs, setJobs] = useState<MediaJob[]>([]);
	const [settings, setSettings] = useState<MultimediaSettingsData | null>(null);
	const [savedSettings, setSavedSettings] =
		useState<MultimediaSettingsData | null>(null);
	const [revision, setRevision] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [busyJobs, setBusyJobs] = useState<Set<string>>(() => new Set());
	const [error, setError] = useState<string | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [jobsError, setJobsError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const observedCredentialRevision = useRef(credentialRevision);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		void apiGet<{ routes: MediaCatalogEntry[] }>("/api/multimedia/catalog")
			.then((catalog) => {
				setRoutes(catalog.routes);
				setCatalogError(null);
			})
			.catch((loadError) => setCatalogError(errorMessage(loadError)));
		void apiGet<{ jobs: MediaJob[] }>("/api/multimedia/jobs?limit=20")
			.then((response) => {
				setJobs(response.jobs);
				setJobsError(null);
			})
			.catch((loadError) => setJobsError(errorMessage(loadError)));
		try {
			const settingsResponse = await apiGet<MultimediaSettingsResponse>(
				"/api/settings/multimedia",
			);
			setSettings(settingsResponse.data);
			setSavedSettings(settingsResponse.data);
			setRevision(settingsResponse.revision);
		} catch (loadError) {
			setError(errorMessage(loadError));
		} finally {
			setLoading(false);
		}
	}, []);

	const loadJobs = useCallback(async () => {
		try {
			const response = await apiGet<{ jobs: MediaJob[] }>(
				"/api/multimedia/jobs?limit=20",
			);
			setJobs(response.jobs);
			setJobsError(null);
		} catch (loadError) {
			setJobsError(errorMessage(loadError));
		}
	}, []);

	const loadCatalog = useCallback(async (announce = true) => {
		try {
			const response = await apiGet<{ routes: MediaCatalogEntry[] }>(
				"/api/multimedia/catalog",
			);
			setRoutes(response.routes);
			setCatalogError(null);
			if (announce) {
				setNotice("Catálogo y disponibilidad de credenciales actualizados.");
			}
		} catch (loadError) {
			setCatalogError(errorMessage(loadError));
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		if (observedCredentialRevision.current === credentialRevision) return;
		observedCredentialRevision.current = credentialRevision;
		void loadCatalog(false);
	}, [credentialRevision, loadCatalog]);

	if (loading) return <div style={mutedPanelStyle}>Cargando multimedia...</div>;
	if (error && !settings) {
		return <div style={{ ...mutedPanelStyle, color: "#f87171" }}>{error}</div>;
	}
	if (!settings) {
		return (
			<div style={mutedPanelStyle}>
				La configuración multimedia no está disponible.
			</div>
		);
	}

	const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
	const displayedRoutes = mergeConfiguredMediaRoutes(routes, settings);
	const updateMode = (
		mode: "image" | "video",
		updater: (current: MultimediaModeConfig) => MultimediaModeConfig,
	) => {
		setSettings((current) =>
			current ? { ...current, [mode]: updater(current[mode]) } : current,
		);
		setNotice(null);
	};

	const saveSettings = async () => {
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const response = (await apiPutJson("/api/settings/multimedia", {
				revision,
				data: settings,
			})) as unknown as MultimediaSettingsResponse;
			setSettings(response.data);
			setSavedSettings(response.data);
			setRevision(response.revision);
			await loadCatalog(false);
			setNotice(
				response.applied
					? "Rutas multimedia guardadas y aplicadas al runtime."
					: "Rutas multimedia guardadas.",
			);
		} catch (saveError) {
			if (saveError instanceof ApiError && saveError.status === 409) {
				try {
					const latest = await apiGet<MultimediaSettingsResponse>(
						"/api/settings/multimedia",
					);
					setSettings(
						rebaseDraft(savedSettings ?? latest.data, settings, latest.data),
					);
					setSavedSettings(latest.data);
					setRevision(latest.revision);
					setError(
						"La configuración cambió en otra sesión. Tu borrador se rebasó sobre los cambios recientes; revísalo y guarda de nuevo.",
					);
				} catch (reloadError) {
					setError(errorMessage(reloadError));
				}
			} else {
				setError(errorMessage(saveError));
			}
		} finally {
			setSaving(false);
		}
	};

	const setPrimary = (mode: "image" | "video", route: MediaCatalogEntry) => {
		const selected = routeConfig(route);
		updateMode(mode, (current) => ({
			...current,
			primary: selected,
			fallbacks: current.fallbacks.filter(
				(item) => routeKey(item) !== routeKey(selected),
			),
		}));
	};

	const toggleFallback = (
		mode: "image" | "video",
		route: MediaCatalogEntry,
	) => {
		const selected = routeConfig(route);
		updateMode(mode, (current) => {
			const key = routeKey(selected);
			const exists = current.fallbacks.some((item) => routeKey(item) === key);
			return {
				...current,
				fallbacks: exists
					? current.fallbacks.filter((item) => routeKey(item) !== key)
					: [...current.fallbacks, selected],
			};
		});
	};

	const prioritizeFallback = (
		mode: "image" | "video",
		route: MediaCatalogEntry,
	) => {
		updateMode(mode, (current) => {
			const index = current.fallbacks.findIndex(
				(item) => routeKey(item) === routeKey(route),
			);
			if (index <= 0) return current;
			const fallbacks = [...current.fallbacks];
			const previous = fallbacks[index - 1];
			const selected = fallbacks[index];
			if (!previous || !selected) return current;
			fallbacks[index - 1] = selected;
			fallbacks[index] = previous;
			return { ...current, fallbacks };
		});
	};

	const runJobAction = async (job: MediaJob, action: "retry" | "cancel") => {
		setBusyJobs((current) => new Set(current).add(job.id));
		setError(null);
		try {
			const response = await apiPost(
				`/api/multimedia/jobs/${encodeURIComponent(job.id)}/${action}`,
			);
			setNotice(
				typeof response.message === "string"
					? response.message
					: action === "retry"
						? "Trabajo reenviado."
						: "Solicitud de cancelación procesada.",
			);
			await loadJobs();
		} catch (jobError) {
			setError(jobError instanceof Error ? jobError.message : String(jobError));
		} finally {
			setBusyJobs((current) => {
				const next = new Set(current);
				next.delete(job.id);
				return next;
			});
		}
	};

	return (
		<div style={{ display: "grid", gap: 16 }}>
			{error && (
				<div role="alert" style={{ ...mutedPanelStyle, color: "#f87171" }}>
					{error}
				</div>
			)}
			{notice && (
				<div aria-live="polite" style={{ ...mutedPanelStyle, color: "#34d399" }}>
					{notice}
				</div>
			)}
			{catalogError && (
				<div role="alert" style={{ ...mutedPanelStyle, color: "#fbbf24" }}>
					Catálogo no disponible: {catalogError}
				</div>
			)}
			<div style={panelStyle}>
				<div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
					<div>
						<div style={{ color: "#f4f4f5", fontWeight: 850 }}>Routing por modalidad</div>
						<div style={{ color: "#a1a1aa", fontSize: "0.82rem", marginTop: 4 }}>
							Selecciona rutas primarias y fallbacks. Los cambios se aplican sin reiniciar.
						</div>
					</div>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						<button type="button" style={secondaryButtonStyle} onClick={() => void loadCatalog()}>
							Actualizar catálogo
						</button>
						{dirty && (
							<button type="button" style={secondaryButtonStyle} disabled={saving} onClick={() => setSettings(savedSettings)}>
								Descartar
							</button>
						)}
						<button type="button" style={primaryButtonStyle} disabled={!dirty || saving} onClick={() => void saveSettings()}>
							{saving ? "Guardando..." : dirty ? "Guardar multimedia" : "Sin cambios"}
						</button>
					</div>
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 12, marginTop: 16 }}>
					{(["image", "video"] as const).map((mode) => (
						<div key={mode} style={mutedPanelStyle}>
							<Toggle
								label={mode === "image" ? "Generación de imagen" : "Generación de video"}
								value={settings[mode].enabled}
								disabled={saving}
								onChange={(enabled) => updateMode(mode, (current) => ({ ...current, enabled }))}
							/>
							{mode === "image" && (
								<Select
									label="Autenticación OpenAI Images"
									description="Hereda OpenAI o fija la cuenta facturable para imágenes."
									value={settings.image.openaiAuthMode ?? "inherit"}
									disabled={saving}
									options={["inherit", "api-key", "codex"]}
									optionLabels={{ inherit: "Heredar de OpenAI", "api-key": "OpenAI API key", codex: "Sesión Codex" }}
									onChange={(openaiAuthMode) => updateMode("image", (current) => ({ ...current, openaiAuthMode: openaiAuthMode as "inherit" | "api-key" | "codex" }))}
								/>
							)}
							<div style={{ color: "#a1a1aa", fontSize: "0.78rem", lineHeight: 1.7 }}>
								<div>Principal: <strong style={{ color: "#e4e4e7" }}>{routeLabel(settings[mode].primary)}</strong></div>
								<div>Fallbacks: {settings[mode].fallbacks.length > 0 ? settings[mode].fallbacks.map(routeLabel).join(" → ") : "ninguno"}</div>
							</div>
						</div>
					))}
				</div>
			</div>

			<div className="settings-summary-grid">
				{displayedRoutes.map((route) => {
					const mode = route.mediaType;
					const key = routeKey(route);
					const primary = routeKey(settings[mode].primary) === key;
					const fallbackIndex = settings[mode].fallbacks.findIndex((item) => routeKey(item) === key);
					const fallback = fallbackIndex >= 0;
					const selectable = route.available || primary || fallback;
					return (
						<div key={`${key}:${mode}`} style={mutedPanelStyle}>
							<div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
								<div>
									<div style={{ color: "#f4f4f5", fontWeight: 850 }}>{route.label}</div>
									<div style={{ color: "#a1a1aa", fontSize: "0.8rem", marginTop: 4 }}>{route.endpointFamily} · {route.transport}</div>
									<div style={{ color: "#71717a", fontSize: "0.78rem", marginTop: 8 }}>{route.capabilities.join(", ")}</div>
								</div>
								<StatusBadge ok={route.available} text={route.available ? "Disponible" : "Sin credenciales"} />
							</div>
							<div style={{ marginTop: 10, color: "#d4d4d8", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.78rem" }}>{route.provider}/{route.model}</div>
							<div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
								<button type="button" style={primary ? primaryButtonStyle : secondaryButtonStyle} disabled={saving || !selectable || primary} onClick={() => setPrimary(mode, route)}>{primary ? "Principal" : "Usar como principal"}</button>
								<button type="button" style={fallback ? primaryButtonStyle : secondaryButtonStyle} disabled={saving || !selectable || primary} onClick={() => toggleFallback(mode, route)}>{fallback ? "Quitar fallback" : "Añadir fallback"}</button>
								{fallbackIndex > 0 && <button type="button" style={secondaryButtonStyle} disabled={saving} onClick={() => prioritizeFallback(mode, route)}>Subir prioridad</button>}
							</div>
						</div>
					);
				})}
			</div>

			<div style={panelStyle}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}>
					<div>
						<div style={{ color: "#f4f4f5", fontWeight: 850 }}>Trabajos multimedia persistentes</div>
						<div style={{ color: "#a1a1aa", fontSize: "0.82rem", marginTop: 4 }}>La cola es real y durable; esta pantalla no dispara generaciones facturables.</div>
					</div>
					<button type="button" style={secondaryButtonStyle} onClick={() => void loadJobs()}>Actualizar</button>
				</div>
				{jobsError && (
					<div role="alert" style={{ ...mutedPanelStyle, color: "#fbbf24", marginBottom: 10 }}>
						Jobs no disponibles: {jobsError}
					</div>
				)}
				{jobs.length === 0 ? (
					<div style={mutedPanelStyle}>No hay trabajos multimedia registrados.</div>
				) : (
					<div style={{ display: "grid", gap: 10 }}>
						{jobs.map((job) => (
							<div key={job.id} style={mutedPanelStyle}>
								<div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
									<strong style={{ color: "#f4f4f5" }}>{job.mediaType} · {job.provider}/{job.model ?? "default"}</strong>
									<span style={{ color: "#a1a1aa" }}>{job.status}</span>
								</div>
								<div style={{ color: "#71717a", fontSize: "0.78rem", marginTop: 6 }}>{job.id}</div>
								<div style={{ height: 4, background: "#27272a", borderRadius: 999, marginTop: 10, overflow: "hidden" }}>
									<div style={{ width: `${Math.round((job.progress ?? 0) * 100)}%`, height: "100%", background: "#6366f1" }} />
								</div>
								{job.prompt && <div style={{ color: "#d4d4d8", fontSize: "0.84rem", marginTop: 8 }}>{job.prompt}</div>}
								{job.error && <div style={{ color: "#f87171", fontSize: "0.84rem", marginTop: 8 }}>{job.error}</div>}
								{["queued", "submitting", "running"].includes(job.status) && <button type="button" style={{ ...dangerButtonStyle, marginTop: 10 }} disabled={busyJobs.has(job.id)} onClick={() => void runJobAction(job, "cancel")}>Cancelar</button>}
								{["failed", "cancelled"].includes(job.status) && <button type="button" style={{ ...secondaryButtonStyle, marginTop: 10 }} disabled={busyJobs.has(job.id)} onClick={() => void runJobAction(job, "retry")}>Reintentar</button>}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
};

function routeConfig(route: MediaCatalogEntry): MultimediaRouteConfig {
	return { provider: route.provider, model: route.model, transport: route.transport };
}

function routeKey(route: MultimediaRouteConfig): string {
	return `${route.provider}:${route.model}:${route.transport}`;
}

function routeLabel(route: MultimediaRouteConfig): string {
	return `${route.provider}/${route.model}`;
}

function mergeConfiguredMediaRoutes(
	catalog: MediaCatalogEntry[],
	settings: MultimediaSettingsData,
): MediaCatalogEntry[] {
	const merged = [...catalog];
	for (const mediaType of ["image", "video"] as const) {
		for (const route of [settings[mediaType].primary, ...settings[mediaType].fallbacks]) {
			if (merged.some((entry) => entry.mediaType === mediaType && routeKey(entry) === routeKey(route))) continue;
			const compatible = catalog.find((entry) => entry.mediaType === mediaType && entry.provider === route.provider && entry.transport === route.transport);
			merged.push({
				...route,
				label: `${route.model} (ruta configurada)`,
				mediaType,
				available: compatible?.available ?? false,
				capabilities: compatible?.capabilities ?? ["ruta personalizada"],
				endpointFamily: compatible?.endpointFamily ?? (route.provider === "openai" ? "openai" : route.provider === "gemini" ? "gemini-api" : "google-agent-platform"),
			});
		}
	}
	return merged;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rebaseDraft<T>(base: T, draft: T, latest: T): T {
	if (JSON.stringify(base) === JSON.stringify(draft)) return latest;
	if (
		Array.isArray(draft) ||
		draft === null ||
		typeof draft !== "object" ||
		base === null ||
		typeof base !== "object" ||
		latest === null ||
		typeof latest !== "object"
	) {
		return draft;
	}
	const result: Record<string, unknown> = {
		...(latest as Record<string, unknown>),
	};
	for (const [key, draftValue] of Object.entries(
		draft as Record<string, unknown>,
	)) {
		result[key] = rebaseDraft(
			(base as Record<string, unknown>)[key],
			draftValue,
			(latest as Record<string, unknown>)[key],
		);
	}
	return result as T;
}

export default MultimediaPanel;
