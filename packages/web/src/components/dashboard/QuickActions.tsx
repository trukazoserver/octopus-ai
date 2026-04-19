import type React from "react";

interface QuickAction {
	icon: string;
	label: string;
	description: string;
	onClick: () => void;
	color: string;
}

interface QuickActionsProps {
	onNewChat: () => void;
	onViewAgents: () => void;
	onViewSettings: () => void;
	onViewChannels: () => void;
}

export const QuickActions: React.FC<QuickActionsProps> = ({
	onNewChat,
	onViewAgents,
	onViewSettings,
	onViewChannels,
}) => {
	const actions: QuickAction[] = [
		{
			icon: "💬",
			label: "Nuevo Chat",
			description: "Inicia una nueva conversación",
			onClick: onNewChat,
			color: "#6366f1",
		},
		{
			icon: "🤖",
			label: "Ver Agentes",
			description: "Gestiona tus agentes IA",
			onClick: onViewAgents,
			color: "#10b981",
		},
		{
			icon: "📡",
			label: "Canales",
			description: "Configura canales de comunicación",
			onClick: onViewChannels,
			color: "#3b82f6",
		},
		{
			icon: "⚙️",
			label: "Configuración",
			description: "Ajusta tu workspace",
			onClick: onViewSettings,
			color: "#f59e0b",
		},
	];

	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
				gap: "12px",
			}}
		>
			{actions.map((action, i) => (
				<button
					key={action.label}
					type="button"
					className="animate-slide-up"
					onClick={action.onClick}
					style={{
						display: "flex",
						alignItems: "center",
						gap: "14px",
						padding: "16px 18px",
						background: "rgba(24, 24, 27, 0.5)",
						border: "1px solid #27272a",
						borderRadius: "14px",
						color: "#f4f4f5",
						cursor: "pointer",
						textAlign: "left",
						fontFamily: "inherit",
						transition: "all 0.2s ease",
						animationDelay: `${i * 60}ms`,
						animationFillMode: "both",
					}}
					onMouseEnter={(e) => {
						e.currentTarget.style.background = "#27272a";
						e.currentTarget.style.borderColor = `${action.color}40`;
						e.currentTarget.style.transform = "translateY(-2px)";
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.background = "rgba(24, 24, 27, 0.5)";
						e.currentTarget.style.borderColor = "#27272a";
						e.currentTarget.style.transform = "translateY(0)";
					}}
				>
					<span style={{ fontSize: "1.5rem", flexShrink: 0 }}>
						{action.icon}
					</span>
					<div>
						<div
							style={{ fontSize: "0.9rem", fontWeight: 600, color: "#f4f4f5" }}
						>
							{action.label}
						</div>
						<div
							style={{
								fontSize: "0.75rem",
								color: "#71717a",
								marginTop: "2px",
							}}
						>
							{action.description}
						</div>
					</div>
				</button>
			))}
		</div>
	);
};
