import type React from "react";
import { useState } from "react";
import { ChatPage } from "../pages/chat.js";
import { MemoryPage } from "../pages/memory.js";
import { SettingsPage } from "../pages/settings.js";
import { SkillsPage } from "../pages/skills.js";

export const App: React.FC = () => {
	const [activeTab, setActiveTab] = useState("chat");

	return (
		<div
			style={{
				display: "flex",
				height: "100vh",
				background: "#09090b",
				color: "#fafafa",
				fontFamily: '"Inter", -apple-system, sans-serif'
			}}
		>
			{/* Sidebar */}
			<div
				style={{
					width: "280px",
					background: "#18181b",
					borderRight: "1px solid #27272a",
					display: "flex",
					flexDirection: "column",
				}}
			>
				<div
					style={{
						padding: "24px 20px",
						display: "flex",
						alignItems: "center",
						gap: "14px",
					}}
				>
					<div
						style={{
							width: "40px",
							height: "40px",
							borderRadius: "12px",
							background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							fontSize: "20px",
							boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)",
						}}
					>
						🐙
					</div>
					<div>
						<div style={{ fontSize: "1.2rem", fontWeight: 700, color: "#f4f4f5", letterSpacing: "-0.02em" }}>
							Octopus AI
						</div>
						<div style={{ fontSize: "0.75rem", color: "#a1a1aa", fontWeight: 500 }}>
							Workspace v0.1.0
						</div>
					</div>
				</div>

				<div style={{ padding: "0 16px", marginBottom: "16px" }}>
					<button
						onClick={() => setActiveTab("chat")}
						style={{
							width: "100%",
							padding: "12px 16px",
							background: "#27272a",
							border: "1px solid #3f3f46",
							borderRadius: "8px",
							color: "#f4f4f5",
							fontWeight: 500,
							display: "flex",
							alignItems: "center",
							gap: "8px",
							cursor: "pointer",
							transition: "all 0.2s",
						}}
						onMouseOver={(e) => (e.currentTarget.style.background = "#3f3f46")}
						onMouseOut={(e) => (e.currentTarget.style.background = "#27272a")}
					>
						<span style={{ fontSize: "1.2rem" }}>+</span> Nuevo Chat
					</button>
				</div>

				<nav
					style={{
						display: "flex",
						flexDirection: "column",
						padding: "0 12px",
						gap: "4px",
						flex: 1,
					}}
				>
					<div style={{ padding: "12px 12px 4px", fontSize: "0.7rem", textTransform: "uppercase", color: "#71717a", fontWeight: 600, letterSpacing: "0.05em" }}>
						Menú Principal
					</div>
					{[
						{ id: "chat", icon: "💬", label: "Conversación" },
						{ id: "memory", icon: "🧠", label: "Base de Memoria" },
						{ id: "skills", icon: "⚡", label: "Habilidades (Skills)" },
						{ id: "settings", icon: "⚙️", label: "Configuración" },
					].map((item) => (
						<button
							key={item.id}
							onClick={() => setActiveTab(item.id)}
							style={{
								padding: "10px 14px",
								textAlign: "left",
								border: "none",
								borderRadius: "8px",
								background:
									activeTab === item.id
										? "rgba(99, 102, 241, 0.15)"
										: "transparent",
								color: activeTab === item.id ? "#818cf8" : "#a1a1aa",
								cursor: "pointer",
								fontSize: "0.9rem",
								display: "flex",
								alignItems: "center",
								gap: "12px",
								transition: "all 0.2s",
								fontWeight: activeTab === item.id ? 600 : 400,
							}}
							onMouseOver={(e) => {
								if (activeTab !== item.id) {
									e.currentTarget.style.background = "#27272a";
									e.currentTarget.style.color = "#e4e4e7";
								}
							}}
							onMouseOut={(e) => {
								if (activeTab !== item.id) {
									e.currentTarget.style.background = "transparent";
									e.currentTarget.style.color = "#a1a1aa";
								}
							}}
						>
							<span style={{ fontSize: "1.2rem", filter: activeTab !== item.id ? "grayscale(100%) opacity(70%)" : "none" }}>{item.icon}</span>
							{item.label}
						</button>
					))}
				</nav>

				<div
					style={{
						padding: "20px",
						borderTop: "1px solid #27272a",
						display: "flex",
						alignItems: "center",
						gap: "12px",
					}}
				>
					<div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "#3f3f46", display: "flex", alignItems: "center", justifyContent: "center" }}>
						👤
					</div>
					<div style={{ flex: 1 }}>
						<div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#e4e4e7" }}>Usuario Local</div>
						<div style={{ fontSize: "0.75rem", color: "#71717a" }}>Auto-hospedado</div>
					</div>
				</div>
			</div>

			{/* Main Content */}
			<div
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
					background: "#09090b",
				}}
			>
				{activeTab === "chat" && <ChatPage />}
				{activeTab === "memory" && <MemoryPage />}
				{activeTab === "skills" && <SkillsPage />}
				{activeTab === "settings" && <SettingsPage />}
			</div>
		</div>
	);
};