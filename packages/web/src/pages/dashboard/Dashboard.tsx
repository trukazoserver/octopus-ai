import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ActivityFeed } from "../../components/dashboard/ActivityFeed.js";
import { DashboardStatsGrid } from "../../components/dashboard/DashboardStats.js";
import { QuickActions } from "../../components/dashboard/QuickActions.js";
import type {
	DashboardArmSummary,
	WorkflowRunSummary,
} from "../../hooks/useDashboard.js";
import { useDashboard } from "../../hooks/useDashboard.js";
import { publicAsset } from "../../utils/assets.js";

const LOGO_SRC = publicAsset("mascotas/Pulpo_octavio.png");

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
		loading,
		reload,
	} = useDashboard();

	return (
		<div className="page-shell" style={{ maxWidth: "1220px" }}>
			{/* Header */}
			<div className="animate-fade-in" style={{ marginBottom: "32px" }}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: "16px",
						marginBottom: "8px",
					}}
				>
					<div
						style={{
							width: "58px",
							height: "58px",
							borderRadius: "18px",
							background: "#050505",
							border: "1px solid #202020",
							display: "grid",
							placeItems: "center",
							filter: "drop-shadow(0 0 20px rgba(99,102,241,0.3))",
							animation: "float 3s ease-in-out infinite",
						}}
					>
						<img
							src={LOGO_SRC}
							alt="Octopus AI"
							style={{ width: "46px", height: "46px", objectFit: "contain" }}
						/>
					</div>
					<div>
						<h1
							style={{
								fontSize: "1.8rem",
								fontWeight: 700,
								color: "#f4f4f5",
								margin: 0,
								letterSpacing: "-0.02em",
							}}
						>
							Centro de Control
						</h1>
						<p
							style={{
								fontSize: "0.95rem",
								color: "#a1a1aa",
								margin: "4px 0 0",
							}}
						>
							Bienvenido a Octopus AI — tu workspace multi-agente
						</p>
					</div>
				</div>
			</div>

			{/* Live metrics */}
			<div
				className="animate-fade-in"
				style={{ marginBottom: "32px", display: "grid", gap: "16px" }}
			>
				<div
					style={{
						display: "flex",
						flexWrap: "wrap",
						gap: "16px",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "18px 22px",
						borderRadius: "18px",
						background:
							"linear-gradient(135deg, rgba(99,102,241,0.16), rgba(24,24,27,0.6))",
						border: "1px solid rgba(99,102,241,0.25)",
						boxShadow: "0 18px 50px rgba(0,0,0,.28)",
					}}
				>
					<div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
						<span
							style={{
								width: 11,
								height: 11,
								borderRadius: 999,
								background: stats?.status === "online" ? "#10b981" : "#f59e0b",
								boxShadow: "0 0 0 4px rgba(16,185,129,.14)",
								animation: "pulse 2s infinite",
							}}
						/>
						<div>
							<div
								style={{
									fontSize: "0.72rem",
									color: "#a1a1aa",
									fontWeight: 700,
									textTransform: "uppercase",
									letterSpacing: "0.06em",
								}}
							>
								Proveedor · Modelo
							</div>
							<div
								style={{
									fontSize: "1.3rem",
									fontWeight: 800,
									color: "#f4f4f5",
									letterSpacing: "-0.02em",
								}}
							>
								{providerDisplayName || "—"}
								{model ? (
									<span
										style={{
											color: "#a1a1aa",
											fontWeight: 600,
											fontSize: "0.95rem",
										}}
									>
										{" · "}
										{model}
									</span>
								) : null}
							</div>
						</div>
					</div>
					<div style={{ display: "flex", gap: "26px", flexWrap: "wrap" }}>
						<HeroStat
							label="Estado"
							value={stats?.status === "online" ? "En línea" : "Degradado"}
							color={stats?.status === "online" ? "#10b981" : "#f59e0b"}
						/>
						<HeroStat label="Uptime" value={formatUptime(uptime)} />
						<HeroStat
							label="Agentes activos"
							value={String(activeAgents.total)}
							color="#818cf8"
						/>
					</div>
				</div>

				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(168px, 1fr))",
						gap: "14px",
					}}
				>
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
					<div style={{ fontSize: "0.78rem", color: "#71717a" }}>
						Agentes activos: {activeAgents.chat} en chat ·{" "}
						{activeAgents.workers} workers
					</div>
				) : null}
			</div>

			{/* Quick Actions */}
			<div style={{ marginBottom: "32px" }}>
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
			</div>

			{/* Stats */}
			<div style={{ marginBottom: "32px" }}>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: "16px",
					}}
				>
					<h2
						style={{
							fontSize: "1.1rem",
							fontWeight: 700,
							color: "#f4f4f5",
							margin: 0,
						}}
					>
						Estadísticas
					</h2>
					<button
						type="button"
						onClick={reload}
						style={{
							background: "none",
							border: "1px solid #27272a",
							borderRadius: "8px",
							color: "#a1a1aa",
							padding: "6px 12px",
							fontSize: "0.8rem",
							cursor: "pointer",
							fontFamily: "inherit",
							transition: "all 0.15s",
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.borderColor = "#6366f1";
							e.currentTarget.style.color = "#818cf8";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.borderColor = "#27272a";
							e.currentTarget.style.color = "#a1a1aa";
						}}
					>
						↻ Actualizar
					</button>
				</div>
				<DashboardStatsGrid stats={stats} loading={loading} />
			</div>

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
					gap: "18px",
					marginBottom: "32px",
				}}
			>
				<RecentWorkflowsCard
					workflows={recentWorkflows}
					onOpenTasks={() => onNavigate?.("tasks")}
				/>
				<ArmStatusCard arms={arms} />
			</div>

			{/* Activity Feed */}
			<div>
				<h2
					style={{
						fontSize: "1.1rem",
						fontWeight: 700,
						color: "#f4f4f5",
						marginBottom: "16px",
					}}
				>
					Actividad Reciente
				</h2>
				<div
					style={{
						background: "rgba(24, 24, 27, 0.4)",
						border: "1px solid #27272a",
						borderRadius: "16px",
						overflow: "hidden",
						maxHeight: "400px",
						overflowY: "auto",
					}}
				>
					<ActivityFeed items={activity} />
				</div>
			</div>
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

const HeroStat: React.FC<{
	label: string;
	value: string;
	color?: string;
}> = ({ label, value, color }) => (
	<div>
		<div
			style={{
				fontSize: "0.68rem",
				color: "#71717a",
				fontWeight: 700,
				textTransform: "uppercase",
				letterSpacing: "0.06em",
			}}
		>
			{label}
		</div>
		<div
			style={{
				fontSize: "1.05rem",
				fontWeight: 800,
				color: color ?? "#f4f4f5",
				letterSpacing: "-0.01em",
			}}
		>
			{value}
		</div>
	</div>
);

const MetricCard: React.FC<{
	label: string;
	value: number;
	format?: (n: number) => string;
	accent?: string;
	hint?: string;
}> = ({ label, value, format, accent, hint }) => {
	const animated = useCountUp(value);
	return (
		<div
			style={{
				padding: "16px 18px",
				borderRadius: "16px",
				background: "linear-gradient(180deg, #18181b 0%, #101013 100%)",
				border: "1px solid #27272a",
				boxShadow: "0 10px 24px rgba(0,0,0,.22)",
			}}
		>
			<div
				style={{
					fontSize: "0.72rem",
					color: "#a1a1aa",
					fontWeight: 700,
					textTransform: "uppercase",
					letterSpacing: "0.04em",
				}}
			>
				{label}
			</div>
			<div
				style={{
					fontSize: "1.7rem",
					fontWeight: 800,
					color: accent ?? "#f4f4f5",
					letterSpacing: "-0.02em",
					marginTop: 6,
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{format ? format(animated) : animated.toLocaleString()}
			</div>
			{hint ? (
				<div style={{ fontSize: "0.7rem", color: "#71717a", marginTop: 4 }}>
					{hint}
				</div>
			) : null}
		</div>
	);
};

const RecentWorkflowsCard: React.FC<{
	workflows: WorkflowRunSummary[];
	onOpenTasks: () => void;
}> = ({ workflows, onOpenTasks }) => (
	<section style={panelStyle}>
		<div style={panelHeaderStyle}>
			<div>
				<h2 style={panelTitleStyle}>Workflows recientes</h2>
				<p style={panelSubtitleStyle}>Ejecuciones durables y recuperables</p>
			</div>
			<button type="button" onClick={onOpenTasks} style={panelButtonStyle}>
				Ver tareas
			</button>
		</div>
		{workflows.length === 0 ? (
			<div style={emptyStyle}>Aún no hay workflows registrados.</div>
		) : (
			<div style={{ display: "grid", gap: "10px" }}>
				{workflows.map((workflow) => (
					<div key={workflow.id} style={workflowItemStyle}>
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
								style={{
									...statusBadgeStyle,
									color: workflowColor(workflow.status),
								}}
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

const ArmStatusCard: React.FC<{ arms: DashboardArmSummary[] }> = ({ arms }) => (
	<section style={panelStyle}>
		<div style={panelHeaderStyle}>
			<div>
				<h2 style={panelTitleStyle}>Brazos Octopus</h2>
				<p style={panelSubtitleStyle}>
					Identidades builtin listas para delegación
				</p>
			</div>
			<span style={{ color: "#a78bfa", fontWeight: 800 }}>{arms.length}/8</span>
		</div>
		{arms.length === 0 ? (
			<div style={emptyStyle}>Los brazos aparecerán después del bootstrap.</div>
		) : (
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
					gap: 10,
				}}
			>
				{arms.map((arm) => (
					<div key={arm.id} style={armItemStyle}>
						<span
							style={{
								width: 8,
								height: 8,
								borderRadius: 999,
								background: arm.color ?? "#818cf8",
							}}
						/>
						<div style={{ minWidth: 0 }}>
							<div
								style={{
									color: "#f4f4f5",
									fontSize: "0.84rem",
									fontWeight: 700,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{arm.name}
							</div>
							<div style={{ color: "#71717a", fontSize: "0.72rem" }}>
								{arm.armKey ?? arm.role}
							</div>
						</div>
					</div>
				))}
			</div>
		)}
	</section>
);

function workflowColor(status: string): string {
	switch (status) {
		case "done":
			return "#22c55e";
		case "running":
		case "ready":
			return "#38bdf8";
		case "interrupted":
		case "partial":
			return "#f59e0b";
		case "failed":
		case "blocked":
		case "cancelled":
			return "#ef4444";
		default:
			return "#a1a1aa";
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

const panelStyle: React.CSSProperties = {
	background: "rgba(24, 24, 27, 0.45)",
	border: "1px solid #27272a",
	borderRadius: "16px",
	padding: "18px",
};

const panelHeaderStyle: React.CSSProperties = {
	display: "flex",
	justifyContent: "space-between",
	alignItems: "flex-start",
	gap: "14px",
	marginBottom: "14px",
};

const panelTitleStyle: React.CSSProperties = {
	fontSize: "1rem",
	fontWeight: 800,
	color: "#f4f4f5",
	margin: 0,
};

const panelSubtitleStyle: React.CSSProperties = {
	fontSize: "0.78rem",
	color: "#71717a",
	margin: "4px 0 0",
};

const panelButtonStyle: React.CSSProperties = {
	border: "1px solid rgba(167, 139, 250, 0.35)",
	background: "rgba(167, 139, 250, 0.1)",
	color: "#c4b5fd",
	borderRadius: "9px",
	padding: "7px 10px",
	fontSize: "0.78rem",
	fontWeight: 700,
	cursor: "pointer",
};

const emptyStyle: React.CSSProperties = {
	padding: "22px",
	borderRadius: "12px",
	background: "rgba(9, 9, 11, 0.35)",
	color: "#71717a",
	fontSize: "0.84rem",
	textAlign: "center",
};

const workflowItemStyle: React.CSSProperties = {
	padding: "12px",
	borderRadius: "12px",
	background: "rgba(9, 9, 11, 0.45)",
	border: "1px solid rgba(255,255,255,0.04)",
};

const statusBadgeStyle: React.CSSProperties = {
	fontSize: "0.72rem",
	fontWeight: 800,
	textTransform: "uppercase",
	letterSpacing: "0.04em",
};

const armItemStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "8px",
	padding: "10px",
	borderRadius: "10px",
	background: "rgba(9, 9, 11, 0.45)",
	border: "1px solid rgba(255,255,255,0.04)",
};
