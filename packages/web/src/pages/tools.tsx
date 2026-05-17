import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon } from "../components/ui/AppIcon.js";
import { Loading } from "../components/ui/Loading.js";
import { Modal } from "../components/ui/Modal.js";
import { apiDelete, apiGet, apiPost, apiPutJson } from "../hooks/useApi.js";

type TabId = "inventory" | "integrations" | "create" | "execute";

interface ToolInventoryItem {
	id: string;
	source: "system" | "dynamic" | "mcp";
	resourceType: "tool" | "mcp-server";
	managementScope: "tool" | "server";
	name: string;
	displayName: string;
	description: string;
	status: "active" | "inactive" | "error" | "not_loaded";
	enabled: boolean;
	registered: boolean;
	persisted: boolean;
	version?: string;
	language?: string;
	uiIcon?: string;
	paramCount?: number;
	mcp?: {
		tools?: Array<{ name: string; runtimeName: string }>;
		command?: string;
		args?: string[];
		envKeys?: string[];
	};
	runtime?: {
		error?: string;
	};
	capabilities: {
		canToggle: boolean;
		canEdit: boolean;
		canDelete: boolean;
		canRestart: boolean;
	};
}

interface DynamicToolDetail {
	manifest?: { description?: string; language?: string };
	code?: string;
}

interface MCPServerDetail {
	name: string;
	config: {
		type?: string;
		url?: string;
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		headers?: Record<string, string>;
	};
}

interface ToolSummary {
	system?: number;
	dynamic?: number;
	mcpServers?: number;
	mcpTools?: number;
}

interface MCPCatalogEntry {
	name: string;
	displayName: string;
	description: string;
	category: string;
	icon: string;
	tools: string[];
	config: {
		type?: string;
		url?: string;
		headers?: Record<string, string>;
		command?: string;
		args?: string[];
		env?: Record<string, string>;
	};
	requiresApiKey?: string;
	homepage: string;
}

const LANGUAGES = ["javascript", "typescript", "python", "bash"];

export const ToolsPage: React.FC = () => {
	const [activeTab, setActiveTab] = useState<TabId>("inventory");
	const [items, setItems] = useState<ToolInventoryItem[]>([]);
	const [catalog, setCatalog] = useState<MCPCatalogEntry[]>([]);
	const [summary, setSummary] = useState<ToolSummary>({});
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
	const [search, setSearch] = useState("");
	const [catalogFilter, setCatalogFilter] = useState("all");
	const [installingMcp, setInstallingMcp] = useState<string | null>(null);
	const [sourceFilter, setSourceFilter] = useState<
		"all" | "system" | "dynamic" | "mcp"
	>("all");
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	// Create tool state
	const [toolName, setToolName] = useState("");
	const [toolDescription, setToolDescription] = useState("");
	const [toolCode, setToolCode] = useState("");
	const [toolLanguage, setToolLanguage] = useState("javascript");
	const [creating, setCreating] = useState(false);
	const [editingToolName, setEditingToolName] = useState<string | null>(null);
	const [editingMcpName, setEditingMcpName] = useState<string | null>(null);
	const [mcpType, setMcpType] = useState("stdio");
	const [mcpUrl, setMcpUrl] = useState("");
	const [mcpCommand, setMcpCommand] = useState("");
	const [mcpArgsJson, setMcpArgsJson] = useState("[]");
	const [mcpEnvJson, setMcpEnvJson] = useState("{}");
	const [mcpHeadersJson, setMcpHeadersJson] = useState("{}");
	const [savingMcp, setSavingMcp] = useState(false);

	// Execute code state
	const [code, setCode] = useState("");
	const [language, setLanguage] = useState("javascript");
	const [output, setOutput] = useState("");
	const [execError, setExecError] = useState<string | null>(null);
	const [executing, setExecuting] = useState(false);
	const [execTime, setExecTime] = useState<number | null>(null);

	const loadData = useCallback(async () => {
		setLoading(true);
		try {
			const [res, catalogRes] = await Promise.all([
				apiGet<{
					items: ToolInventoryItem[];
					summary: ToolSummary;
				}>("/api/tools"),
				apiGet<MCPCatalogEntry[]>("/api/mcp/catalog").catch(() => []),
			]);
			setItems(res.items ?? []);
			setSummary(res.summary ?? {});
			setCatalog(catalogRes ?? []);
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadData();
	}, [loadData]);

	const showMessage = (text: string, ok = true) => {
		setMsg({ text, ok });
		setTimeout(() => setMsg(null), 4000);
	};

	const handleToggle = async (item: ToolInventoryItem) => {
		try {
			if (item.source === "system") {
				await apiPost(
					`/api/tools/system/${encodeURIComponent(item.name)}/toggle`,
				);
			} else if (item.source === "dynamic") {
				await apiPost(
					`/api/tools/dynamic/${encodeURIComponent(item.name)}/toggle`,
				);
			} else if (item.source === "mcp") {
				await apiPost(
					`/api/mcp/servers/${encodeURIComponent(item.name)}/toggle`,
				);
			}
			showMessage(`Estado de ${item.name} actualizado`);
			loadData();
		} catch (e) {
			showMessage(
				`Error: ${e instanceof Error ? e.message : String(e)}`,
				false,
			);
		}
	};

	const handleDelete = async (item: ToolInventoryItem) => {
		if (confirmDeleteId !== item.id) {
			setConfirmDeleteId(item.id);
			return;
		}
		try {
			if (item.source === "dynamic") {
				await apiDelete(`/api/tools/dynamic/${encodeURIComponent(item.name)}`);
			} else if (item.source === "mcp") {
				await apiDelete(`/api/mcp/servers/${encodeURIComponent(item.name)}`);
			}
			showMessage(`✓ '${item.name}' eliminado`);
			setConfirmDeleteId(null);
			loadData();
		} catch (e) {
			showMessage(
				`Error: ${e instanceof Error ? e.message : String(e)}`,
				false,
			);
		}
	};

	const handleRestart = async (item: ToolInventoryItem) => {
		try {
			if (item.source === "mcp") {
				await apiPost(
					`/api/mcp/servers/${encodeURIComponent(item.name)}/restart`,
				);
				showMessage(`✓ Servidor '${item.name}' reiniciado`);
				loadData();
			}
		} catch (e) {
			showMessage(
				`Error: ${e instanceof Error ? e.message : String(e)}`,
				false,
			);
		}
	};

	const handleInstallMcp = async (entry: MCPCatalogEntry) => {
		setInstallingMcp(entry.name);
		try {
			await apiPost("/api/mcp/servers", {
				name: entry.name,
				...entry.config,
				enabled: false,
			});
			showMessage(
				`Integración '${entry.displayName}' instalada. Actívala desde Inventario cuando sus variables estén configuradas.`,
			);
			loadData();
		} catch (e) {
			showMessage(
				`Error: ${e instanceof Error ? e.message : String(e)}`,
				false,
			);
		} finally {
			setInstallingMcp(null);
		}
	};

	const openCreateTool = () => {
		setEditingToolName(null);
		setToolName("");
		setToolDescription("");
		setToolCode("");
		setToolLanguage("javascript");
		setActiveTab("create");
	};

	const handleEdit = async (item: ToolInventoryItem) => {
		if (item.source === "mcp") {
			try {
				const detail = await apiGet<MCPServerDetail>(
					`/api/mcp/servers/${encodeURIComponent(item.name)}`,
				);
				setEditingMcpName(detail.name);
				setMcpType(
					detail.config.type ??
						(detail.config.url ? "streamable-http" : "stdio"),
				);
				setMcpUrl(detail.config.url ?? "");
				setMcpCommand(detail.config.command ?? "");
				setMcpArgsJson(JSON.stringify(detail.config.args ?? [], null, 2));
				setMcpEnvJson(JSON.stringify(detail.config.env ?? {}, null, 2));
				setMcpHeadersJson(JSON.stringify(detail.config.headers ?? {}, null, 2));
			} catch (e) {
				showMessage(
					`Error: ${e instanceof Error ? e.message : String(e)}`,
					false,
				);
			}
			return;
		}

		if (item.source !== "dynamic") {
			showMessage(
				"Solo las herramientas dinámicas y servidores MCP se pueden editar desde esta sección",
				false,
			);
			return;
		}
		try {
			const detail = await apiGet<DynamicToolDetail>(
				`/api/tools/dynamic/${encodeURIComponent(item.name)}`,
			);
			setEditingToolName(item.name);
			setToolName(item.name);
			setToolDescription(
				detail.manifest?.description ?? item.description ?? "",
			);
			setToolLanguage(
				detail.manifest?.language ?? item.language ?? "javascript",
			);
			setToolCode(detail.code ?? "");
			setActiveTab("create");
		} catch (e) {
			showMessage(
				`Error: ${e instanceof Error ? e.message : String(e)}`,
				false,
			);
		}
	};

	const handleSaveMcp = async () => {
		if (!editingMcpName) return;
		setSavingMcp(true);
		try {
			const args = parseJsonArray(mcpArgsJson, "args");
			const env = parseJsonRecord(mcpEnvJson, "env");
			const headers = parseJsonRecord(mcpHeadersJson, "headers");
			await apiPutJson(
				`/api/mcp/servers/${encodeURIComponent(editingMcpName)}`,
				{
					type: mcpType || undefined,
					url: mcpUrl.trim() || undefined,
					command: mcpCommand.trim() || undefined,
					args,
					env,
					headers,
				},
			);
			showMessage(`Servidor MCP '${editingMcpName}' actualizado`);
			setEditingMcpName(null);
			loadData();
		} catch (e) {
			showMessage(
				`Error: ${e instanceof Error ? e.message : String(e)}`,
				false,
			);
		} finally {
			setSavingMcp(false);
		}
	};

	const handleCreate = async () => {
		if (!toolName.trim() || !toolDescription.trim() || !toolCode.trim()) return;
		setCreating(true);
		setMsg(null);
		try {
			const result = editingToolName
				? await apiPutJson(
						`/api/tools/dynamic/${encodeURIComponent(editingToolName)}`,
						{
							description: toolDescription,
							code: toolCode,
						},
					)
				: await apiPost("/api/code/create-tool", {
						name: toolName,
						description: toolDescription,
						code: toolCode,
						language: toolLanguage,
					});
			if (result.success || result.ok) {
				showMessage(
					editingToolName
						? `Herramienta '${editingToolName}' actualizada`
						: `Herramienta '${toolName}' creada exitosamente`,
				);
				setEditingToolName(null);
				setToolName("");
				setToolDescription("");
				setToolCode("");
				setToolLanguage("javascript");
				setActiveTab("inventory");
				loadData();
			} else {
				showMessage(`Error: ${result.error ?? "Error desconocido"}`, false);
			}
		} catch (e) {
			showMessage(`Error: ${e instanceof Error ? e.message : "Error"}`, false);
		} finally {
			setCreating(false);
		}
	};

	const filteredItems = items.filter((item) => {
		const q = search.trim().toLowerCase();
		const matchesSource =
			sourceFilter === "all" || item.source === sourceFilter;
		const matchesSearch =
			!q ||
			[item.name, item.displayName, item.description, item.source].some(
				(value) => value?.toLowerCase().includes(q),
			);
		return matchesSource && matchesSearch;
	});

	const installedMcpItems = new Map(
		items
			.filter((item) => item.source === "mcp")
			.map((item) => [item.name, item]),
	);
	const catalogCategories = Array.from(
		new Set(catalog.map((entry) => entry.category)),
	).sort();
	const filteredCatalog = catalog.filter((entry) => {
		const q = search.trim().toLowerCase();
		const matchesCategory =
			catalogFilter === "all" || entry.category === catalogFilter;
		const matchesSearch =
			!q ||
			[
				entry.name,
				entry.displayName,
				entry.description,
				entry.category,
				entry.tools.join(" "),
			].some((value) => value.toLowerCase().includes(q));
		return matchesCategory && matchesSearch;
	});

	const handleExecute = async () => {
		if (!code.trim()) return;
		setExecuting(true);
		setExecError(null);
		setOutput("");
		setExecTime(null);
		try {
			const result = await apiPost("/api/code/execute", {
				code,
				language,
				timeout: 30000,
			});
			const stdout = typeof result.stdout === "string" ? result.stdout : "";
			const stderr = typeof result.stderr === "string" ? result.stderr : "";
			setOutput(stdout + (stderr ? `\n[stderr]\n${stderr}` : ""));
			setExecTime(
				typeof result.executionTime === "number" ? result.executionTime : null,
			);
			if (!result.success) setExecError("La ejecución completó con errores");
		} catch (e) {
			setExecError(e instanceof Error ? e.message : "Error de ejecución");
		} finally {
			setExecuting(false);
		}
	};

	const S = {
		section: {
			padding: "20px",
			backgroundColor: "#18181b",
			borderRadius: "10px",
			border: "1px solid #27272a",
			marginBottom: "20px",
		} as React.CSSProperties,
		textarea: {
			width: "100%",
			minHeight: "200px",
			padding: "12px",
			borderRadius: "8px",
			border: "1px solid #27272a",
			backgroundColor: "#0f1117",
			color: "#e4e4e7",
			fontFamily: '"JetBrains Mono", "Fira Code", monospace',
			fontSize: "13px",
			lineHeight: "1.5",
			resize: "vertical" as const,
			outline: "none",
			boxSizing: "border-box" as const,
		},
		input: {
			width: "100%",
			padding: "8px 12px",
			borderRadius: "8px",
			border: "1px solid #27272a",
			backgroundColor: "#0f1117",
			color: "#e4e4e7",
			fontSize: "13px",
			outline: "none",
			boxSizing: "border-box" as const,
		},
		badge: (color: string, bg: string) => ({
			display: "inline-flex",
			alignItems: "center",
			padding: "2px 8px",
			borderRadius: "12px",
			fontSize: "11px",
			fontWeight: 600,
			color,
			backgroundColor: bg,
		}),
		btn: {
			padding: "6px 12px",
			borderRadius: 6,
			border: "1px solid #3f3f46",
			background: "transparent",
			color: "#e4e4e7",
			cursor: "pointer",
			fontSize: "12px",
			fontWeight: 500,
			transition: "all 0.2s",
		},
	};

	return (
		<div
			className="page-shell page-shell--xl"
			style={{ padding: "24px", overflowY: "auto", height: "100%" }}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "24px",
					flexWrap: "wrap",
					gap: "12px",
				}}
			>
				<div>
					<h2
						style={{
							margin: "0 0 4px 0",
							fontSize: "20px",
							fontWeight: 700,
							display: "flex",
							alignItems: "center",
							gap: 8,
						}}
					>
						<AppIcon name="tools" size={22} /> Herramientas
					</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						{summary.system || 0} sistema · {summary.dynamic || 0} dinámicas ·{" "}
						{summary.mcpServers || 0} MCP servers ({summary.mcpTools || 0}{" "}
						tools)
					</p>
				</div>
				<div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
					<button
						type="button"
						onClick={() => setActiveTab("inventory")}
						style={{
							...S.btn,
							backgroundColor:
								activeTab === "inventory" ? "#6366f1" : "#27272a",
							color: activeTab === "inventory" ? "#fff" : "#a1a1aa",
							border: "none",
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
						}}
					>
						<AppIcon name="database" size={14} /> Inventario
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("integrations")}
						style={{
							...S.btn,
							backgroundColor:
								activeTab === "integrations" ? "#6366f1" : "#27272a",
							color: activeTab === "integrations" ? "#fff" : "#a1a1aa",
							border: "none",
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
						}}
					>
						<AppIcon name="spark" size={14} /> Integraciones
					</button>
					<button
						type="button"
						onClick={openCreateTool}
						style={{
							...S.btn,
							backgroundColor: activeTab === "create" ? "#6366f1" : "#27272a",
							color: activeTab === "create" ? "#fff" : "#a1a1aa",
							border: "none",
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
						}}
					>
						<AppIcon name="edit" size={14} /> Crear
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("execute")}
						style={{
							...S.btn,
							backgroundColor: activeTab === "execute" ? "#6366f1" : "#27272a",
							color: activeTab === "execute" ? "#fff" : "#a1a1aa",
							border: "none",
							display: "inline-flex",
							alignItems: "center",
							gap: 6,
						}}
					>
						<AppIcon name="play" size={14} /> Ejecutar
					</button>
				</div>
			</div>

			{msg && (
				<div
					style={{
						padding: "10px 16px",
						borderRadius: 8,
						marginBottom: 12,
						fontSize: "0.85rem",
						background: msg.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
						color: msg.ok ? "#22c55e" : "#ef4444",
						border: `1px solid ${msg.ok ? "#22c55e33" : "#ef444433"}`,
					}}
				>
					{msg.text}
				</div>
			)}

			{loading && items.length === 0 ? (
				<Loading text="Cargando herramientas..." />
			) : null}

			<Modal
				open={Boolean(editingMcpName)}
				onClose={() => setEditingMcpName(null)}
				title={`Configurar MCP: ${editingMcpName ?? "servidor"}`}
				maxWidth="720px"
			>
				<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
							gap: 12,
						}}
					>
						<label style={{ color: "#a1a1aa", fontSize: "12px" }}>
							Tipo
							<select
								value={mcpType}
								onChange={(e) => setMcpType(e.target.value)}
								style={{ ...S.input, marginTop: 4 }}
							>
								<option value="stdio">stdio</option>
								<option value="streamable-http">streamable-http</option>
								<option value="http">http</option>
							</select>
						</label>
						<label style={{ color: "#a1a1aa", fontSize: "12px" }}>
							URL HTTP
							<input
								value={mcpUrl}
								onChange={(e) => setMcpUrl(e.target.value)}
								placeholder="${N8N_MCP_URL}"
								style={{ ...S.input, marginTop: 4 }}
							/>
						</label>
						<label style={{ color: "#a1a1aa", fontSize: "12px" }}>
							Comando stdio
							<input
								value={mcpCommand}
								onChange={(e) => setMcpCommand(e.target.value)}
								placeholder="npx"
								style={{ ...S.input, marginTop: 4 }}
							/>
						</label>
					</div>
					<label style={{ color: "#a1a1aa", fontSize: "12px" }}>
						Args JSON
						<textarea
							value={mcpArgsJson}
							onChange={(e) => setMcpArgsJson(e.target.value)}
							style={{ ...S.textarea, minHeight: 90, marginTop: 4 }}
						/>
					</label>
					<label style={{ color: "#a1a1aa", fontSize: "12px" }}>
						Variables de entorno JSON
						<textarea
							value={mcpEnvJson}
							onChange={(e) => setMcpEnvJson(e.target.value)}
							style={{ ...S.textarea, minHeight: 110, marginTop: 4 }}
						/>
					</label>
					<label style={{ color: "#a1a1aa", fontSize: "12px" }}>
						Headers JSON
						<textarea
							value={mcpHeadersJson}
							onChange={(e) => setMcpHeadersJson(e.target.value)}
							style={{ ...S.textarea, minHeight: 110, marginTop: 4 }}
						/>
					</label>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						<button
							type="button"
							onClick={handleSaveMcp}
							disabled={savingMcp}
							style={{
								...S.btn,
								background: savingMcp ? "#3f3f46" : "#22c55e",
								borderColor: savingMcp ? "#3f3f46" : "#22c55e",
								color: "#fff",
							}}
						>
							{savingMcp ? "Guardando..." : "Guardar configuración"}
						</button>
						<button
							type="button"
							onClick={() => setEditingMcpName(null)}
							style={S.btn}
						>
							Cancelar
						</button>
					</div>
				</div>
			</Modal>

			{activeTab === "inventory" && (
				<div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
					<div
						className="toolbar-wrap"
						style={{ justifyContent: "space-between", marginBottom: "4px" }}
					>
						<input
							id="tools-search"
							name="toolsSearch"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Buscar por nombre, descripción o fuente..."
							style={{ ...S.input, maxWidth: 420 }}
						/>
						<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
							{(["all", "system", "dynamic", "mcp"] as const).map((source) => (
								<button
									key={source}
									type="button"
									onClick={() => setSourceFilter(source)}
									style={{
										...S.btn,
										background: sourceFilter === source ? "#3b82f6" : "#27272a",
										borderColor:
											sourceFilter === source ? "#3b82f6" : "#3f3f46",
									}}
								>
									{source === "all"
										? "Todas"
										: source === "system"
											? "Sistema"
											: source === "dynamic"
												? "Dinámicas"
												: "MCP"}
								</button>
							))}
						</div>
					</div>
					{filteredItems.length === 0 && !loading && (
						<div
							style={{ ...S.section, textAlign: "center", color: "#a1a1aa" }}
						>
							<div style={{ color: "#818cf8", marginBottom: 8 }}>
								<AppIcon name="tools" size={36} />
							</div>
							<div
								style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: 6 }}
							>
								No hay herramientas para este filtro
							</div>
							<div style={{ fontSize: "0.85rem" }}>
								Limpia la búsqueda, crea una herramienta dinámica o conecta un
								servidor MCP.
							</div>
						</div>
					)}
					{filteredItems.map((item) => (
						<div
							key={item.id}
							style={{
								...S.section,
								marginBottom: 0,
								display: "flex",
								flexDirection: "column",
								gap: "12px",
								borderLeft:
									item.status === "error"
										? "4px solid #ef4444"
										: "1px solid #27272a",
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "flex-start",
									flexWrap: "wrap",
									gap: "12px",
								}}
							>
								<div>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
											marginBottom: "6px",
										}}
									>
										<div
											style={{
												fontWeight: 600,
												fontSize: "16px",
												color: "#e4e4e7",
											}}
										>
											{item.displayName}
										</div>
										{item.source === "system" && (
											<span
												style={S.badge("#38bdf8", "rgba(56, 189, 248, 0.1)")}
											>
												Sistema
											</span>
										)}
										{item.source === "dynamic" && (
											<span
												style={S.badge("#a78bfa", "rgba(167, 139, 250, 0.1)")}
											>
												Dinámica
											</span>
										)}
										{item.source === "mcp" && (
											<span
												style={S.badge("#fbbf24", "rgba(251, 191, 36, 0.1)")}
											>
												MCP Server
											</span>
										)}

										{item.status === "active" && (
											<span
												style={S.badge("#10b981", "rgba(16, 185, 129, 0.1)")}
											>
												Activa
											</span>
										)}
										{item.status === "inactive" && (
											<span
												style={S.badge("#71717a", "rgba(113, 113, 122, 0.1)")}
											>
												Inactiva
											</span>
										)}
										{item.status === "not_loaded" && (
											<span
												style={S.badge("#f59e0b", "rgba(245, 158, 11, 0.1)")}
											>
												No Cargada
											</span>
										)}
										{item.status === "error" && (
											<span
												style={S.badge("#ef4444", "rgba(239, 68, 68, 0.1)")}
											>
												Error
											</span>
										)}
									</div>
									<div
										style={{
											fontSize: "13px",
											color: "#a1a1aa",
											maxWidth: "600px",
											lineHeight: "1.4",
										}}
									>
										{item.description || "Sin descripción."}
									</div>
								</div>

								<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
									{item.capabilities.canToggle && (
										<button
											type="button"
											onClick={() => handleToggle(item)}
											style={{
												...S.btn,
												color: item.enabled ? "#ef4444" : "#10b981",
												borderColor: item.enabled ? "#ef444444" : "#10b98144",
											}}
										>
											{item.enabled ? "Desactivar" : "Activar"}
										</button>
									)}
									{item.capabilities.canRestart && (
										<button
											type="button"
											onClick={() => handleRestart(item)}
											style={S.btn}
										>
											Reiniciar
										</button>
									)}
									{item.capabilities.canEdit && (
										<button
											type="button"
											onClick={() => void handleEdit(item)}
											style={{
												...S.btn,
												color: "#818cf8",
												borderColor: "#818cf844",
											}}
										>
											Editar
										</button>
									)}
									{item.capabilities.canDelete && (
										<button
											type="button"
											onClick={() => handleDelete(item)}
											style={{
												...S.btn,
												color: "#ef4444",
												borderColor: "#ef444444",
											}}
										>
											{confirmDeleteId === item.id ? "Confirmar" : "Eliminar"}
										</button>
									)}
									{confirmDeleteId === item.id && (
										<button
											type="button"
											onClick={() => setConfirmDeleteId(null)}
											style={S.btn}
										>
											Cancelar
										</button>
									)}
								</div>
							</div>

							{item.runtime?.error && (
								<div
									style={{
										fontSize: "12px",
										color: "#fca5a5",
										backgroundColor: "rgba(239, 68, 68, 0.1)",
										padding: "8px 12px",
										borderRadius: "6px",
									}}
								>
									Error runtime: {item.runtime.error}
								</div>
							)}

							{item.mcp?.tools && item.mcp.tools.length > 0 && (
								<div
									style={{
										marginTop: "8px",
										paddingTop: "12px",
										borderTop: "1px dashed #27272a",
									}}
								>
									<div
										style={{
											fontSize: "12px",
											color: "#71717a",
											marginBottom: "8px",
										}}
									>
										Herramientas expuestas ({item.mcp.tools.length}):
									</div>
									<div
										style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}
									>
										{item.mcp.tools.map((t) => (
											<span
												key={t.name}
												style={{
													fontSize: "11px",
													color: "#d4d4d8",
													backgroundColor: "#27272a",
													padding: "2px 8px",
													borderRadius: "4px",
												}}
											>
												{t.name}
											</span>
										))}
									</div>
								</div>
							)}
						</div>
					))}
				</div>
			)}

			{activeTab === "integrations" && (
				<div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
					<div
						className="toolbar-wrap"
						style={{ justifyContent: "space-between", marginBottom: "4px" }}
					>
						<input
							id="mcp-catalog-search"
							name="mcpCatalogSearch"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Buscar n8n, Notion, GitHub, Claude Code, OpenClaw..."
							style={{ ...S.input, maxWidth: 460 }}
						/>
						<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
							<button
								type="button"
								onClick={() => setCatalogFilter("all")}
								style={{
									...S.btn,
									background: catalogFilter === "all" ? "#3b82f6" : "#27272a",
									borderColor: catalogFilter === "all" ? "#3b82f6" : "#3f3f46",
								}}
							>
								Todas
							</button>
							{catalogCategories.map((category) => (
								<button
									key={category}
									type="button"
									onClick={() => setCatalogFilter(category)}
									style={{
										...S.btn,
										background:
											catalogFilter === category ? "#3b82f6" : "#27272a",
										borderColor:
											catalogFilter === category ? "#3b82f6" : "#3f3f46",
									}}
								>
									{category}
								</button>
							))}
						</div>
					</div>

					{filteredCatalog.length === 0 && !loading && (
						<div
							style={{ ...S.section, textAlign: "center", color: "#a1a1aa" }}
						>
							<div style={{ color: "#818cf8", marginBottom: 8 }}>
								<AppIcon name="spark" size={36} />
							</div>
							<div
								style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: 6 }}
							>
								No hay integraciones para este filtro
							</div>
							<div style={{ fontSize: "0.85rem" }}>
								Limpia la búsqueda o revisa el catálogo MCP del backend.
							</div>
						</div>
					)}

					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
							gap: 12,
						}}
					>
						{filteredCatalog.map((entry) => {
							const installedItem = installedMcpItems.get(entry.name);
							const installed = Boolean(installedItem);
							return (
								<div
									key={entry.name}
									style={{
										...S.section,
										marginBottom: 0,
										display: "flex",
										flexDirection: "column",
										gap: 10,
									}}
								>
									<div
										style={{ display: "flex", gap: 10, alignItems: "center" }}
									>
										<div
											style={{
												width: 30,
												height: 30,
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												fontSize: 24,
											}}
										>
											{entry.icon.startsWith("http") ? (
												<img
													src={entry.icon}
													alt=""
													style={{
														maxWidth: 24,
														maxHeight: 24,
														borderRadius: 4,
													}}
												/>
											) : (
												entry.icon
											)}
										</div>
										<div>
											<div style={{ color: "#f4f4f5", fontWeight: 700 }}>
												{entry.displayName}
											</div>
											<div style={{ fontSize: "0.75rem", color: "#71717a" }}>
												{entry.category} · {entry.config.url ? "HTTP" : "stdio"}
											</div>
										</div>
									</div>
									<div
										style={{
											color: "#a1a1aa",
											fontSize: "0.85rem",
											lineHeight: 1.45,
										}}
									>
										{entry.description}
									</div>
									{entry.requiresApiKey && (
										<div
											style={{
												padding: "8px 10px",
												borderRadius: 8,
												background: "rgba(251, 191, 36, 0.08)",
												border: "1px solid rgba(251, 191, 36, 0.18)",
												color: "#fbbf24",
												fontSize: "0.75rem",
											}}
										>
											Requiere: {entry.requiresApiKey}
										</div>
									)}
									<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
										{entry.tools.slice(0, 6).map((tool) => (
											<span
												key={tool}
												style={{
													fontSize: "0.7rem",
													color: "#d4d4d8",
													background: "#27272a",
													padding: "2px 7px",
													borderRadius: 999,
												}}
											>
												{tool}
											</span>
										))}
										{entry.tools.length > 6 && (
											<span style={{ fontSize: "0.7rem", color: "#71717a" }}>
												+{entry.tools.length - 6}
											</span>
										)}
									</div>
									<div
										style={{
											display: "flex",
											gap: 8,
											marginTop: "auto",
											flexWrap: "wrap",
										}}
									>
										<button
											type="button"
											onClick={() => handleInstallMcp(entry)}
											disabled={installed || installingMcp === entry.name}
											style={{
												...S.btn,
												background: installed ? "#27272a" : "#7c3aed",
												borderColor: installed ? "#3f3f46" : "#7c3aed",
												color: installed ? "#71717a" : "#fff",
												cursor: installed ? "not-allowed" : "pointer",
											}}
										>
											{installed
												? "Instalada"
												: installingMcp === entry.name
													? "Instalando..."
													: "Instalar"}
										</button>
										{installedItem && (
											<button
												type="button"
												onClick={() => void handleEdit(installedItem)}
												style={{
													...S.btn,
													color: "#818cf8",
													borderColor: "#818cf844",
												}}
											>
												Configurar
											</button>
										)}
										{installedItem && (
											<button
												type="button"
												onClick={() => handleToggle(installedItem)}
												style={{
													...S.btn,
													color: installedItem.enabled ? "#ef4444" : "#10b981",
													borderColor: installedItem.enabled
														? "#ef444444"
														: "#10b98144",
												}}
											>
												{installedItem.enabled ? "Desactivar" : "Activar"}
											</button>
										)}
										<a
											href={entry.homepage}
											target="_blank"
											rel="noreferrer"
											style={{ ...S.btn, textDecoration: "none" }}
										>
											Docs
										</a>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{activeTab === "create" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 4px 0", fontSize: "16px" }}>
						{editingToolName
							? `Editar ${editingToolName}`
							: "Crear Nueva Herramienta Dinámica"}
					</h3>
					<p
						style={{ color: "#71717a", fontSize: "13px", marginBottom: "16px" }}
					>
						Crea una herramienta reutilizable. El código debe exportar una
						función async por defecto.
					</p>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
							gap: "12px",
							marginBottom: "12px",
						}}
					>
						<div>
							<label
								htmlFor="tool-name"
								style={{
									display: "block",
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Nombre
							</label>
							<input
								id="tool-name"
								name="toolName"
								type="text"
								value={toolName}
								onChange={(e) => setToolName(e.target.value)}
								placeholder="mi-herramienta"
								disabled={Boolean(editingToolName)}
								style={{ ...S.input, opacity: editingToolName ? 0.6 : 1 }}
							/>
						</div>
						<div>
							<label
								htmlFor="tool-description"
								style={{
									display: "block",
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Descripción
							</label>
							<input
								id="tool-description"
								name="toolDescription"
								type="text"
								value={toolDescription}
								onChange={(e) => setToolDescription(e.target.value)}
								placeholder="Qué hace esta herramienta..."
								style={S.input}
							/>
						</div>
						<div>
							<label
								htmlFor="tool-language"
								style={{
									display: "block",
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Lenguaje
							</label>
							<select
								id="tool-language"
								name="toolLanguage"
								value={toolLanguage}
								onChange={(e) => setToolLanguage(e.target.value)}
								style={S.input}
							>
								{LANGUAGES.map((lang) => (
									<option key={lang} value={lang}>
										{lang}
									</option>
								))}
							</select>
						</div>
					</div>
					<label
						htmlFor="tool-code"
						style={{
							display: "block",
							fontSize: "12px",
							color: "#71717a",
							marginBottom: "4px",
						}}
					>
						Código (export default async function)
					</label>
					<textarea
						id="tool-code"
						name="toolCode"
						value={toolCode}
						onChange={(e) => setToolCode(e.target.value)}
						placeholder={`export default async function(params) {\n  return { success: true, output: "Resultado" };\n}`}
						style={S.textarea}
					/>
					<div style={{ marginTop: "12px" }}>
						<button
							type="button"
							onClick={handleCreate}
							disabled={
								creating ||
								!toolName.trim() ||
								!toolDescription.trim() ||
								!toolCode.trim()
							}
							style={{
								padding: "10px 24px",
								borderRadius: 8,
								border: "none",
								backgroundColor: creating ? "#3f3f46" : "#7c3aed",
								color: "#fff",
								cursor: creating ? "not-allowed" : "pointer",
								fontSize: "14px",
								fontWeight: 600,
							}}
						>
							{creating
								? "Guardando..."
								: editingToolName
									? "Actualizar Herramienta"
									: "Crear Herramienta"}
						</button>
						{editingToolName && (
							<button
								type="button"
								onClick={openCreateTool}
								style={{ ...S.btn, marginLeft: 8 }}
							>
								Cancelar edición
							</button>
						)}
					</div>
				</div>
			)}

			{activeTab === "execute" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>
						Ejecutar Código
					</h3>
					<div
						style={{
							display: "flex",
							gap: "8px",
							marginBottom: "12px",
							alignItems: "center",
							flexWrap: "wrap",
						}}
					>
						<span style={{ fontSize: "13px", color: "#71717a" }}>
							Lenguaje:
						</span>
						{LANGUAGES.map((lang) => (
							<button
								key={lang}
								type="button"
								onClick={() => setLanguage(lang)}
								style={{
									padding: "4px 12px",
									borderRadius: 6,
									border: "1px solid #27272a",
									fontSize: "12px",
									cursor: "pointer",
									backgroundColor:
										language === lang ? "#3b82f6" : "transparent",
									color: language === lang ? "#fff" : "#71717a",
								}}
							>
								{lang}
							</button>
						))}
					</div>
					<textarea
						id="code-executor-input"
						name="code"
						value={code}
						onChange={(e) => setCode(e.target.value)}
						placeholder={`// Escribe tu código ${language} aquí...`}
						style={S.textarea}
					/>
					<div
						style={{
							marginTop: "12px",
							display: "flex",
							gap: "8px",
							alignItems: "center",
						}}
					>
						<button
							type="button"
							onClick={handleExecute}
							disabled={executing || !code.trim()}
							style={{
								padding: "10px 24px",
								borderRadius: 8,
								border: "none",
								fontSize: "14px",
								fontWeight: 600,
								cursor: executing ? "not-allowed" : "pointer",
								backgroundColor: executing ? "#3f3f46" : "#22c55e",
								color: "#fff",
							}}
						>
							{executing ? "Ejecutando..." : "▶ Ejecutar"}
						</button>
						{execTime !== null && (
							<span style={{ fontSize: "12px", color: "#71717a" }}>
								Ejecutado en {execTime}ms
							</span>
						)}
						{output && (
							<button
								type="button"
								onClick={() => {
									setOutput("");
									setExecError(null);
									setExecTime(null);
								}}
								style={S.btn}
							>
								Limpiar salida
							</button>
						)}
					</div>
					{execError && (
						<div
							style={{
								marginTop: "12px",
								padding: "12px",
								backgroundColor: "#450a0a",
								borderRadius: 8,
								color: "#fca5a5",
								fontSize: "13px",
							}}
						>
							{execError}
						</div>
					)}
					{output && (
						<div style={{ marginTop: "12px" }}>
							<div
								style={{
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Output:
							</div>
							<pre
								style={{
									padding: "12px",
									backgroundColor: "#0f1117",
									borderRadius: 8,
									border: "1px solid #27272a",
									color: "#a1a1aa",
									fontSize: "13px",
									overflow: "auto",
									maxHeight: "300px",
									whiteSpace: "pre-wrap",
								}}
							>
								{output}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
};

function parseJsonArray(value: string, field: string): string[] {
	const parsed = JSON.parse(value || "[]") as unknown;
	if (
		!Array.isArray(parsed) ||
		!parsed.every((item) => typeof item === "string")
	) {
		throw new Error(`${field} debe ser un array JSON de strings`);
	}
	return parsed;
}

function parseJsonRecord(value: string, field: string): Record<string, string> {
	const parsed = JSON.parse(value || "{}") as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${field} debe ser un objeto JSON`);
	}
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).map(([key, val]) => [
			key,
			String(val),
		]),
	);
}
