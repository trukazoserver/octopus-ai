import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../hooks/useApi.js";

interface UsageTotal {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalCost: number;
	requests: number;
}

interface ProviderRow {
	provider: string;
	tokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	cost: number;
	requests: number;
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
	const [quotas, setQuotas] = useState<QuotaProvider[]>([]);
	const [persisted, setPersisted] = useState(false);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		try {
			const [usageRes, quotasRes] = await Promise.all([
				apiGet<{
					total?: UsageTotal;
					byProvider?: ProviderRow[];
					persisted?: boolean;
				}>("/api/usage").catch(() => ({ total: undefined, byProvider: [], persisted: false })),
				apiGet<{ providers?: QuotaProvider[] }>(
					"/api/quotas",
				).catch(() => ({ providers: [] as QuotaProvider[] })),
			]);
			setTotal(usageRes.total ?? null);
			setByProvider(usageRes.byProvider ?? []);
			setPersisted(Boolean(usageRes.persisted));
			setQuotas(quotasRes.providers ?? []);
			setUpdatedAt(Date.now());
		} catch {
			/* keep last */
		} finally {
			setLoading(false);
		}
	}, []);

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
						Tokens y costos {persisted ? "persistidos (sobreviven reinicios)" : "de la sesión actual"} ·
						cuotas de Codex y Zhipu cuando estén configuradas · actualización cada 10 min
					</p>
				</div>
				<button
					type="button"
					onClick={() => void load()}
					disabled={loading}
					style={{
						padding: "6px 14px",
						borderRadius: "8px",
						border: "1px solid #3f3f46",
						background: "#18181b",
						color: "#f4f4f5",
						fontSize: "0.8rem",
						cursor: loading ? "wait" : "pointer",
					}}
				>
					{loading ? "Actualizando…" : "Actualizar"}
				</button>
			</div>

			{/* Totals */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
					gap: "12px",
					marginBottom: "20px",
				}}
			>
				<UsageMetric label="Tokens totales" value={formatTokens(total?.totalTokens ?? 0)} />
				<UsageMetric label="Entrada (prompt)" value={formatTokens(total?.promptTokens ?? 0)} />
				<UsageMetric label="Salida (completion)" value={formatTokens(total?.completionTokens ?? 0)} />
				<UsageMetric label="Razonamiento" value={formatTokens(total?.reasoningTokens ?? 0)} />
				<UsageMetric label="Costo estimado" value={formatCost(total?.totalCost ?? 0)} accent />
				<UsageMetric label="Peticiones" value={String(total?.requests ?? 0)} />
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
								<th style={th}>Costo</th>
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
								</tr>
							))}
						</tbody>
					</table>
				</div>
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
