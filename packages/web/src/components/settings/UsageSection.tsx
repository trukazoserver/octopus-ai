import { useCallback, useEffect, useState } from "react";
import { apiDownload, apiGet } from "../../hooks/useApi.js";

interface UsageTotal {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalCost: number;
	requests: number;
	unknownCostEvents: number;
	estimatedCostEvents: number;
}

interface ProviderRow {
	provider: string;
	tokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	cost: number;
	requests: number;
	unknownCostEvents: number;
	estimatedCostEvents: number;
}

interface MediaUsageTotal {
	requests: number;
	outputs: number;
	requestedOutputs: number;
	generatedDurationSeconds: number;
	requestedDurationSeconds: number;
	knownCost: number;
	unknownCostEvents: number;
}

interface MediaProviderRow extends MediaUsageTotal {
	provider: string;
}

interface UsageSeriesPoint {
	bucket: string;
	llmRequests: number;
	totalTokens: number;
	llmCost: number;
	llmUnknownCostEvents: number;
	llmEstimatedCostEvents: number;
	mediaRequests: number;
	mediaOutputs: number;
	generatedDurationSeconds: number;
	mediaKnownCost: number;
	mediaUnknownCostEvents: number;
}

interface QuotaWindow {
	id: string;
	label: string;
	usedPercent?: number;
	remaining?: number;
	limit?: number;
	unit?: string;
	resetsAt?: string;
	resetLabel?: string;
}

interface QuotaProvider {
	provider: string;
	providerDisplayName: string;
	mode?: string;
	configured: boolean;
	available: boolean;
	status: "ok" | "unavailable" | "not-configured";
	windows: QuotaWindow[];
	detail?: string;
	probedAt: string;
}

const REFRESH_MS = 10 * 60 * 1000;

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatCost(n: number): string {
	if (n === 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

function formatDuration(seconds: number): string {
	if (seconds <= 0) return "0 s";
	if (seconds < 60) return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)} s`;
	return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function quotaPercent(w: QuotaWindow): number | null {
	if (w.usedPercent !== undefined) return w.usedPercent;
	if (w.remaining !== undefined && w.limit && w.limit > 0) {
		return Math.min(100, Math.round(((w.limit - w.remaining) / w.limit) * 100));
	}
	return null;
}

export function UsageSection() {
	const [total, setTotal] = useState<UsageTotal | null>(null);
	const [byProvider, setByProvider] = useState<ProviderRow[]>([]);
	const [multimedia, setMultimedia] = useState<MediaUsageTotal | null>(null);
	const [mediaByProvider, setMediaByProvider] = useState<MediaProviderRow[]>([]);
	const [series, setSeries] = useState<UsageSeriesPoint[]>([]);
	const [quotas, setQuotas] = useState<QuotaProvider[]>([]);
	const [persisted, setPersisted] = useState(false);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);
	const [usageError, setUsageError] = useState<string | null>(null);
	const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [exportNotice, setExportNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [usageRes, quotasRes] = await Promise.all([
				apiGet<{
					total?: UsageTotal;
					byProvider?: ProviderRow[];
					multimedia?: MediaUsageTotal;
					mediaByProvider?: MediaProviderRow[];
					series?: UsageSeriesPoint[];
					persisted?: boolean;
				}>("/api/usage").catch(() => null),
				apiGet<{ providers?: QuotaProvider[] }>(
					"/api/quotas",
				).catch(() => ({ providers: [] as QuotaProvider[] })),
			]);
			if (usageRes) {
				setTotal(usageRes.total ?? null);
				setByProvider(usageRes.byProvider ?? []);
				setMultimedia(usageRes.multimedia ?? null);
				setMediaByProvider(usageRes.mediaByProvider ?? []);
				setSeries(usageRes.series ?? []);
				setPersisted(Boolean(usageRes.persisted));
				setUsageError(null);
				setUpdatedAt(Date.now());
			} else {
				setUsageError("Las métricas de uso no están disponibles.");
			}
			setQuotas(quotasRes.providers ?? []);
		} catch {
			/* keep last */
		} finally {
			setLoading(false);
		}
	}, []);

	const exportUsage = async (format: "csv" | "json") => {
		setExporting(format);
		setExportError(null);
		setExportNotice(null);
		try {
			const result = await apiDownload(
				`/api/usage/export?format=${format}`,
				`octopus-usage.${format}`,
			);
			setExportNotice(
				result.truncated
					? `Exportación limitada: ${result.filename} alcanzó el máximo de eventos.`
					: `Exportación creada: ${result.filename}`,
			);
		} catch (error) {
			setExportError(error instanceof Error ? error.message : String(error));
		} finally {
			setExporting(null);
		}
	};

	useEffect(() => {
		void load();
		const interval = setInterval(() => void load(), REFRESH_MS);
		return () => clearInterval(interval);
	}, [load]);

	return (
		<section
			style={{
				background: "rgba(24, 24, 27, 0.4)",
				border: "1px solid #27272a",
				borderRadius: "16px",
				padding: "24px",
				marginBottom: "24px",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					marginBottom: "16px",
					flexWrap: "wrap",
					gap: "8px",
				}}
			>
				<div>
					<h2 style={{ fontSize: "1.15rem", fontWeight: 700, color: "#f4f4f5", margin: 0 }}>
						📊 Uso y Consumo
					</h2>
					<p style={{ fontSize: "0.8rem", color: "#a1a1aa", margin: "4px 0 0" }}>
						Tokens y estimaciones de catálogo {persisted ? "persistidos (sobreviven reinicios)" : "de la sesión actual"} ·
						cuotas de Codex y Zhipu cuando estén configuradas · actualización cada 10 min
					</p>
				</div>
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
					<button type="button" onClick={() => void exportUsage("csv")} disabled={exporting !== null} style={usageButtonStyle}>
						{exporting === "csv" ? "Exportando..." : "Exportar CSV"}
					</button>
					<button type="button" onClick={() => void exportUsage("json")} disabled={exporting !== null} style={usageButtonStyle}>
						{exporting === "json" ? "Exportando..." : "Exportar JSON"}
					</button>
					<button type="button" onClick={() => void load()} disabled={loading} style={usageButtonStyle}>
						{loading ? "Actualizando..." : "Actualizar"}
					</button>
				</div>
			</div>
			{exportError && (
				<div role="alert" style={{ color: "#f87171", fontSize: "0.8rem", marginBottom: 12 }}>
					No se pudo exportar: {exportError}
				</div>
			)}
			{exportNotice && (
				<div aria-live="polite" style={{ color: "#34d399", fontSize: "0.8rem", marginBottom: 12 }}>
					{exportNotice}
				</div>
			)}
			{usageError && (
				<div role="alert" style={{ color: "#f87171", fontSize: "0.85rem", marginBottom: 16 }}>
					{usageError} Los valores anteriores, si existen, se conservan sin marcar una actualización nueva.
				</div>
			)}

			{(!usageError || total) && (
			<>
			{/* Totals */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
					gap: "12px",
					marginBottom: "20px",
				}}
			>
				<UsageMetric label="Tokens totales" value={formatTokens(total?.totalTokens ?? 0)} />
				<UsageMetric label="Entrada (prompt)" value={formatTokens(total?.promptTokens ?? 0)} />
				<UsageMetric label="Salida (completion)" value={formatTokens(total?.completionTokens ?? 0)} />
				<UsageMetric label="Razonamiento" value={formatTokens(total?.reasoningTokens ?? 0)} />
				<UsageMetric label="Estimación catálogo" value={formatCost(total?.totalCost ?? 0)} accent />
				<UsageMetric label="Costo desconocido" value={String(total?.unknownCostEvents ?? 0)} />
				<UsageMetric label="Peticiones" value={String(total?.requests ?? 0)} />
			</div>

			<h3 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#e4e4e7", marginBottom: "10px" }}>
				Multimedia
			</h3>
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
					gap: "12px",
					marginBottom: "20px",
				}}
			>
				<UsageMetric label="Requests posiblemente facturables" value={String(multimedia?.requests ?? 0)} />
				<UsageMetric label="Outputs guardados" value={String(multimedia?.outputs ?? 0)} />
				<UsageMetric label="Video generado" value={formatDuration(multimedia?.generatedDurationSeconds ?? 0)} />
				<UsageMetric label="Costo reportado" value={formatCost(multimedia?.knownCost ?? 0)} accent />
				<UsageMetric label="Costo desconocido" value={String(multimedia?.unknownCostEvents ?? 0)} />
			</div>

			{/* Per-provider breakdown */}
			<h3 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#e4e4e7", marginBottom: "10px" }}>
				Por proveedor
			</h3>
			{byProvider.length === 0 ? (
				<p style={{ color: "#71717a", fontSize: "0.85rem" }}>Sin datos de uso todavía.</p>
			) : (
				<div style={{ overflowX: "auto", marginBottom: "24px" }}>
					<table
						style={{
							width: "100%",
							borderCollapse: "collapse",
							fontSize: "0.82rem",
							minWidth: "520px",
						}}
					>
						<thead>
							<tr style={{ color: "#a1a1aa", textAlign: "left" }}>
								<th style={th}>Proveedor</th>
								<th style={th}>Tokens</th>
								<th style={th}>Razonamiento</th>
								<th style={th}>Peticiones</th>
								<th style={th}>Estimación</th>
								<th style={th}>Costo desconocido</th>
							</tr>
						</thead>
						<tbody>
							{byProvider.map((row) => (
								<tr key={row.provider} style={{ borderTop: "1px solid #27272a" }}>
									<td style={td}>
										<span style={{ color: "#f4f4f5", fontWeight: 600 }}>{row.provider}</span>
									</td>
									<td style={td}>{formatTokens(row.tokens)}</td>
									<td style={td}>{formatTokens(row.reasoningTokens)}</td>
									<td style={td}>{row.requests}</td>
									<td style={td}>
										<span style={{ color: "#818cf8" }}>{formatCost(row.cost)}</span>
									</td>
									<td style={td}>{row.unknownCostEvents}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<h3 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#e4e4e7", marginBottom: "10px" }}>
				Multimedia por proveedor
			</h3>
			{mediaByProvider.length === 0 ? (
				<p style={{ color: "#71717a", fontSize: "0.85rem" }}>Sin uso multimedia registrado.</p>
			) : (
				<div style={{ overflowX: "auto", marginBottom: "24px" }}>
					<table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", minWidth: "620px" }}>
						<thead>
							<tr style={{ color: "#a1a1aa", textAlign: "left" }}>
								<th style={th}>Proveedor</th>
								<th style={th}>Requests</th>
								<th style={th}>Outputs</th>
								<th style={th}>Video</th>
								<th style={th}>Costo reportado</th>
								<th style={th}>Costo desconocido</th>
							</tr>
						</thead>
						<tbody>
							{mediaByProvider.map((row) => (
								<tr key={row.provider} style={{ borderTop: "1px solid #27272a" }}>
									<td style={td}><span style={{ color: "#f4f4f5", fontWeight: 600 }}>{row.provider}</span></td>
									<td style={td}>{row.requests}</td>
									<td style={td}>{row.outputs}</td>
									<td style={td}>{formatDuration(row.generatedDurationSeconds)}</td>
									<td style={td}><span style={{ color: "#818cf8" }}>{formatCost(row.knownCost)}</span></td>
									<td style={td}>{row.unknownCostEvents}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<UsageTimeline points={series} />
			</>
			)}

			{/* Quotas */}
			<h3 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#e4e4e7", marginBottom: "10px" }}>
				Cuotas de plan
			</h3>
			{quotas.length === 0 ? (
				<p style={{ color: "#71717a", fontSize: "0.85rem" }}>
					No hay proveedores con cuota configurable (Codex o Zhipu/Z.ai en modo Coding Plan).
					Configúralos en la sección de proveedores para ver sus cuotas aquí.
				</p>
			) : (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
						gap: "14px",
					}}
				>
					{quotas.map((q) => (
						<QuotaCard key={q.provider} quota={q} />
					))}
				</div>
			)}

			{updatedAt && (
				<p style={{ fontSize: "0.72rem", color: "#52525b", marginTop: "16px" }}>
					Última actualización: {new Date(updatedAt).toLocaleTimeString("es-ES")} · próxima en 10 min
				</p>
			)}
		</section>
	);
}

const th: React.CSSProperties = {
	padding: "8px 10px",
	fontWeight: 500,
};

const td: React.CSSProperties = {
	padding: "8px 10px",
	color: "#d4d4d8",
};

const usageButtonStyle: React.CSSProperties = {
	padding: "6px 14px",
	borderRadius: "8px",
	border: "1px solid #3f3f46",
	background: "#18181b",
	color: "#f4f4f5",
	fontSize: "0.8rem",
	cursor: "pointer",
};

function UsageMetric({
	label,
	value,
	accent,
}: {
	label: string;
	value: string;
	accent?: boolean;
}) {
	return (
		<div
			style={{
				background: "#18181b",
				border: "1px solid #27272a",
				borderRadius: "12px",
				padding: "12px 14px",
			}}
		>
			<div style={{ fontSize: "0.72rem", color: "#a1a1aa", marginBottom: "4px" }}>{label}</div>
			<div
				style={{
					fontSize: "1.25rem",
					fontWeight: 700,
					color: accent ? "#818cf8" : "#f4f4f5",
				}}
			>
				{value}
			</div>
		</div>
	);
}

function UsageTimeline({ points }: { points: UsageSeriesPoint[] }) {
	const visible = points.slice(-14);
	const maxTokens = Math.max(1, ...visible.map((point) => point.totalTokens));
	const maxOutputs = Math.max(1, ...visible.map((point) => point.mediaOutputs));
	return (
		<div style={{ marginBottom: 24 }}>
			<h3 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#e4e4e7", marginBottom: "10px" }}>
				Serie temporal
			</h3>
			{visible.length === 0 ? (
				<p style={{ color: "#71717a", fontSize: "0.85rem" }}>Sin eventos para graficar.</p>
			) : (
				<>
				<ul aria-label="Uso diario de tokens y multimedia" style={{ display: "grid", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
					{visible.map((point) => (
						<li
							key={point.bucket}
							aria-label={`${point.bucket}: ${point.totalTokens} tokens y ${point.mediaOutputs} outputs multimedia`}
							style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "center" }}
						>
							<span style={{ color: "#a1a1aa", fontSize: "0.75rem", gridColumn: "1 / -1" }}>{point.bucket}</span>
							<div style={{ display: "grid", gap: 3 }}>
								<div title={`${point.totalTokens} tokens`} style={{ width: `${Math.max(2, (point.totalTokens / maxTokens) * 100)}%`, height: 5, borderRadius: 99, background: "#6366f1" }} />
								<div title={`${point.mediaOutputs} outputs multimedia`} style={{ width: `${Math.max(2, (point.mediaOutputs / maxOutputs) * 100)}%`, height: 5, borderRadius: 99, background: "#10b981" }} />
							</div>
							<span style={{ color: "#d4d4d8", fontSize: "0.75rem", whiteSpace: "nowrap" }}>
								{formatTokens(point.totalTokens)} tok · {point.mediaOutputs} media
							</span>
						</li>
					))}
				</ul>
					<div style={{ display: "flex", gap: 14, color: "#71717a", fontSize: "0.72rem", marginTop: 8 }}>
						<span><span style={{ color: "#6366f1" }}>■</span> tokens</span>
						<span><span style={{ color: "#10b981" }}>■</span> outputs multimedia</span>
					</div>
				</>
			)}
		</div>
	);
}

function QuotaCard({ quota }: { quota: QuotaProvider }) {
	const title = quota.providerDisplayName ?? quota.provider;
	return (
		<div
			style={{
				background: "#18181b",
				border: "1px solid #27272a",
				borderRadius: "12px",
				padding: "14px",
			}}
		>
			<div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
				<span style={{ fontWeight: 700, color: "#f4f4f5" }}>{title}</span>
				{quota.mode && (
					<span
						style={{
							fontSize: "0.7rem",
							padding: "2px 8px",
							borderRadius: "20px",
							background: "rgba(99,102,241,0.1)",
							color: "#818cf8",
							border: "1px solid rgba(99,102,241,0.2)",
						}}
					>
						{quota.mode}
					</span>
				)}
			</div>

			{!quota.available ? (
				<div style={{ fontSize: "0.8rem", color: "#a1a1aa" }}>
					<span style={{ color: "#f59e0b" }}>●</span> Cuota no disponible
					{quota.detail ? (
						<div style={{ color: "#71717a", marginTop: "4px" }}>{quota.detail}</div>
					) : null}
				</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
					{quota.windows.map((w) => {
						const pct = quotaPercent(w);
						return (
							<div key={w.id}>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										fontSize: "0.8rem",
										color: "#d4d4d8",
										marginBottom: "4px",
									}}
								>
									<span>{w.label}</span>
									<span style={{ fontWeight: 600 }}>
										{pct !== null ? `${pct}% usado` : "En uso"}
									</span>
								</div>
								{pct !== null && (
									<div
										style={{
											height: "6px",
											borderRadius: "4px",
											background: "#27272a",
											overflow: "hidden",
										}}
									>
										<div
											style={{
												width: `${pct}%`,
												height: "100%",
												background:
													pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#10b981",
											}}
										/>
									</div>
								)}
								{w.resetLabel && (
									<div style={{ fontSize: "0.72rem", color: "#71717a", marginTop: "4px" }}>
										Se restablece: {w.resetLabel}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
