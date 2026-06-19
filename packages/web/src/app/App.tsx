import type React from "react";
import { Suspense, lazy, useEffect, useState } from "react";
import { AppIcon, type AppIconName } from "../components/ui/AppIcon.js";
import { ToastContainer } from "../components/ui/Toast.js";
import { publicAsset } from "../utils/assets.js";
import "./app.css";

const LOGO_SRC = publicAsset("mascotas/Pulpo_octavio.png");

const AgentsPage = lazy(() =>
	import("../pages/agents.js").then(({ AgentsPage }) => ({
		default: AgentsPage,
	})),
);
const AutomationsPage = lazy(() =>
	import("../pages/automations.js").then(({ AutomationsPage }) => ({
		default: AutomationsPage,
	})),
);
const ChannelsPage = lazy(() =>
	import("../pages/channels/Channels.js").then(({ ChannelsPage }) => ({
		default: ChannelsPage,
	})),
);
const ChatPage = lazy(() =>
	import("../pages/chat.js").then(({ ChatPage }) => ({ default: ChatPage })),
);
const DashboardPage = lazy(() =>
	import("../pages/dashboard/Dashboard.js").then(({ DashboardPage }) => ({
		default: DashboardPage,
	})),
);
const MemoryPage = lazy(() =>
	import("../pages/memory.js").then(({ MemoryPage }) => ({
		default: MemoryPage,
	})),
);
const SettingsPage = lazy(() =>
	import("../pages/settings.js").then(({ SettingsPage }) => ({
		default: SettingsPage,
	})),
);
const SkillsPage = lazy(() =>
	import("../pages/skills.js").then(({ SkillsPage }) => ({
		default: SkillsPage,
	})),
);
const TasksPage = lazy(() =>
	import("../pages/tasks.js").then(({ TasksPage }) => ({ default: TasksPage })),
);
const ToolsPage = lazy(() =>
	import("../pages/tools.js").then(({ ToolsPage }) => ({ default: ToolsPage })),
);
const VariablesPage = lazy(() =>
	import("../pages/variables.js").then(({ VariablesPage }) => ({
		default: VariablesPage,
	})),
);

type TabId =
	| "dashboard"
	| "chat"
	| "channels"
	| "variables"
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

type ChatWorkspaceView = "chat" | "media";

interface DesktopWindowApi {
	minimize?: () => void;
	maximize?: () => void;
	close?: () => void;
}

interface ChatWorkspaceRequest {
	id: number;
	view: ChatWorkspaceView;
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
			{ id: "tasks", icon: "check", label: "Tablero de Tareas" },
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
			{ id: "variables", icon: "key", label: "Variables" },
			{ id: "settings", icon: "settings", label: "Configuración" },
		],
	},
];

const PageLoading: React.FC = () => (
	<div
		style={{
			height: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			color: "var(--text-muted)",
		}}
	>
		Cargando...
	</div>
);

function getDesktopWindowApi(): DesktopWindowApi | undefined {
	return (window as unknown as { octopus?: DesktopWindowApi }).octopus;
}

function isTabId(tab: string): tab is TabId {
	return NAV_GROUPS.some((group) =>
		group.items.some((item) => item.id === tab),
	);
}

export const App: React.FC = () => {
	const desktopWindow = getDesktopWindowApi();
	const isDesktop = Boolean(desktopWindow);
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
	const [chatLoaded, setChatLoaded] = useState(activeTab === "chat");
	const [chatWorkspaceRequest, setChatWorkspaceRequest] =
		useState<ChatWorkspaceRequest>({ id: 0, view: "chat" });

	const selectTab = (tab: TabId) => {
		if (tab === "chat") {
			setChatWorkspaceRequest((prev) => ({ id: prev.id + 1, view: "chat" }));
		}
		setActiveTab(tab);
		setMenuOpen(false);
	};

	const selectDestination = (tab: string) => {
		if (tab === "media") {
			setChatWorkspaceRequest((prev) => ({ id: prev.id + 1, view: "media" }));
			setActiveTab("chat");
			setMenuOpen(false);
			return;
		}

		if (isTabId(tab)) selectTab(tab);
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

	useEffect(() => {
		if (activeTab === "chat") setChatLoaded(true);
	}, [activeTab]);

	useEffect(() => {
		const updateTooltipPosition = (event: PointerEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			const tooltipElement = target?.closest<HTMLElement>("[data-tooltip]");
			if (!tooltipElement) return;

			const rect = tooltipElement.getBoundingClientRect();
			const viewportPadding = 12;
			const estimatedTooltipHalfWidth = Math.min(
				130,
				Math.max(80, window.innerWidth * 0.4),
			);
			const minX = viewportPadding + estimatedTooltipHalfWidth;
			const maxX =
				window.innerWidth - viewportPadding - estimatedTooltipHalfWidth;
			const x = Math.max(minX, Math.min(maxX, rect.left + rect.width / 2));
			const placeBelow = rect.top < 48;
			const y = placeBelow ? rect.bottom : rect.top;

			tooltipElement.dataset.tooltipPlacement = placeBelow ? "bottom" : "top";
			tooltipElement.style.setProperty("--tooltip-x", `${x}px`);
			tooltipElement.style.setProperty("--tooltip-y", `${y}px`);
		};

		window.addEventListener("pointerover", updateTooltipPosition, {
			passive: true,
		});
		window.addEventListener("pointermove", updateTooltipPosition, {
			passive: true,
		});
		return () => {
			window.removeEventListener("pointerover", updateTooltipPosition);
			window.removeEventListener("pointermove", updateTooltipPosition);
		};
	}, []);

	const renderPage = () => {
		switch (activeTab) {
			case "dashboard":
				return <DashboardPage onNavigate={selectDestination} />;
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
			case "variables":
				return <VariablesPage />;
			case "settings":
				return <SettingsPage />;
			default:
				if (activeTab !== "chat") {
					return <DashboardPage onNavigate={selectDestination} />;
				}
				return null;
		}
	};

	return (
		<div className={`app-shell${isDesktop ? " is-electron" : ""}`}>
			{isDesktop && (
				<div className="app-electron-titlebar">
					<div className="app-electron-titlebar-drag" />
					<div className="app-electron-controls">
						<button
							type="button"
							className="app-electron-control"
							aria-label="Minimizar ventana"
							onClick={() => desktopWindow?.minimize?.()}
						>
							<span aria-hidden="true">-</span>
						</button>
						<button
							type="button"
							className="app-electron-control"
							aria-label="Maximizar ventana"
							onClick={() => desktopWindow?.maximize?.()}
						>
							<span aria-hidden="true">□</span>
						</button>
						<button
							type="button"
							className="app-electron-control is-close"
							aria-label="Cerrar ventana"
							onClick={() => desktopWindow?.close?.()}
						>
							<span aria-hidden="true">×</span>
						</button>
					</div>
				</div>
			)}
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
						<img src={LOGO_SRC} alt="Octopus AI" />
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
							<img src={LOGO_SRC} alt="Octopus AI" />
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
				{chatLoaded && (
					<div
						style={{
							height: "100%",
							display: activeTab === "chat" ? "flex" : "none",
							flexDirection: "column",
						}}
					>
						<Suspense fallback={<PageLoading />}>
							<ChatPage
								onNavigate={selectDestination}
								workspaceRequest={chatWorkspaceRequest}
							/>
						</Suspense>
					</div>
				)}
				{activeTab !== "chat" && (
					<div
						className="animate-fade-in"
						key={activeTab}
						style={{ height: "100%", display: "flex", flexDirection: "column" }}
					>
						<Suspense fallback={<PageLoading />}>{renderPage()}</Suspense>
					</div>
				)}
			</main>

			<ToastContainer />
		</div>
	);
};
