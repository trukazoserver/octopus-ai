import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../hooks/useApi.js";

type TabId = "inventory" | "create" | "execute";

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

const LANGUAGES = ["javascript", "typescript", "python", "bash"];

export const ToolsPage: React.FC = () => {
	const [activeTab, setActiveTab] = useState<TabId>("inventory");
	const [items, setItems] = useState<ToolInventoryItem[]>([]);
	const [summary, setSummary] = useState<any>({});
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState<{text: string, ok: boolean} | null>(null);
	const [search, setSearch] = useState("");
	const [sourceFilter, setSourceFilter] = useState<"all" | "system" | "dynamic" | "mcp">("all");
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	// Create tool state
	const [toolName, setToolName] = useState("");
	const [toolDescription, setToolDescription] = useState("");
	const [toolCode, setToolCode] = useState("");
	const [toolLanguage, setToolLanguage] = useState("javascript");
	const [creating, setCreating] = useState(false);

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
			const res = await apiGet<{ items: ToolInventoryItem[], summary: any }>("/api/tools");
			setItems(res.items ?? []);
			setSummary(res.summary ?? {});
		} catch (e) {
			setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { loadData(); }, [loadData]);

	const showMessage = (text: string, ok = true) => {
		setMsg({ text, ok });
		setTimeout(() => setMsg(null), 4000);
	};

	const handleToggle = async (item: ToolInventoryItem) => {
		try {
			if (item.source === "system") {
				await apiPost(`/api/tools/system/${encodeURIComponent(item.name)}/toggle`);
			} else if (item.source === "dynamic") {
				await apiPost(`/api/tools/dynamic/${encodeURIComponent(item.name)}/toggle`);
			} else if (item.source === "mcp") {
				await apiPost(`/api/mcp/servers/${encodeURIComponent(item.name)}/toggle`);
			}
			showMessage(`Estado de ${item.name} actualizado`);
			loadData();
		} catch (e) {
			showMessage(`Error: ${e instanceof Error ? e.message : String(e)}`, false);
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
			showMessage(`Error: ${e instanceof Error ? e.message : String(e)}`, false);
		}
	};

	const handleRestart = async (item: ToolInventoryItem) => {
		try {
			if (item.source === "mcp") {
				await apiPost(`/api/mcp/servers/${encodeURIComponent(item.name)}/restart`);
				showMessage(`✓ Servidor '${item.name}' reiniciado`);
				loadData();
			}
		} catch (e) {
			showMessage(`Error: ${e instanceof Error ? e.message : String(e)}`, false);
		}
	};

	const handleCreate = async () => {
		if (!toolName.trim() || !toolDescription.trim() || !toolCode.trim()) return;
		setCreating(true);
		setMsg(null);
		try {
			const result = await apiPost("/api/code/create-tool", {
				name: toolName, description: toolDescription, code: toolCode, language: toolLanguage,
			});
			if (result.success) {
				showMessage(`✓ Herramienta '${toolName}' creada exitosamente`);
				setToolName(""); setToolDescription(""); setToolCode(""); setToolLanguage("javascript");
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
		const matchesSource = sourceFilter === "all" || item.source === sourceFilter;
		const matchesSearch = !q || [item.name, item.displayName, item.description, item.source]
			.some((value) => value?.toLowerCase().includes(q));
		return matchesSource && matchesSearch;
	});

	const handleExecute = async () => {
		if (!code.trim()) return;
		setExecuting(true); setExecError(null); setOutput(""); setExecTime(null);
		try {
			const result = await apiPost("/api/code/execute", { code, language, timeout: 30000 });
			const stdout = typeof result.stdout === "string" ? result.stdout : "";
			const stderr = typeof result.stderr === "string" ? result.stderr : "";
			setOutput(stdout + (stderr ? `\n[stderr]\n${stderr}` : ""));
			setExecTime(typeof result.executionTime === "number" ? result.executionTime : null);
			if (!result.success) setExecError("La ejecución completó con errores");
		} catch (e) {
			setExecError(e instanceof Error ? e.message : "Error de ejecución");
		} finally {
			setExecuting(false);
		}
	};

	const S = {
		section: { padding: "20px", backgroundColor: "#18181b", borderRadius: "10px", border: "1px solid #27272a", marginBottom: "20px" } as React.CSSProperties,
		textarea: { width: "100%", minHeight: "200px", padding: "12px", borderRadius: "8px", border: "1px solid #27272a", backgroundColor: "#0f1117", color: "#e4e4e7", fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: "13px", lineHeight: "1.5", resize: "vertical" as const, outline: "none", boxSizing: "border-box" as const },
		input: { width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #27272a", backgroundColor: "#0f1117", color: "#e4e4e7", fontSize: "13px", outline: "none", boxSizing: "border-box" as const },
		badge: (color: string, bg: string) => ({
			display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: 600, color, backgroundColor: bg
		}),
		btn: {
			padding: "6px 12px", borderRadius: 6, border: "1px solid #3f3f46", background: "transparent", color: "#e4e4e7", cursor: "pointer", fontSize: "12px", fontWeight: 500, transition: "all 0.2s"
		}
	};

	return (
		<div className="page-shell page-shell--xl" style={{ padding: "24px", overflowY: "auto", height: "100%" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
				<div>
					<h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: 700 }}>🔧 Inventario de Herramientas</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						{summary.system || 0} sistema · {summary.dynamic || 0} dinámicas · {summary.mcpServers || 0} MCP servers ({summary.mcpTools || 0} tools)
					</p>
				</div>
				<div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
					<button onClick={() => setActiveTab("inventory")} style={{...S.btn, backgroundColor: activeTab === "inventory" ? "#3b82f6" : "#27272a", color: activeTab === "inventory" ? "#fff" : "#a1a1aa", border: "none"}}>
						📦 Inventario
					</button>
					<button onClick={() => setActiveTab("create")} style={{...S.btn, backgroundColor: activeTab === "create" ? "#3b82f6" : "#27272a", color: activeTab === "create" ? "#fff" : "#a1a1aa", border: "none"}}>
						➕ Crear
					</button>
					<button onClick={() => setActiveTab("execute")} style={{...S.btn, backgroundColor: activeTab === "execute" ? "#3b82f6" : "#27272a", color: activeTab === "execute" ? "#fff" : "#a1a1aa", border: "none"}}>
						▶️ Ejecutar
					</button>
				</div>
			</div>

			{msg && (
				<div style={{
					padding: "10px 16px", borderRadius: 8, marginBottom: 12, fontSize: "0.85rem",
					background: msg.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
					color: msg.ok ? "#22c55e" : "#ef4444", border: `1px solid ${msg.ok ? "#22c55e33" : "#ef444433"}`,
				}}>
					{msg.text}
				</div>
			)}

			{loading && items.length === 0 ? (
				<div style={{ padding: 40, color: "#666", textAlign: "center" }}>Cargando herramientas...</div>
			) : null}

			{activeTab === "inventory" && (
				<div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
					<div className="toolbar-wrap" style={{ justifyContent: "space-between", marginBottom: "4px" }}>
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
										borderColor: sourceFilter === source ? "#3b82f6" : "#3f3f46",
									}}
								>
									{source === "all" ? "Todas" : source === "system" ? "Sistema" : source === "dynamic" ? "Dinámicas" : "MCP"}
								</button>
							))}
						</div>
					</div>
					{filteredItems.length === 0 && !loading && (
						<div style={{ ...S.section, textAlign: "center", color: "#a1a1aa" }}>
							<div style={{ fontSize: "2rem", marginBottom: 8 }}>🔧</div>
							<div style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: 6 }}>
								No hay herramientas para este filtro
							</div>
							<div style={{ fontSize: "0.85rem" }}>
								Limpia la búsqueda, crea una herramienta dinámica o conecta un servidor MCP.
							</div>
						</div>
					)}
					{filteredItems.map(item => (
						<div key={item.id} style={{ ...S.section, marginBottom: 0, display: "flex", flexDirection: "column", gap: "12px", borderLeft: item.status === "error" ? "4px solid #ef4444" : "1px solid #27272a" }}>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
								<div>
									<div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
										<div style={{ fontWeight: 600, fontSize: "16px", color: "#e4e4e7" }}>{item.displayName}</div>
										{item.source === "system" && <span style={S.badge("#38bdf8", "rgba(56, 189, 248, 0.1)")}>Sistema</span>}
										{item.source === "dynamic" && <span style={S.badge("#a78bfa", "rgba(167, 139, 250, 0.1)")}>Dinámica</span>}
										{item.source === "mcp" && <span style={S.badge("#fbbf24", "rgba(251, 191, 36, 0.1)")}>MCP Server</span>}
										
										{item.status === "active" && <span style={S.badge("#10b981", "rgba(16, 185, 129, 0.1)")}>Activa</span>}
										{item.status === "inactive" && <span style={S.badge("#71717a", "rgba(113, 113, 122, 0.1)")}>Inactiva</span>}
										{item.status === "not_loaded" && <span style={S.badge("#f59e0b", "rgba(245, 158, 11, 0.1)")}>No Cargada</span>}
										{item.status === "error" && <span style={S.badge("#ef4444", "rgba(239, 68, 68, 0.1)")}>Error</span>}
									</div>
									<div style={{ fontSize: "13px", color: "#a1a1aa", maxWidth: "600px", lineHeight: "1.4" }}>
										{item.description || "Sin descripción."}
									</div>
								</div>
								
								<div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
									{item.capabilities.canToggle && (
										<button onClick={() => handleToggle(item)} style={{ ...S.btn, color: item.enabled ? "#ef4444" : "#10b981", borderColor: item.enabled ? "#ef444444" : "#10b98144" }}>
											{item.enabled ? "Desactivar" : "Activar"}
										</button>
									)}
									{item.capabilities.canRestart && (
										<button onClick={() => handleRestart(item)} style={S.btn}>🔄 Reiniciar</button>
									)}
									{item.capabilities.canDelete && (
										<button onClick={() => handleDelete(item)} style={{ ...S.btn, color: "#ef4444", borderColor: "#ef444444" }}>{confirmDeleteId === item.id ? "Confirmar" : "🗑️ Eliminar"}</button>
									)}
									{confirmDeleteId === item.id && (
										<button type="button" onClick={() => setConfirmDeleteId(null)} style={S.btn}>Cancelar</button>
									)}
								</div>
							</div>

							{item.runtime?.error && (
								<div style={{ fontSize: "12px", color: "#fca5a5", backgroundColor: "rgba(239, 68, 68, 0.1)", padding: "8px 12px", borderRadius: "6px" }}>
									Error runtime: {item.runtime.error}
								</div>
							)}

							{item.mcp?.tools && item.mcp.tools.length > 0 && (
								<div style={{ marginTop: "8px", paddingTop: "12px", borderTop: "1px dashed #27272a" }}>
									<div style={{ fontSize: "12px", color: "#71717a", marginBottom: "8px" }}>Herramientas expuestas ({item.mcp.tools.length}):</div>
									<div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
										{item.mcp.tools.map(t => (
											<span key={t.name} style={{ fontSize: "11px", color: "#d4d4d8", backgroundColor: "#27272a", padding: "2px 8px", borderRadius: "4px" }}>
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

			{activeTab === "create" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 4px 0", fontSize: "16px" }}>Crear Nueva Herramienta Dinámica</h3>
					<p style={{ color: "#71717a", fontSize: "13px", marginBottom: "16px" }}>
						Crea una herramienta reutilizable. El código debe exportar una función async por defecto.
					</p>
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginBottom: "12px" }}>
						<div>
							<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Nombre</label>
							<input id="tool-name" name="toolName" type="text" value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="mi-herramienta" style={S.input} />
						</div>
						<div>
							<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Descripción</label>
							<input id="tool-description" name="toolDescription" type="text" value={toolDescription} onChange={(e) => setToolDescription(e.target.value)} placeholder="Qué hace esta herramienta..." style={S.input} />
						</div>
						<div>
							<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Lenguaje</label>
							<select id="tool-language" name="toolLanguage" value={toolLanguage} onChange={(e) => setToolLanguage(e.target.value)} style={S.input}>
								{LANGUAGES.map((lang) => <option key={lang} value={lang}>{lang}</option>)}
							</select>
						</div>
					</div>
					<label style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Código (export default async function)</label>
					<textarea id="tool-code" name="toolCode" value={toolCode} onChange={(e) => setToolCode(e.target.value)}
						placeholder={`export default async function(params) {\n  return { success: true, output: "Resultado" };\n}`}
						style={S.textarea} />
					<div style={{ marginTop: "12px" }}>
						<button type="button" onClick={handleCreate} disabled={creating || !toolName.trim() || !toolCode.trim()}
							style={{ padding: "10px 24px", borderRadius: 8, border: "none", backgroundColor: creating ? "#3f3f46" : "#7c3aed", color: "#fff", cursor: creating ? "not-allowed" : "pointer", fontSize: "14px", fontWeight: 600 }}>
							{creating ? "Creando..." : "Crear Herramienta"}
						</button>
					</div>
				</div>
			)}

			{activeTab === "execute" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>Ejecutar Código</h3>
					<div style={{ display: "flex", gap: "8px", marginBottom: "12px", alignItems: "center", flexWrap: "wrap" }}>
						<span style={{ fontSize: "13px", color: "#71717a" }}>Lenguaje:</span>
						{LANGUAGES.map((lang) => (
							<button key={lang} type="button" onClick={() => setLanguage(lang)} style={{
								padding: "4px 12px", borderRadius: 6, border: "1px solid #27272a", fontSize: "12px", cursor: "pointer",
								backgroundColor: language === lang ? "#3b82f6" : "transparent",
								color: language === lang ? "#fff" : "#71717a",
							}}>
								{lang}
							</button>
						))}
					</div>
					<textarea id="code-executor-input" name="code" value={code} onChange={(e) => setCode(e.target.value)}
						placeholder={`// Escribe tu código ${language} aquí...`} style={S.textarea} />
					<div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
						<button type="button" onClick={handleExecute} disabled={executing || !code.trim()} style={{
							padding: "10px 24px", borderRadius: 8, border: "none", fontSize: "14px", fontWeight: 600, cursor: executing ? "not-allowed" : "pointer",
							backgroundColor: executing ? "#3f3f46" : "#22c55e", color: "#fff",
						}}>
							{executing ? "Ejecutando..." : "▶ Ejecutar"}
						</button>
						{execTime !== null && <span style={{ fontSize: "12px", color: "#71717a" }}>Ejecutado en {execTime}ms</span>}
						{output && <button type="button" onClick={() => { setOutput(""); setExecError(null); setExecTime(null); }} style={S.btn}>Limpiar salida</button>}
					</div>
					{execError && <div style={{ marginTop: "12px", padding: "12px", backgroundColor: "#450a0a", borderRadius: 8, color: "#fca5a5", fontSize: "13px" }}>{execError}</div>}
					{output && (
						<div style={{ marginTop: "12px" }}>
							<div style={{ fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Output:</div>
							<pre style={{
								padding: "12px", backgroundColor: "#0f1117", borderRadius: 8, border: "1px solid #27272a",
								color: "#a1a1aa", fontSize: "13px", overflow: "auto", maxHeight: "300px", whiteSpace: "pre-wrap",
							}}>
								{output}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
};
