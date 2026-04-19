import type React from "react";
import { useState } from "react";
import { Agents } from "../pages/agents.js";
import { Automations } from "../pages/automations.js";
import { Chat } from "../pages/chat.js";
import { Memory } from "../pages/memory.js";
import { Plugins } from "../pages/plugins.js";
import { Settings } from "../pages/settings.js";
import { Tasks } from "../pages/tasks.js";

type TabId =
	| "chat"
	| "memory"
	| "plugins"
	| "agents"
	| "tasks"
	| "automations"
	| "settings";

interface NavGroup {
	label: string;
	items: Array<{ id: TabId; label: string; icon: string }>;
}

const NAV_GROUPS: NavGroup[] = [
	{
		label: "Chat",
		items: [{ id: "chat", label: "Chat", icon: "\u{1F4AC}" }],
	},
	{
		label: "Work",
		items: [
			{ id: "agents", label: "Agentes", icon: "\u{1F916}" },
			{ id: "tasks", label: "Tareas", icon: "\u2705" },
			{ id: "automations", label: "Automatizaciones", icon: "\u26A1" },
			{ id: "plugins", label: "Skills & Tools", icon: "\u{1F527}" },
		],
	},
	{
		label: "Data",
		items: [{ id: "memory", label: "Memoria", icon: "\u{1F9E0}" }],
	},
	{
		label: "Config",
		items: [
			{ id: "settings", label: "Configuraci\u00f3n", icon: "\u2699\uFE0F" },
		],
	},
];

const navItemStyle = (active: boolean): React.CSSProperties => ({
	padding: "10px 12px",
	borderRadius: "8px",
	border: "none",
	cursor: "pointer",
	backgroundColor: active ? "#1e1e2e" : "transparent",
	color: active ? "#e4e4e7" : "#71717a",
	fontSize: "13px",
	textAlign: "left" as const,
	display: "flex",
	alignItems: "center",
	gap: "10px",
	width: "100%",
	transition: "all 0.15s",
});

export const App: React.FC = () => {
	const [activeTab, setActiveTab] = useState<TabId>("chat");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
		new Set(),
	);

	const toggleGroup = (label: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(label)) next.delete(label);
			else next.add(label);
			return next;
		});
	};

	const renderContent = () => {
		switch (activeTab) {
			case "chat":
				return <Chat />;
			case "memory":
				return <Memory />;
			case "plugins":
				return <Plugins />;
			case "settings":
				return <Settings />;
			case "agents":
				return <Agents />;
			case "tasks":
				return <Tasks />;
			case "automations":
				return <Automations />;
			default:
				return <Chat />;
		}
	};

	return (
		<div
			style={{
				display: "flex",
				height: "100vh",
				fontFamily: "Inter, system-ui, -apple-system, sans-serif",
				backgroundColor: "#0f1117",
			}}
		>
			<div
				style={{
					width: "240px",
					backgroundColor: "#09090b",
					borderRight: "1px solid #1e1e2e",
					display: "flex",
					flexDirection: "column",
				}}
			>
				<div
					style={{
						padding: "20px 16px",
						borderBottom: "1px solid #1e1e2e",
						display: "flex",
						alignItems: "center",
						gap: "10px",
					}}
				>
					<div
						style={{
							width: "32px",
							height: "32px",
							borderRadius: "8px",
							backgroundColor: "#3b82f6",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: "16px",
							fontWeight: 700,
							color: "#fff",
						}}
					>
						O
					</div>
					<div>
						<div
							style={{ fontWeight: 700, fontSize: "15px", color: "#e4e4e7" }}
						>
							Octopus AI
						</div>
						<div style={{ fontSize: "10px", color: "#52525b" }}>v0.1.0</div>
					</div>
				</div>

				<div
					style={{
						flex: 1,
						padding: "8px",
						display: "flex",
						flexDirection: "column",
						gap: "4px",
						overflowY: "auto",
					}}
				>
					{NAV_GROUPS.map((group) => (
						<div key={group.label}>
							<button
								type="button"
								onClick={() => toggleGroup(group.label)}
								style={{
									padding: "8px 12px 4px",
									fontSize: "10px",
									textTransform: "uppercase",
									color: "#52525b",
									fontWeight: 700,
									letterSpacing: "0.05em",
									background: "transparent",
									border: "none",
									cursor: "pointer",
									width: "100%",
									textAlign: "left" as const,
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
								}}
							>
								<span>{group.label}</span>
								<span style={{ fontSize: "8px" }}>
									{collapsedGroups.has(group.label) ? "\u25B6" : "\u25BC"}
								</span>
							</button>
							{!collapsedGroups.has(group.label) &&
								group.items.map((item) => (
									<button
										key={item.id}
										type="button"
										onClick={() => setActiveTab(item.id)}
										style={navItemStyle(activeTab === item.id)}
									>
										<span style={{ fontSize: "16px" }}>{item.icon}</span>
										{item.label}
									</button>
								))}
						</div>
					))}
				</div>
			</div>

			<div style={{ flex: 1, overflow: "hidden" }}>{renderContent()}</div>
		</div>
	);
};
