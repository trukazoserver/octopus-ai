import type React from "react";
import { ActivityFeed } from "../../components/dashboard/ActivityFeed.js";
import { DashboardStatsGrid } from "../../components/dashboard/DashboardStats.js";
import { QuickActions } from "../../components/dashboard/QuickActions.js";
import { useDashboard } from "../../hooks/useDashboard.js";

interface DashboardPageProps {
	onNavigate?: (tab: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
	const { stats, activity, loading, reload } = useDashboard();

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
							src="/logo_Pulpo_octavio.png"
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
