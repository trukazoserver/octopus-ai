import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../hooks/useApi.js";

type TabId = "registered" | "dynamic" | "create" | "execute";

interface RegisteredTool {
	name: string;
	description: string;
	paramCount: number;
}

interface DynamicTool {
	name: string;
	description?: string;
	version?: string;
}

const CATEGORIES: Record<string, { icon: string; color: string }> = {
	"generate-image": { icon: "🎨", color: "#a855f7" },
	"edit-image": { icon: "✏️", color: "#f59e0b" },
	"nano-banana": { icon: "🍌", color: "#fbbf24" },
	"save-image": { icon: "💾", color: "#22c55e" },
	"image-url": { icon: "🔗", color: "#3b82f6" },
	calculator: { icon: "🔢", color: "#06b6d4" },
	smart: { icon: "🧠", color: "#ec4899" },
	search: { icon: "🔍", color: "#10b981" },
	browse: { icon: "🌐", color: "#6366f1" },
	shell: { icon: "💻", color: "#78716c" },
	execute: { icon: "▶️", color: "#22d3ee" },
	create: { icon: "🛠️", color: "#8b5cf6" },
	file: { icon: "📁", color: "#f97316" },
	read: { icon: "📄", color: "#64748b" },
	write: { icon: "✍️", color: "#84cc16" },
	default: { icon: "⚙️", color: "#94a3b8" },
};

function getCategory(name: string): { icon: string; color: string } {
	for (const [key, val] of Object.entries(CATEGORIES)) {
		if (key !== "default" && name.toLowerCase().includes(key.toLowerCase())) return val;
	}
	return CATEGORIES.default;
}

const LANGUAGES = ["javascript", "typescript", "python", "bash"];

export const ToolsPage: React.FC = () => {
	const [activeTab, setActiveTab] = useState<TabId>("registered");
	const [registered, setRegistered] = useState<RegisteredTool[]>([]);
	const [dynamic, setDynamic] = useState<DynamicTool[]>([]);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState<string | null>(null);

	// Create tool state
	const [toolName, setToolName] = useState("");
	const [toolDescription, setToolDescription] = useState("");
	const [toolCode, setToolCode] = useState("");
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
			const [reg, dyn] = await Promise.all([
				apiGet<{ tools: RegisteredTool[] }>("/api/tools/registered"),
				apiGet<{ tools: DynamicTool[] }>("/api/code/tools"),
			]);
			setRegistered(reg.tools ?? []);
			setDynamic(dyn.tools ?? []);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { loadData(); }, [loadData]);

	const handleDeleteDynamic = async (name: string) => {
		if (!confirm(`¿Eliminar la herramienta "${name}"?`)) return;
		try {
			await apiDelete(`/api/tools/dynamic/${encodeURIComponent(name)}`);
			setMsg(`✓ Herramienta '${name}' eliminada`);
			loadData();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const handleCreate = async () => {
		if (!toolName.trim() || !toolDescription.trim() || !toolCode.trim()) return;
		setCreating(true);
		setMsg(null);
		try {
			const result = await apiPost("/api/code/create-tool", {
				name: toolName, description: toolDescription, code: toolCode, language: "javascript",
			});
			if (result.success) {
				setMsg(`✓ Herramienta '${toolName}' creada exitosamente`);
				setToolName(""); setToolDescription(""); setToolCode("");
				loadData();
			} else {
				setMsg(`✗ ${result.error ?? "Error desconocido"}`);
			}
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : "Error"}`);
		} finally {
			setCreating(false);
		}
	};

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

	const tabs: { id: TabId; label: string; icon: string }[] = [
		{ id: "registered", label: "Registradas", icon: "⚙️" },
		{ id: "dynamic", label: "Dinámicas", icon: "🔌" },
		{ id: "create", label: "Crear", icon: "➕" },
		{ id: "execute", label: "Ejecutar Código", icon: "▶️" },
	];

	const S = {
		section: { padding: "20px", backgroundColor: "#18181b", borderRadius: "10px", border: "1px solid #27272a", marginBottom: "20px" } as React.CSSProperties,
		textarea: { width: "100%", minHeight: "200px", padding: "12px", borderRadius: "8px", border: "1px solid #27272a", backgroundColor: "#0f1117", color: "#e4e4e7", fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: "13px", lineHeight: "1.5", resize: "vertical" as const, outline: "none", boxSizing: "border-box" as const },
		input: { width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #27272a", backgroundColor: "#0f1117", color: "#e4e4e7", fontSize: "13px", outline: "none", boxSizing: "border-box" as const },
	};

	if (loading) return <div style={{ padding: 40, color: "#666" }}>Cargando herramientas...</div>;

	return (
		<div className="page-shell page-shell--xl" style={{ padding: "24px", overflowY: "auto", height: "100%" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
				<div>
					<h2 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: 700 }}>🔧 Herramientas</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						{registered.length} registradas · {dynamic.length} dinámicas
					</p>
				</div>
				<div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
					{tabs.map((t) => (
						<button key={t.id} type="button" onClick={() => setActiveTab(t.id)} style={{
							padding: "7px 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 500,
							backgroundColor: activeTab === t.id ? "#3b82f6" : "#27272a",
							color: activeTab === t.id ? "#fff" : "#a1a1aa", transition: "all 0.15s ease",
						}}>
							{t.icon} {t.label}
						</button>
					))}
				</div>
			</div>

			{msg && (
				<div style={{
					padding: "10px 16px", borderRadius: 8, marginBottom: 12, fontSize: "0.85rem",
					background: msg.startsWith("✓") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
					color: msg.startsWith("✓") ? "#22c55e" : "#ef4444", border: `1px solid ${msg.startsWith("✓") ? "#22c55e33" : "#ef444433"}`,
				}}>
					{msg}
				</div>
			)}

			{activeTab === "registered" && (
				<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px" }}>
					{registered.map((tool) => {
						const cat = getCategory(tool.name);
						return (
							<div key={tool.name} style={{
								...S.section, marginBottom: 0, display: "flex", gap: "14px", alignItems: "flex-start",
								transition: "border-color 0.2s", cursor: "default",
							}}>
								<div style={{
									width: 40, height: 40, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center",
									fontSize: "1.2rem", backgroundColor: `${cat.color}22`, flexShrink: 0,
								}}>
									{cat.icon}
								</div>
								<div style={{ flex: 1, minWidth: 0 }}>
									<div style={{ fontWeight: 600, fontSize: "0.9rem", color: "#e4e4e7", marginBottom: 2 }}>{tool.name}</div>
									<div style={{ fontSize: "0.78rem", color: "#71717a", lineHeight: 1.4 }}>
										{tool.description.length > 120 ? `${tool.description.substring(0, 120)}...` : tool.description}
									</div>
									{tool.paramCount > 0 && (
										<div style={{ fontSize: "0.72rem", color: "#525252", marginTop: 4 }}>
											{tool.paramCount} parámetro{tool.paramCount === 1 ? "" : "s"}
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{activeTab === "dynamic" && (
				<div>
					{dynamic.length === 0 ? (
						<div style={{ ...S.section, textAlign: "center", color: "#525252", padding: "40px" }}>
							No hay herramientas dinámicas creadas aún. Ve a la pestaña "Crear" para crear una.
						</div>
					) : (
						<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px" }}>
							{dynamic.map((tool) => (
								<div key={tool.name} style={{ ...S.section, marginBottom: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
									<div>
										<div style={{ fontWeight: 600, fontSize: "0.9rem", color: "#e4e4e7" }}>🔌 {tool.name}</div>
										<div style={{ fontSize: "0.78rem", color: "#71717a", marginTop: 2 }}>{tool.description ?? "Sin descripción"}</div>
										{tool.version && <div style={{ fontSize: "0.72rem", color: "#525252", marginTop: 2 }}>v{tool.version}</div>}
									</div>
									<button type="button" onClick={() => handleDeleteDynamic(tool.name)} style={{
										padding: "6px 14px", borderRadius: 8, border: "1px solid #ef444444", background: "transparent",
										color: "#ef4444", cursor: "pointer", fontSize: "12px", flexShrink: 0,
									}}>
										Eliminar
									</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{activeTab === "create" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 4px 0", fontSize: "16px" }}>Crear Nueva Herramienta</h3>
					<p style={{ color: "#71717a", fontSize: "13px", marginBottom: "16px" }}>
						Crea una herramienta reutilizable. El código debe exportar una función async por defecto.
					</p>
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginBottom: "12px" }}>
						<div>
							<label htmlFor="tool-name" style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Nombre</label>
							<input id="tool-name" type="text" value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="mi-herramienta" style={S.input} />
						</div>
						<div>
							<label htmlFor="tool-desc" style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Descripción</label>
							<input id="tool-desc" type="text" value={toolDescription} onChange={(e) => setToolDescription(e.target.value)} placeholder="Qué hace esta herramienta..." style={S.input} />
						</div>
					</div>
					<label htmlFor="tool-code" style={{ display: "block", fontSize: "12px", color: "#71717a", marginBottom: "4px" }}>Código (export default async function)</label>
					<textarea id="tool-code" value={toolCode} onChange={(e) => setToolCode(e.target.value)}
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
					<div style={{ display: "flex", gap: "8px", marginBottom: "12px", alignItems: "center" }}>
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
					<textarea value={code} onChange={(e) => setCode(e.target.value)}
						placeholder={`// Escribe tu código ${language} aquí...`} style={S.textarea} />
					<div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
						<button type="button" onClick={handleExecute} disabled={executing || !code.trim()} style={{
							padding: "10px 24px", borderRadius: 8, border: "none", fontSize: "14px", fontWeight: 600, cursor: executing ? "not-allowed" : "pointer",
							backgroundColor: executing ? "#3f3f46" : "#22c55e", color: "#fff",
						}}>
							{executing ? "Ejecutando..." : "▶ Ejecutar"}
						</button>
						{execTime !== null && <span style={{ fontSize: "12px", color: "#71717a" }}>Ejecutado en {execTime}ms</span>}
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
