import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../hooks/useApi.js";

interface LoadedPlugin {
	name: string;
	version: string;
	description: string;
}

interface DynamicTool {
	name: string;
	version: string;
	description: string;
	language: string;
	type: string;
	createdAt: string;
}

export const Plugins: React.FC = () => {
	const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
	const [dynamicTools, setDynamicTools] = useState<DynamicTool[]>([]);
	const [loading, setLoading] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeTab, setActiveTab] = useState<"plugins" | "tools">("plugins");

	const loadData = useCallback(async () => {
		setLoading(true);
		try {
			const [pluginsData, toolsData] = await Promise.all([
				apiGet<{ loaded: LoadedPlugin[] }>("/api/plugins"),
				apiGet<{ tools: DynamicTool[] }>("/api/code/tools"),
			]);
			setPlugins(pluginsData.loaded ?? []);
			setDynamicTools(toolsData.tools ?? []);
		} catch {
			// Server not available
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadData();
	}, [loadData]);

	const filteredPlugins = plugins.filter((p) => {
		if (!searchQuery) return true;
		const q = searchQuery.toLowerCase();
		return (
			p.name.toLowerCase().includes(q) ||
			p.description.toLowerCase().includes(q)
		);
	});

	const filteredTools = dynamicTools.filter((t) => {
		if (!searchQuery) return true;
		const q = searchQuery.toLowerCase();
		return (
			t.name.toLowerCase().includes(q) ||
			t.description.toLowerCase().includes(q)
		);
	});

	return (
		<div
			style={{
				padding: "24px",
				backgroundColor: "#0f1117",
				color: "#e4e4e7",
				height: "100%",
				fontFamily: "Inter, system-ui, sans-serif",
				overflowY: "auto",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "24px",
				}}
			>
				<div>
					<h2 style={{ margin: "0 0 4px 0", fontSize: "20px" }}>
						Skills & Tools
					</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						Manage plugins and dynamically created tools
					</p>
				</div>
				<input
					type="text"
					placeholder="Search..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					style={{
						padding: "8px 12px",
						borderRadius: "8px",
						border: "1px solid #27272a",
						backgroundColor: "#18181b",
						color: "#e4e4e7",
						fontSize: "13px",
						width: "250px",
						outline: "none",
					}}
				/>
			</div>

			<div
				style={{
					display: "flex",
					gap: "8px",
					marginBottom: "20px",
					borderBottom: "1px solid #27272a",
					paddingBottom: "12px",
				}}
			>
				<button
					type="button"
					onClick={() => setActiveTab("plugins")}
					style={{
						padding: "8px 16px",
						borderRadius: "8px",
						fontSize: "13px",
						border: "none",
						cursor: "pointer",
						backgroundColor:
							activeTab === "plugins" ? "#3b82f6" : "transparent",
						color: activeTab === "plugins" ? "#fff" : "#71717a",
					}}
				>
					Plugins ({plugins.length})
				</button>
				<button
					type="button"
					onClick={() => setActiveTab("tools")}
					style={{
						padding: "8px 16px",
						borderRadius: "8px",
						fontSize: "13px",
						border: "none",
						cursor: "pointer",
						backgroundColor: activeTab === "tools" ? "#3b82f6" : "transparent",
						color: activeTab === "tools" ? "#fff" : "#71717a",
					}}
				>
					Dynamic Tools ({dynamicTools.length})
				</button>
				<button
					type="button"
					onClick={loadData}
					disabled={loading}
					style={{
						padding: "8px 16px",
						borderRadius: "8px",
						fontSize: "13px",
						border: "none",
						cursor: "pointer",
						backgroundColor: "#27272a",
						color: "#a1a1aa",
						marginLeft: "auto",
					}}
				>
					{loading ? "Loading..." : "Refresh"}
				</button>
			</div>

			{activeTab === "plugins" && (
				<div style={{ display: "grid", gap: "8px" }}>
					{filteredPlugins.length > 0 ? (
						filteredPlugins.map((plugin) => (
							<div
								key={plugin.name}
								style={{
									padding: "16px",
									backgroundColor: "#18181b",
									borderRadius: "8px",
									border: "1px solid #27272a",
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
								}}
							>
								<div>
									<div style={{ fontWeight: 600, fontSize: "14px" }}>
										{plugin.name}
									</div>
									<div style={{ color: "#71717a", fontSize: "12px" }}>
										{plugin.description}
									</div>
								</div>
								<span style={{ fontSize: "12px", color: "#52525b" }}>
									v{plugin.version}
								</span>
							</div>
						))
					) : (
						<p
							style={{ color: "#52525b", textAlign: "center", padding: "40px" }}
						>
							{loading
								? "Loading..."
								: "No plugins loaded. Start the server to load plugins."}
						</p>
					)}
				</div>
			)}

			{activeTab === "tools" && (
				<div style={{ display: "grid", gap: "8px" }}>
					{filteredTools.length > 0 ? (
						filteredTools.map((tool) => (
							<div
								key={tool.name}
								style={{
									padding: "16px",
									backgroundColor: "#18181b",
									borderRadius: "8px",
									border: "1px solid #27272a",
								}}
							>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										marginBottom: "8px",
									}}
								>
									<span style={{ fontWeight: 600, fontSize: "14px" }}>
										{tool.name}
									</span>
									<div style={{ display: "flex", gap: "8px" }}>
										<span
											style={{
												fontSize: "11px",
												padding: "2px 8px",
												borderRadius: "4px",
												backgroundColor: "#1e1b4b",
												color: "#a78bfa",
											}}
										>
											{tool.language}
										</span>
										<span
											style={{
												fontSize: "11px",
												padding: "2px 8px",
												borderRadius: "4px",
												backgroundColor: "#1a2e05",
												color: "#84cc16",
											}}
										>
											v{tool.version}
										</span>
									</div>
								</div>
								<div style={{ color: "#71717a", fontSize: "12px" }}>
									{tool.description}
								</div>
								<div
									style={{
										color: "#3f3f46",
										fontSize: "11px",
										marginTop: "4px",
									}}
								>
									Created:{" "}
									{tool.createdAt
										? new Date(tool.createdAt).toLocaleDateString()
										: "Unknown"}
								</div>
							</div>
						))
					) : (
						<div style={{ textAlign: "center", padding: "40px" }}>
							<p style={{ color: "#52525b", margin: "0 0 12px 0" }}>
								No dynamic tools created yet.
							</p>
							<p style={{ color: "#3f3f46", fontSize: "13px", margin: 0 }}>
								Ask Octopus AI to create a tool and it will appear here.
							</p>
						</div>
					)}
				</div>
			)}
		</div>
	);
};
