import { OCTOPUS_ARM_PROFILES } from "@octopus-ai/core/agent/arm-profiles";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ActivityFeed } from "../../components/dashboard/ActivityFeed.js";
import { DashboardStatsGrid } from "../../components/dashboard/DashboardStats.js";
import { OctopusGraph } from "../../components/dashboard/OctopusGraph.js";
import { QuickActions } from "../../components/dashboard/QuickActions.js";
import type {
	DashboardArmSummary,
	WorkflowRunSummary,
} from "../../hooks/useDashboard.js";
import { useDashboard } from "../../hooks/useDashboard.js";
import { publicAsset } from "../../utils/assets.js";

const LOGO_SRC = publicAsset("mascotas/Pulpo_octavio.png");

/** armKey → real mascot avatar (single source of truth). */
const ARM_AVATAR = new Map<string, string>(
	OCTOPUS_ARM_PROFILES.map((profile) => [
		profile.key,
		publicAsset(profile.avatar),
	]),
);

function armAvatar(armKey: string | null): string {
	return (armKey ? ARM_AVATAR.get(armKey) : undefined) ?? LOGO_SRC;
}

interface DashboardPageProps {
	onNavigate?: (tab: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
	const {
		stats,
		usage,
		model,
		providerDisplayName,
		uptime,
		activeAgents,
		activity,
		recentWorkflows,
		arms,
		mainAgent,
		loading,
		reload,
	} = useDashboard();

	const online = stats?.status === "online";

	return (
		<div className="page-shell">
			{/* Header */}
			<header className="cc-header animate-fade-in">
				<div className="cc-header-brand">
					<div className="cc-hero-logo">
						<img src={LOGO_SRC} alt="Octopus AI" />
					</div>
					<div>
						<h1 className="ui-page-title">Centro de Control</h1>
						<p className="ui-page-subtitle">
							Bienvenido a Octopus AI — tu workspace multi-agente
						</p>
					</div>
				</div>
				<div className="cc-status-pills">
					<StatusPill tone={online ? "ok" : "warn"} dot>
						{online ? "En línea" : "Degradado"}
					</StatusPill>
					<StatusPill tone="neutral">
						<span className="cc-pill-label">Uptime</span>
						<span className="cc-pill-value">{formatUptime(uptime)}</span>
					</StatusPill>
					<StatusPill tone="neutral">
						<span className="cc-pill-label">Agentes activos</span>
						<span className="cc-pill-value">{activeAgents.total}</span>
					</StatusPill>
				</div>
			</header>

			{/* Octopus panel: constellation + arm legend (provider/model per arm) */}
			<section className="cc-octopus-panel ui-panel cc-section">
				<div className="cc-octopus-head">
					<div>
						<h2 className="ui-section-title">🐙 Centro de Octavio</h2>
						<p className="ui-section-subtitle">
							Cada brazo con su proveedor y modelo configurados
						</p>
					</div>
					<span className="cc-constellation-count">{arms.length}/8 brazos</span>
				</div>
				<div className="cc-octopus-body">
					<div className="cc-octopus-constellation">
						<OctopusGraph
							mainAgent={mainAgent}
							arms={arms}
							fallbackProvider={providerDisplayName}
							fallbackModel={model}
						/>
					</div>
					<ArmLegend
						mainAgent={mainAgent}
						arms={arms}
						fallbackProvider={providerDisplayName}
						fallbackModel={model}
					/>
				</div>
			</section>

			{/* Live metrics */}
			<section className="cc-section">
				<div className="cc-metrics-grid">
					<MetricCard
						label="Tokens totales"
						value={usage.totalTokens}
						format={formatTokens}
					/>
					<MetricCard
						label="Tokens entrada"
						value={usage.promptTokens}
						format={formatTokens}
						accent="#38bdf8"
						hint="prompt"
					/>
					<MetricCard
						label="Tokens salida"
						value={usage.completionTokens}
						format={formatTokens}
						accent="#a78bfa"
						hint="completion"
					/>
					<MetricCard
						label="Costo estimado"
						value={usage.totalCost}
						format={formatCost}
						accent="#10b981"
					/>
					<MetricCard label="Llamadas API" value={usage.apiCalls} />
					<MetricCard
						label="Tareas activas"
						value={stats?.runningTasks ?? 0}
						accent="#f59e0b"
					/>
				</div>
				{activeAgents.total > 0 ? (
					<div className="cc-active-note">
						{activeAgents.chat} en chat · {activeAgents.workers} workers
					</div>
				) : null}
			</section>

			{/* Quick Actions */}
			<section className="cc-section">
				<QuickActions
					onNewChat={() => onNavigate?.("chat")}
					onViewAgents={() => onNavigate?.("agents")}
					onViewSettings={() => onNavigate?.("settings")}
					onViewChannels={() => onNavigate?.("channels")}
					onViewTasks={() => onNavigate?.("tasks")}
					onViewTools={() => onNavigate?.("tools")}
					onViewVariables={() => onNavigate?.("variables")}
					onViewAutomations={() => onNavigate?.("automations")}
					onViewMemory={() => onNavigate?.("memory")}
					onViewSkills={() => onNavigate?.("skills")}
					onViewMedia={() => onNavigate?.("media")}
				/>
			</section>

			{/* Stats */}
			<section className="cc-section">
				<div className="cc-section-head">
					<h2 className="ui-section-title">Estadísticas</h2>
					<button
						type="button"
						onClick={reload}
						className="ui-btn ui-btn--ghost"
					>
						↻ Actualizar
					</button>
				</div>
				<DashboardStatsGrid stats={stats} loading={loading} />
			</section>

			{/* Workflows */}
			<section className="cc-section">
				<RecentWorkflowsCard
					workflows={recentWorkflows}
					onOpenTasks={() => onNavigate?.("tasks")}
				/>
			</section>

			{/* Activity Feed */}
			<section>
				<div className="cc-section-head">
					<h2 className="ui-section-title">Actividad Reciente</h2>
				</div>
				<div className="cc-activity-shell">
					<ActivityFeed items={activity} />
				</div>
			</section>
		</div>
	);
};

function useCountUp(value: number, duration = 650): number {
	const [display, setDisplay] = useState(0);
	const fromRef = useRef(0);
	useEffect(() => {
		const from = fromRef.current;
		const start = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / duration);
			const eased = 1 - (1 - t) ** 3;
			const next = Math.round(from + (value - from) * eased);
			setDisplay(next);
			if (t < 1) {
				raf = requestAnimationFrame(tick);
			} else {
				fromRef.current = value;
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [value, duration]);
	return display;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatCost(n: number): string {
	if (n <= 0) return "$0.00";
	if (n < 0.01) return "<$0.01";
	return `$${n.toFixed(2)}`;
}

function formatUptime(seconds: number): string {
	const s = Math.floor(seconds % 60);
	const m = Math.floor((seconds / 60) % 60);
	const h = Math.floor(seconds / 3600);
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

const PILL_TONES: Record<string, string> = {
	ok: "#34d399",
	warn: "#fbbf24",
	accent: "#a5b4fc",
	neutral: "#a1a1aa",
};

const StatusPill: React.FC<{
	tone?: keyof typeof PILL_TONES | string;
	dot?: boolean;
	children: React.ReactNode;
}> = ({ tone = "neutral", dot, children }) => {
	const color = PILL_TONES[tone] ?? "#a1a1aa";
	return (
		<span
			className="cc-status-pill"
			style={{ "--pill-color": color } as React.CSSProperties}
		>
			{dot ? <span className="cc-status-pill__dot" /> : null}
			{children}
		</span>
	);
};

const MetricCard: React.FC<{
	label: string;
	value: number;
	format?: (n: number) => string;
	accent?: string;
	hint?: string;
}> = ({ label, value, format, accent, hint }) => {
	const animated = useCountUp(value);
	return (
		<div className="cc-metric-card">
			<div className="cc-metric-label">{label}</div>
			<div
				className="cc-metric-value"
				style={accent ? { color: accent } : undefined}
			>
				{format ? format(animated) : animated.toLocaleString()}
			</div>
			{hint ? <div className="cc-metric-hint">{hint}</div> : null}
		</div>
	);
};

interface LegendRow {
	key: string;
	arm: DashboardArmSummary;
	isMain: boolean;
	provider?: string;
	model?: string;
}

const ArmLegend: React.FC<{
	mainAgent: DashboardArmSummary | null;
	arms: DashboardArmSummary[];
	fallbackProvider?: string;
	fallbackModel?: string;
}> = ({ mainAgent, arms, fallbackProvider, fallbackModel }) => {
	const rows: LegendRow[] = [];
	if (mainAgent) {
		rows.push({
			key: `main-${mainAgent.id}`,
			arm: mainAgent,
			isMain: true,
			provider: mainAgent.providerDisplayName ?? fallbackProvider,
			model: mainAgent.effectiveModel ?? fallbackModel,
		});
	}
	for (const arm of arms) {
		rows.push({
			key: arm.id,
			arm,
			isMain: false,
			provider: arm.providerDisplayName,
			model: arm.effectiveModel,
		});
	}

	if (rows.length === 0) {
		return (
			<div className="ui-empty" style={{ padding: "28px 16px" }}>
				<div className="ui-empty-title">Sin brazos todavía</div>
				<div className="ui-empty-desc">
					Los brazos aparecerán después del bootstrap del sistema.
				</div>
			</div>
		);
	}

	return (
		<div className="cc-arm-legend">
			{rows.map(({ key, arm, isMain, provider, model }) => {
				const color = arm.color ?? (isMain ? "#6366f1" : "#818cf8");
				const modelTag = model ? model.split("/").pop() : undefined;
				return (
					<div
						key={key}
						className="arm-card"
						style={{ "--arm-color": color } as React.CSSProperties}
					>
						<img
							className="arm-card__img"
							src={armAvatar(arm.armKey)}
							alt={arm.name}
							loading="lazy"
						/>
						<div className="arm-card__meta">
							<div className="arm-card__name">
								{arm.name}
								{isMain ? (
									<span className="arm-card__tag">orquestador</span>
								) : null}
							</div>
							<div className="arm-card__sub">
								{provider || "Proveedor —"}
								{modelTag ? ` · ${modelTag}` : " · —"}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
};

const RecentWorkflowsCard: React.FC<{
	workflows: WorkflowRunSummary[];
	onOpenTasks: () => void;
}> = ({ workflows, onOpenTasks }) => (
	<section className="ui-panel cc-panel">
		<div className="cc-panel-head">
			<div>
				<h2 className="ui-section-title">Workflows recientes</h2>
				<p className="ui-section-subtitle">
					Ejecuciones durables y recuperables
				</p>
			</div>
			<button
				type="button"
				onClick={onOpenTasks}
				className="ui-btn ui-btn--accent"
			>
				Ver tareas
			</button>
		</div>
		{workflows.length === 0 ? (
			<div className="ui-empty" style={{ padding: "28px 16px" }}>
				<div className="ui-empty-title">Aún no hay workflows</div>
				<div className="ui-empty-desc">
					Las ejecuciones aparecerán aquí cuando inicies un workflow.
				</div>
			</div>
		) : (
			<div style={{ display: "grid", gap: "10px" }}>
				{workflows.map((workflow) => (
					<div key={workflow.id} className="ui-list-item">
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								gap: 12,
							}}
						>
							<strong style={{ color: "#f4f4f5", fontSize: "0.88rem" }}>
								{workflow.goal || workflow.id}
							</strong>
							<span
								className={`ui-status ${workflowStatusClass(workflow.status)}`}
							>
								{workflow.status}
							</span>
						</div>
						<div
							style={{ color: "#71717a", fontSize: "0.75rem", marginTop: 6 }}
						>
							{workflow.current_phase
								? `Fase: ${workflow.current_phase} · `
								: ""}
							{formatDate(workflow.updated_at)}
						</div>
					</div>
				))}
			</div>
		)}
	</section>
);

function workflowStatusClass(status: string): string {
	switch (status) {
		case "done":
			return "is-success";
		case "running":
		case "ready":
			return "is-info";
		case "interrupted":
		case "partial":
			return "is-warning";
		case "failed":
		case "blocked":
		case "cancelled":
			return "is-error";
		default:
			return "is-neutral";
	}
}

function formatDate(value?: string): string {
	if (!value) return "sin fecha";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}
