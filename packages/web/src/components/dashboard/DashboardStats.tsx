import type React from "react";
import type { DashboardStats } from "../../hooks/useDashboard.js";

interface StatCardProps {
	icon: string;
	label: string;
	value: string | number;
	sublabel?: string;
	color: string;
	bg: string;
	index: number;
}

const StatCard: React.FC<StatCardProps> = ({
	icon,
	label,
	value,
	sublabel,
	color,
	bg,
	index,
}) => (
	<div
		className="animate-slide-up"
		style={{
			background: "rgba(24, 24, 27, 0.6)",
			border: "1px solid rgba(255,255,255,0.05)",
			borderRadius: "16px",
			padding: "24px",
			display: "flex",
			alignItems: "center",
			gap: "16px",
			animationDelay: `${index * 60}ms`,
			animationFillMode: "both",
			transition: "transform 0.2s ease, box-shadow 0.2s ease",
			cursor: "default",
		}}
		onMouseEnter={(e) => {
			e.currentTarget.style.transform = "translateY(-2px)";
			e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.3)";
		}}
		onMouseLeave={(e) => {
			e.currentTarget.style.transform = "translateY(0)";
			e.currentTarget.style.boxShadow = "none";
		}}
	>
		<div
			style={{
				fontSize: "24px",
				background: bg,
				color,
				width: "52px",
				height: "52px",
				borderRadius: "14px",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				flexShrink: 0,
			}}
		>
			{icon}
		</div>
		<div style={{ minWidth: 0 }}>
			<div
				style={{
					fontSize: "1.75rem",
					fontWeight: 700,
					color: "#f4f4f5",
					lineHeight: 1.2,
				}}
			>
				{value}
			</div>
			<div style={{ fontSize: "0.85rem", color: "#a1a1aa", marginTop: "4px" }}>
				{label}
			</div>
			{sublabel && (
				<div
					style={{ fontSize: "0.75rem", color: "#71717a", marginTop: "2px" }}
				>
					{sublabel}
				</div>
			)}
		</div>
	</div>
);

interface DashboardStatsProps {
	stats: DashboardStats | null;
	loading: boolean;
}

export const DashboardStatsGrid: React.FC<DashboardStatsProps> = ({
	stats,
	loading,
}) => {
	if (loading) {
		return (
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
					gap: "16px",
				}}
			>
				{Array.from({ length: 6 }).map((_, i) => (
					<div
						key={i}
						className="skeleton"
						style={{ height: "100px", borderRadius: "16px" }}
					/>
				))}
			</div>
		);
	}

	if (!stats) return null;

	const cards = [
		{
			icon: "🤖",
			label: "Agentes activos",
			value: stats.agents,
			color: "#818cf8",
			bg: "rgba(99, 102, 241, 0.1)",
		},
		{
			icon: "💬",
			label: "Conversaciones",
			value: stats.conversations,
			color: "#10b981",
			bg: "rgba(16, 185, 129, 0.1)",
		},
		{
			icon: "🔌",
			label: "Herramientas",
			value: stats.tools,
			sublabel: `${stats.mcp} MCP`,
			color: "#34d399",
			bg: "rgba(52, 211, 153, 0.1)",
		},
		{
			icon: "💭",
			label: "Base de memoria",
			value: stats.memories > 0 ? "Activa" : "0",
			color: "#fbbf24",
			bg: "rgba(245, 158, 11, 0.1)",
		},
		{
			icon: "🧠",
			label: "Modelo de IA",
			value: stats.provider.split("/")[1] || stats.provider,
			color: "#f472b6",
			bg: "rgba(236, 72, 153, 0.1)",
		},
		{
			icon: "📡",
			label: "Canales activos",
			value: stats.channels.length,
			color: "#60a5fa",
			bg: "rgba(96, 165, 250, 0.1)",
		},
	];

	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
				gap: "16px",
			}}
		>
			{cards.map((card, i) => (
				<StatCard key={card.label} {...card} index={i} />
			))}
		</div>
	);
};
