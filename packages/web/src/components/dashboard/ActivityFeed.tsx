import type React from "react";
import type { ActivityItem } from "../../hooks/useDashboard.js";
import { AppIcon, type AppIconName } from "../ui/AppIcon.js";

const TYPE_CONFIG: Record<string, { icon: AppIconName; color: string }> = {
	message: { icon: "chat", color: "#818cf8" },
	task: { icon: "check", color: "#10b981" },
	skill: { icon: "spark", color: "#f59e0b" },
	agent: { icon: "agent", color: "#6366f1" },
	system: { icon: "settings", color: "#71717a" },
};

function timeAgo(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60000) return "ahora";
	if (diff < 3600000) return `hace ${Math.floor(diff / 60000)}m`;
	if (diff < 86400000) return `hace ${Math.floor(diff / 3600000)}h`;
	return `hace ${Math.floor(diff / 86400000)}d`;
}

interface ActivityFeedProps {
	items: ActivityItem[];
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({ items }) => {
	if (items.length === 0) {
		return (
			<div
				style={{
					padding: "32px",
					textAlign: "center",
					color: "#52525b",
					fontSize: "0.85rem",
				}}
			>
				<div style={{ color: "#71717a", marginBottom: 8 }}>
					<AppIcon name="activity" size={28} />
				</div>
				<div style={{ color: "#a1a1aa", fontWeight: 700 }}>
					No hay actividad reciente
				</div>
				<div style={{ marginTop: 4 }}>
					La actividad de conversaciones, tareas y sistema aparecerá aquí.
				</div>
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
			{items.map((item, i) => {
				const cfg = TYPE_CONFIG[item.type] ?? TYPE_CONFIG.system;
				return (
					<div
						key={item.id}
						className="animate-fade-in"
						style={{
							display: "flex",
							alignItems: "center",
							gap: "12px",
							padding: "12px 16px",
							borderRadius: "10px",
							transition: "background 0.15s",
							cursor: "default",
							animationDelay: `${i * 40}ms`,
							animationFillMode: "both",
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.background = "#27272a";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.background = "transparent";
						}}
					>
						<span style={{ color: cfg.color, flexShrink: 0 }}>
							<AppIcon name={cfg.icon} size={16} />
						</span>
						<div style={{ flex: 1, minWidth: 0 }}>
							<div
								style={{
									fontSize: "0.875rem",
									color: "#e4e4e7",
									fontWeight: 500,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{item.title}
							</div>
							{item.description && (
								<div
									style={{
										fontSize: "0.75rem",
										color: "#71717a",
										marginTop: "2px",
										whiteSpace: "nowrap",
										overflow: "hidden",
										textOverflow: "ellipsis",
									}}
								>
									{item.description}
								</div>
							)}
						</div>
						<span
							style={{
								fontSize: "0.75rem",
								color: "#52525b",
								flexShrink: 0,
								whiteSpace: "nowrap",
							}}
						>
							{timeAgo(item.timestamp)}
						</span>
					</div>
				);
			})}
		</div>
	);
};
