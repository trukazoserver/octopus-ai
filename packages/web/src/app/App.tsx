import type React from "react";
import { useEffect, useState } from "react";
import { ToastContainer } from "../components/ui/Toast.js";
import { AgentsPage } from "../pages/agents.js";
import { AutomationsPage } from "../pages/automations.js";
import { ChannelsPage } from "../pages/channels/Channels.js";
import { ChatPage } from "../pages/chat.js";
import { CodePage } from "../pages/code.js";
import { DashboardPage } from "../pages/dashboard/Dashboard.js";
import { MediaLibraryPage } from "../pages/media-library.js";
import { MemoryPage } from "../pages/memory.js";
import { SettingsPage } from "../pages/settings.js";
import { SkillsPage } from "../pages/skills.js";
import { TasksPage } from "../pages/tasks.js";
import { VariablesPage } from "../pages/variables.js";
import "./app.css";

type TabId =
	| "dashboard"
	| "chat"
	| "channels"
	| "variables"
	| "media"
	| "code"
	| "memory"
	| "skills"
	| "agents"
	| "tasks"
	| "automations"
	| "settings";

interface NavGroup {
	label: string;
	items: Array<{ id: TabId; icon: string; label: string }>;
}

const NAV_GROUPS: NavGroup[] = [
	{
		label: "Principal",
		items: [
			{ id: "dashboard", icon: "🎛️", label: "Centro de Control" },
			{ id: "chat", icon: "💬", label: "Chat" },
		],
	},
	{
		label: "Comunicación",
		items: [{ id: "channels", icon: "📡", label: "Canales" }],
	},
	{
		label: "Work",
		items: [
			{ id: "agents", icon: "🤖", label: "Agentes" },
			{ id: "tasks", icon: "✅", label: "Tareas" },
			{ id: "automations", icon: "⚡", label: "Automatizaciones" },
			{ id: "code", icon: "💻", label: "Código & Tools" },
		],
	},
	{
		label: "Data",
		items: [
			{ id: "memory", icon: "🧠", label: "Base de Memoria" },
			{ id: "skills", icon: "⚡", label: "Habilidades" },
		],
	},
	{
		label: "Config",
		items: [
			{ id: "media", icon: "📁", label: "Medios" },
			{ id: "variables", icon: "🔐", label: "Variables" },
			{ id: "settings", icon: "⚙️", label: "Configuración" },
		],
	},
];

export const App: React.FC = () => {
	const [activeTab, setActiveTab] = useState<TabId>(() => {
		try {
			const stored = localStorage.getItem("octopus-active-tab");
			if (stored && NAV_GROUPS.some((group) => group.items.some((item) => item.id === stored))) {
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
			case "chat":
				return <ChatPage />;
			case "code":
				return <CodePage />;
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
				return <DashboardPage onNavigate={(tab) => selectTab(tab as TabId)} />;
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
					☰
				</button>
				<div className="app-mobile-brand">
					<div className="app-logo">🐙</div>
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

			<aside className={`app-sidebar${menuOpen ? " is-open" : ""}`}>
				<div className="app-sidebar-header">
					<div className="app-logo">🐙</div>
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
									{collapsedGroups.has(group.label) ? "▶" : "▼"}
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
												{item.icon}
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
					<div className="app-user-avatar">👤</div>
					<div>
						<div className="app-user-name">Usuario Local</div>
						<div className="app-user-role">Auto-hospedado</div>
					</div>
				</div>
			</aside>

			<main className="app-main">
				<div
					className="animate-fade-in"
					key={activeTab}
					style={{ height: "100%", display: "flex", flexDirection: "column" }}
				>
					{renderPage()}
				</div>
			</main>

			<ToastContainer />
		</div>
	);
};
