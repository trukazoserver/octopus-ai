import type React from "react";
import { useEffect, useState } from "react";
import { AppIcon, type AppIconName } from "../components/ui/AppIcon.js";
import { ToastContainer } from "../components/ui/Toast.js";
import { AgentsPage } from "../pages/agents.js";
import { AutomationsPage } from "../pages/automations.js";
import { ChannelsPage } from "../pages/channels/Channels.js";
import { ChatPage } from "../pages/chat.js";
import { DashboardPage } from "../pages/dashboard/Dashboard.js";
import { MediaLibraryPage } from "../pages/media-library.js";
import { MemoryPage } from "../pages/memory.js";
import { SettingsPage } from "../pages/settings.js";
import { SkillsPage } from "../pages/skills.js";
import { TasksPage } from "../pages/tasks.js";
import { ToolsPage } from "../pages/tools.js";
import { VariablesPage } from "../pages/variables.js";
import "./app.css";

type TabId =
	| "dashboard"
	| "chat"
	| "channels"
	| "variables"
	| "media"
	| "tools"
	| "memory"
	| "skills"
	| "agents"
	| "tasks"
	| "automations"
	| "settings";

interface NavGroup {
	label: string;
	items: Array<{ id: TabId; icon: AppIconName; label: string }>;
}

const NAV_GROUPS: NavGroup[] = [
	{
		label: "Principal",
		items: [
			{ id: "dashboard", icon: "home", label: "Centro de Control" },
			{ id: "chat", icon: "chat", label: "Chat" },
		],
	},
	{
		label: "Comunicación",
		items: [{ id: "channels", icon: "message", label: "Canales" }],
	},
	{
		label: "Producción",
		items: [
			{ id: "agents", icon: "agent", label: "Agentes" },
			{ id: "tasks", icon: "check", label: "Tareas" },
			{ id: "automations", icon: "automation", label: "Automatizaciones" },
			{ id: "tools", icon: "tools", label: "Herramientas" },
		],
	},
	{
		label: "Conocimiento",
		items: [
			{ id: "memory", icon: "brain", label: "Base de Memoria" },
			{ id: "skills", icon: "spark", label: "Habilidades" },
		],
	},
	{
		label: "Sistema",
		items: [
			{ id: "media", icon: "folder", label: "Medios" },
			{ id: "variables", icon: "key", label: "Variables" },
			{ id: "settings", icon: "settings", label: "Configuración" },
		],
	},
];

export const App: React.FC = () => {
	const [activeTab, setActiveTab] = useState<TabId>(() => {
		try {
			const stored = localStorage.getItem("octopus-active-tab");
			if (stored && stored === "code") {
				return "tools";
			}
			if (
				stored &&
				NAV_GROUPS.some((group) =>
					group.items.some((item) => item.id === stored),
				)
			) {
				return stored as TabId;
			}
		} catch {
			// ignore storage failures
		}
		return "dashboard";
	});
	const [menuOpen, setMenuOpen] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
		new Set(),
	);

	const selectTab = (tab: TabId) => {
		setActiveTab(tab);
		setMenuOpen(false);
	};

	const toggleGroup = (label: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(label)) next.delete(label);
			else next.add(label);
			return next;
		});
	};

	useEffect(() => {
		try {
			localStorage.setItem("octopus-active-tab", activeTab);
		} catch {
			// ignore storage failures
		}
	}, [activeTab]);

	const renderPage = () => {
		switch (activeTab) {
			case "dashboard":
				return <DashboardPage onNavigate={(tab) => selectTab(tab as TabId)} />;
			case "channels":
				return <ChannelsPage />;
			case "tools":
				return <ToolsPage />;
			case "memory":
				return <MemoryPage />;
			case "skills":
				return <SkillsPage />;
			case "agents":
				return <AgentsPage />;
			case "tasks":
				return <TasksPage />;
			case "automations":
				return <AutomationsPage />;
			case "media":
				return <MediaLibraryPage />;
			case "variables":
				return <VariablesPage />;
			case "settings":
				return <SettingsPage />;
			default:
				if (activeTab !== "chat") {
					return (
						<DashboardPage onNavigate={(tab) => selectTab(tab as TabId)} />
					);
				}
				return null;
		}
	};

	return (
		<div className="app-shell">
			<header className="app-mobile-header">
				<button
					type="button"
					className="app-icon-button"
					onClick={() => setMenuOpen((o) => !o)}
					aria-label="Abrir navegación"
				>
					<AppIcon name="menu" size={20} />
				</button>
				<div className="app-mobile-brand">
					<div className="app-logo">
						<img src="/logo_Pulpo_octavio.png" alt="Octopus AI" />
					</div>
					<div>
						<div className="app-brand-title">Octopus AI</div>
						<div className="app-brand-subtitle">Workspace v0.1.0</div>
					</div>
				</div>
			</header>

			{menuOpen && (
				<button
					type="button"
					className="app-overlay"
					onClick={() => setMenuOpen(false)}
					aria-label="Cerrar navegación"
				/>
			)}

			{activeTab !== "chat" && (
				<aside className={`app-sidebar${menuOpen ? " is-open" : ""}`}>
					<div className="app-sidebar-header">
						<div className="app-logo">
							<img src="/logo_Pulpo_octavio.png" alt="Octopus AI" />
						</div>
						<div>
							<div className="app-brand-title">Octopus AI</div>
							<div className="app-brand-subtitle">Workspace v0.1.0</div>
						</div>
					</div>

					<nav className="app-nav">
						{NAV_GROUPS.map((group) => (
							<div key={group.label} className="app-nav-group">
								<button
									type="button"
									className="app-nav-group-title"
									onClick={() => toggleGroup(group.label)}
								>
									<span>{group.label}</span>
									<span className="app-nav-group-toggle">
										<AppIcon
											name={
												collapsedGroups.has(group.label)
													? "chevronRight"
													: "chevronDown"
											}
											size={12}
										/>
									</span>
								</button>
								{!collapsedGroups.has(group.label) && (
									<div className="app-nav-group-items">
										{group.items.map((item) => (
											<button
												key={item.id}
												type="button"
												onClick={() => selectTab(item.id)}
												className={`app-nav-item${activeTab === item.id ? " is-active" : ""}`}
											>
												<span className="app-nav-icon" aria-hidden="true">
													<AppIcon name={item.icon} size={15} />
												</span>
												<span>{item.label}</span>
											</button>
										))}
									</div>
								)}
							</div>
						))}
					</nav>

					<div className="app-user-card">
						<div className="app-user-avatar">U</div>
						<div>
							<div className="app-user-name">Usuario Local</div>
							<div className="app-user-role">Auto-hospedado</div>
						</div>
					</div>
				</aside>
			)}

			<main className="app-main">
				<div
					style={{
						height: "100%",
						display: activeTab === "chat" ? "flex" : "none",
						flexDirection: "column",
					}}
				>
					<ChatPage onNavigate={(tab) => selectTab(tab as TabId)} />
				</div>
				{activeTab !== "chat" && (
					<div
						className="animate-fade-in"
						key={activeTab}
						style={{ height: "100%", display: "flex", flexDirection: "column" }}
					>
						{renderPage()}
					</div>
				)}
			</main>

			<ToastContainer />
		</div>
	);
};
