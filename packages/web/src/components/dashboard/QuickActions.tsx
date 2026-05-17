import type React from "react";
import { AppIcon, type AppIconName } from "../ui/AppIcon.js";

interface QuickAction {
	icon: AppIconName;
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
	onViewTasks: () => void;
	onViewTools: () => void;
	onViewVariables: () => void;
	onViewAutomations: () => void;
	onViewMemory: () => void;
	onViewSkills: () => void;
	onViewMedia: () => void;
}

export const QuickActions: React.FC<QuickActionsProps> = ({
	onNewChat,
	onViewAgents,
	onViewSettings,
	onViewChannels,
	onViewTasks,
	onViewTools,
	onViewVariables,
	onViewAutomations,
	onViewMemory,
	onViewSkills,
	onViewMedia,
}) => {
	const actions: QuickAction[] = [
		{
			icon: "chat",
			label: "Nuevo Chat",
			description: "Inicia una nueva conversación",
			onClick: onNewChat,
			color: "#6366f1",
		},
		{
			icon: "agent",
			label: "Ver Agentes",
			description: "Gestiona tus agentes IA",
			onClick: onViewAgents,
			color: "#10b981",
		},
		{
			icon: "globe",
			label: "Canales",
			description: "Configura canales de comunicación",
			onClick: onViewChannels,
			color: "#3b82f6",
		},
		{
			icon: "check",
			label: "Tareas",
			description: "Planifica trabajo para agentes",
			onClick: onViewTasks,
			color: "#38bdf8",
		},
		{
			icon: "tools",
			label: "Herramientas",
			description: "Revisa inventario y MCP",
			onClick: onViewTools,
			color: "#a78bfa",
		},
		{
			icon: "automation",
			label: "Automatizaciones",
			description: "Programa flujos y webhooks",
			onClick: onViewAutomations,
			color: "#f59e0b",
		},
		{
			icon: "brain",
			label: "Memoria",
			description: "Consulta contexto y perfil",
			onClick: onViewMemory,
			color: "#818cf8",
		},
		{
			icon: "spark",
			label: "Habilidades",
			description: "Gestiona skills del agente",
			onClick: onViewSkills,
			color: "#c084fc",
		},
		{
			icon: "folder",
			label: "Medios",
			description: "Sube y revisa archivos",
			onClick: onViewMedia,
			color: "#38bdf8",
		},
		{
			icon: "key",
			label: "Variables",
			description: "Gestiona secretos y API keys",
			onClick: onViewVariables,
			color: "#fb7185",
		},
		{
			icon: "settings",
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
					<span style={{ color: action.color, flexShrink: 0 }}>
						<AppIcon name={action.icon} size={24} />
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
