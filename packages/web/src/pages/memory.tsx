import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../hooks/useApi.js";

type TabId = "overview" | "stm" | "ltm" | "daily" | "profile";

interface MemoryStats {
	enabled: boolean;
	shortTerm: { maxTokens?: number; [key: string]: unknown };
	longTerm: { maxItems?: number; importanceThreshold?: number; [key: string]: unknown };
	consolidation: { [key: string]: unknown };
	retrieval: { maxResults?: number; minRelevance?: number; [key: string]: unknown };
}

interface STMTurn { role: string; content: string; timestamp: string | null; channel: string | null; }
interface LTMItem { id?: string; content?: string; type?: string; importance?: number; created_at?: string; [key: string]: unknown; }
interface UserProfile {
	userId: string; displayName: string | null; communicationStyle: string; preferredLanguage: string;
	expertiseAreas: Record<string, number>; preferences: Record<string, string>;
	decisions: { description: string; choice: string; reasoning: string; timestamp: string }[];
	workflowPatterns: { name: string; steps: string[]; frequency: number; lastUsed: string }[];
	traits: string[]; conversationCount: number; createdAt: string; updatedAt: string;
}

export const MemoryPage: React.FC = () => {
	const [activeTab, setActiveTab] = useState<TabId>("overview");
	const [stats, setStats] = useState<MemoryStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState<string | null>(null);

	// STM
	const [stmTurns, setStmTurns] = useState<STMTurn[]>([]);
	const [stmTotal, setStmTotal] = useState(0);

	// LTM
	const [ltmItems, setLtmItems] = useState<LTMItem[]>([]);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<LTMItem[]>([]);
	const [searching, setSearching] = useState(false);

	// Daily
	const [dailyContext, setDailyContext] = useState("");
	const [dailyStructured, setDailyStructured] = useState<{ summary: string; rawMessages: any[] } | null>(null);
	const [dailyCount, setDailyCount] = useState(0);
	const [dailyDate, setDailyDate] = useState("");

	// Profile
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [editingName, setEditingName] = useState(false);
	const [tempName, setTempName] = useState("");

	// Consolidation
	const [consolidating, setConsolidating] = useState(false);

	useEffect(() => {
		apiGet<MemoryStats>("/api/memory/stats").then((s) => { setStats(s); setLoading(false); }).catch((e) => { setMsg(e.message); setLoading(false); });
	}, []);

	const loadTab = useCallback(async (tab: TabId) => {
		setActiveTab(tab);
		try {
			if (tab === "stm") {
				const data = await apiGet<{ turns: STMTurn[]; total: number }>("/api/memory/stm");
				setStmTurns(data.turns ?? []); setStmTotal(data.total ?? 0);
			} else if (tab === "ltm") {
				const data = await apiGet<{ memories: LTMItem[] }>("/api/memory/ltm/recent?limit=30");
				setLtmItems(data.memories ?? []);
			} else if (tab === "daily") {
				const data = await apiGet<{ context: string; messageCount: number; date: string; structured: any }>("/api/memory/daily");
				setDailyContext(data.context ?? ""); 
				setDailyStructured(data.structured ?? null);
				setDailyCount(data.messageCount ?? 0); 
				setDailyDate(data.date ?? "");
			} else if (tab === "profile") {
				const data = await apiGet<{ profile: UserProfile | null }>("/api/memory/profile");
				setProfile(data.profile ?? null);
				setTempName(data.profile?.displayName ?? "");
			}
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const handleSearch = async () => {
		if (!searchQuery.trim()) return;
		setSearching(true);
		try {
			const r = await apiGet<{ results: LTMItem[] }>(`/api/memory/search?q=${encodeURIComponent(searchQuery)}`);
			setSearchResults(r.results ?? []);
		} catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
		finally { setSearching(false); }
	};

	const handleConsolidate = async () => {
		setConsolidating(true); setMsg(null);
		try {
			await apiPost("/api/memory/consolidate");
			setMsg("✓ Consolidación completada");
		} catch (e) { setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`); }
		finally { setConsolidating(false); }
	};

	const handleSaveName = async () => {
		try {
			await apiPut("/api/memory/profile", { displayName: tempName });
			setMsg("✓ Nombre actualizado");
			setEditingName(false);
			loadTab("profile");
		} catch (e) { setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`); }
	};

	const tabs: { id: TabId; label: string; icon: string }[] = [
		{ id: "overview", label: "Resumen", icon: "📊" },
		{ id: "stm", label: "Corto Plazo", icon: "⚡" },
		{ id: "ltm", label: "Largo Plazo", icon: "🗃️" },
		{ id: "daily", label: "Diaria", icon: "📅" },
		{ id: "profile", label: "Perfil", icon: "👤" },
	];

	const S = {
		card: { padding: "14px", borderRadius: "8px", backgroundColor: "#18181b", border: "1px solid #27272a" } as React.CSSProperties,
		section: { padding: "16px", borderRadius: "10px", backgroundColor: "#18181b", border: "1px solid #27272a", marginBottom: "16px" } as React.CSSProperties,
		input: { flex: 1, padding: "10px 14px", borderRadius: "8px", border: "1px solid #27272a", background: "#0f1117", color: "#e4e4e7", fontSize: "0.9rem", outline: "none" } as React.CSSProperties,
	};

	if (loading) return <div style={{ padding: 40, color: "#666" }}>Cargando memoria...</div>;

	return (
		<div className="page-shell page-shell--xl" style={{ padding: "24px", overflowY: "auto", height: "100%" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
				<h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>🧠 Memoria</h2>
				<div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
					{tabs.map((t) => (
						<button key={t.id} type="button" onClick={() => loadTab(t.id)} style={{
							padding: "7px 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 500,
							backgroundColor: activeTab === t.id ? "#3b82f6" : "#27272a",
							color: activeTab === t.id ? "#fff" : "#a1a1aa",
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
					color: msg.startsWith("✓") ? "#22c55e" : "#ef4444",
				}}>
					{msg}
				</div>
			)}

			{/* Overview */}
			{activeTab === "overview" && (
				<>
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
						<StatCard icon="⚡" title="Habilitada" value={stats?.enabled ? "Sí" : "No"} color={stats?.enabled ? "#22c55e" : "#ef4444"} />
						<StatCard icon="📏" title="STM Max Tokens" value={stats?.shortTerm?.maxTokens ?? "—"} />
						<StatCard icon="🗃️" title="LTM Max Items" value={stats?.longTerm?.maxItems?.toLocaleString() ?? "—"} />
						<StatCard icon="🎯" title="Umbral Importancia" value={stats?.longTerm?.importanceThreshold ?? "—"} />
						<StatCard icon="🔍" title="Resultados Max" value={stats?.retrieval?.maxResults ?? "—"} />
						<StatCard icon="📊" title="Relevancia Min" value={stats?.retrieval?.minRelevance ?? "—"} />
					</div>
					<button type="button" onClick={handleConsolidate} disabled={consolidating} style={{
						padding: "10px 20px", borderRadius: 8, border: "none",
						background: consolidating ? "#333" : "#7c3aed", color: consolidating ? "#666" : "#fff",
						cursor: consolidating ? "not-allowed" : "pointer", fontWeight: 600,
					}}>
						{consolidating ? "Consolidando..." : "🔄 Consolidar ahora"}
					</button>
					<span style={{ fontSize: "0.78rem", color: "#666", marginLeft: 10 }}>Transfiere recuerdos corto → largo plazo</span>
				</>
			)}

			{/* STM */}
			{activeTab === "stm" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>⚡ Memoria a Corto Plazo ({stmTotal} turnos)</h3>
					{stmTurns.length === 0 ? (
						<div style={{ color: "#525252", fontSize: "0.85rem" }}>Sin conversaciones recientes</div>
					) : (
						stmTurns.map((t, i) => (
							<div key={`stm-${i}`} style={{
								padding: 10, borderRadius: 6, background: "#0f1117", marginBottom: 6,
								borderLeft: `3px solid ${t.role === "user" ? "#3b82f6" : "#22c55e"}`,
							}}>
								<div style={{ fontSize: "0.75rem", color: "#525252", marginBottom: 2 }}>
									{t.role === "user" ? "👤 Usuario" : "🐙 Asistente"}
									{t.channel ? ` · ${t.channel}` : ""}
									{t.timestamp ? ` · ${new Date(t.timestamp).toLocaleTimeString()}` : ""}
								</div>
								<div style={{ fontSize: "0.85rem", color: "#d4d4d8" }}>{t.content}</div>
							</div>
						))
					)}
				</div>
			)}

			{/* LTM */}
			{activeTab === "ltm" && (
				<>
					<div style={{ ...S.section }}>
						<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>🔍 Buscar en Memoria</h3>
						<div style={{ display: "flex", gap: 8 }}>
							<input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && handleSearch()} placeholder="Buscar recuerdos..." style={S.input} />
							<button type="button" onClick={handleSearch} disabled={searching} style={{
								padding: "10px 20px", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", cursor: "pointer", fontWeight: 600,
							}}>
								{searching ? "..." : "Buscar"}
							</button>
						</div>
						{searchResults.length > 0 && (
							<div style={{ marginTop: 12 }}>
								{searchResults.map((r, i) => (
									<div key={`sr-${i}`} style={{ padding: 10, borderRadius: 6, background: "#0f1117", marginBottom: 6, borderLeft: "3px solid #7c3aed" }}>
										<div style={{ fontSize: "0.75rem", color: "#525252", marginBottom: 2 }}>
											{(r as Record<string, unknown>).type as string ?? "memory"} · {r.created_at ? new Date(r.created_at as string).toLocaleString() : ""}
										</div>
										<div style={{ fontSize: "0.85rem", color: "#d4d4d8" }}>{typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? r)}</div>
									</div>
								))}
							</div>
						)}
					</div>
					<div style={S.section}>
						<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>📋 Memorias Recientes</h3>
						{ltmItems.length === 0 ? (
							<div style={{ color: "#525252", fontSize: "0.85rem" }}>Sin memorias almacenadas</div>
						) : (
							ltmItems.map((m, i) => (
								<div key={`ltm-${i}`} style={{ padding: 10, borderRadius: 6, background: "#0f1117", marginBottom: 6, borderLeft: `3px solid ${m.type === "episodic" ? "#f59e0b" : m.type === "fact" ? "#22c55e" : "#6366f1"}` }}>
									<div style={{ fontSize: "0.75rem", color: "#525252", marginBottom: 2 }}>
										{m.type ?? "unknown"} · importancia: {m.importance ?? "?"} · {m.created_at ? new Date(m.created_at).toLocaleString() : ""}
									</div>
									<div style={{ fontSize: "0.85rem", color: "#d4d4d8" }}>
										{typeof m.content === "string" ? (m.content.length > 300 ? `${m.content.substring(0, 300)}...` : m.content) : JSON.stringify(m)}
									</div>
								</div>
							))
						)}
					</div>
				</>
			)}

			{/* Daily */}
			{activeTab === "daily" && (
				<div style={S.section}>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
						<h3 style={{ margin: 0, fontSize: "1.1rem", display: "flex", alignItems: "center", gap: 8 }}>
							<span>📅</span> Memoria Diaria
						</h3>
						<span style={{ fontSize: "0.85rem", color: "#a1a1aa", backgroundColor: "#27272a", padding: "4px 10px", borderRadius: 12 }}>
							{typeof dailyDate === "object" ? JSON.stringify(dailyDate) : String(dailyDate)}
						</span>
					</div>

					{dailyStructured ? (
						<>
							{/* Global Summary */}
							<div style={{ padding: 16, borderRadius: 8, background: "linear-gradient(145deg, #1e1b4b20, #312e8110)", border: "1px solid #4338ca40", marginBottom: 20 }}>
								<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem", color: "#818cf8", display: "flex", alignItems: "center", gap: 6 }}>
									<span>📝</span> Resumen del Día
								</h4>
								<div style={{ color: "#e4e4e7", fontSize: "0.9rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
									{dailyStructured.summary ? dailyStructured.summary.trim() : <span style={{ color: "#71717a", fontStyle: "italic" }}>Sin resumen disponible todavía.</span>}
								</div>
							</div>

							{/* Recent Activity */}
							<div>
								<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
									<h4 style={{ margin: 0, fontSize: "0.95rem", color: "#d4d4d8", display: "flex", alignItems: "center", gap: 6 }}>
										<span>⏱️</span> Actividad Reciente sin Resumir
									</h4>
									<span style={{ fontSize: "0.75rem", color: "#71717a" }}>
										{dailyStructured.rawMessages?.length ?? 0} mensajes en buffer hoy
									</span>
								</div>

								{dailyStructured.rawMessages && dailyStructured.rawMessages.length > 0 ? (
									<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
										{dailyStructured.rawMessages.map((msg, idx) => (
											<div key={msg.id ?? idx} style={{ 
												padding: 12, borderRadius: 8, background: "#0f1117", borderLeft: `3px solid ${msg.role === 'user' ? '#3b82f6' : msg.role === 'system' ? '#8b5cf6' : '#22c55e'}`
											}}>
												<div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: "0.75rem" }}>
													<span style={{ color: "#a1a1aa", fontWeight: 600, textTransform: "capitalize" }}>
														{msg.role === 'user' ? '👤 Usuario' : msg.role === 'system' ? '⚙️ Sistema' : '🐙 Asistente'}
													</span>
													<span style={{ color: "#525252" }}>
														{msg.source} · {msg.created_at ? new Date(msg.created_at).toLocaleTimeString() : ""}
													</span>
												</div>
												<div style={{ fontSize: "0.85rem", color: "#d4d4d8", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
													{msg.content}
												</div>
											</div>
										))}
									</div>
								) : (
									<div style={{ padding: 20, textAlign: "center", color: "#525252", fontSize: "0.85rem", background: "#0f1117", borderRadius: 8, border: "1px dashed #27272a" }}>
										No hay nueva actividad pendiente de resumir.
									</div>
								)}
							</div>
						</>
					) : (
						<div style={{ color: "#525252", fontSize: "0.85rem", padding: 20, textAlign: "center", background: "#0f1117", borderRadius: 8 }}>
							Sin actividad registrada hoy
						</div>
					)}
				</div>
			)}

			{/* Profile */}
			{activeTab === "profile" && (
				<>
					{!profile ? (
						<div style={{ ...S.section, textAlign: "center", color: "#525252", padding: 40 }}>
							El perfil de usuario se creará automáticamente cuando interactúes con el agente.
						</div>
					) : (
						<>
							<div style={{ ...S.section, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
								<div style={{ width: 56, height: 56, borderRadius: "50%", background: "linear-gradient(135deg, #7c3aed, #3b82f6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
									👤
								</div>
								<div style={{ flex: 1 }}>
									{editingName ? (
										<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
											<input type="text" value={tempName} onChange={(e) => setTempName(e.target.value)} style={{ ...S.input, maxWidth: 200 }} />
											<button type="button" onClick={handleSaveName} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#22c55e", color: "#fff", cursor: "pointer", fontSize: 12 }}>✓</button>
											<button type="button" onClick={() => setEditingName(false)} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #27272a", background: "transparent", color: "#a1a1aa", cursor: "pointer", fontSize: 12 }}>✗</button>
										</div>
									) : (
										<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
											<span style={{ fontWeight: 700, fontSize: "1.1rem", color: "#e4e4e7" }}>{profile.displayName ?? "Sin nombre"}</span>
											<button type="button" onClick={() => { setEditingName(true); setTempName(profile.displayName ?? ""); }} style={{
												padding: "2px 8px", borderRadius: 4, border: "1px solid #27272a", background: "transparent", color: "#71717a", cursor: "pointer", fontSize: 11,
											}}>✏️</button>
										</div>
									)}
									<div style={{ fontSize: "0.8rem", color: "#71717a", marginTop: 2 }}>
										Estilo: {profile.communicationStyle} · Idioma: {profile.preferredLanguage} · {profile.conversationCount} conversaciones
									</div>
								</div>
							</div>

							{/* Expertise */}
							{Object.keys(profile.expertiseAreas).length > 0 && (
								<div style={S.section}>
									<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>🎯 Áreas de Experiencia</h4>
									<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
										{Object.entries(profile.expertiseAreas).sort(([, a], [, b]) => b - a).map(([area, conf]) => (
											<div key={area} style={{
												padding: "6px 14px", borderRadius: 20, fontSize: "0.8rem", fontWeight: 500,
												backgroundColor: conf >= 0.7 ? "#22c55e22" : conf >= 0.4 ? "#f59e0b22" : "#3b82f622",
												color: conf >= 0.7 ? "#22c55e" : conf >= 0.4 ? "#f59e0b" : "#3b82f6",
												border: `1px solid ${conf >= 0.7 ? "#22c55e44" : conf >= 0.4 ? "#f59e0b44" : "#3b82f644"}`,
											}}>
												{area} · {Math.round(conf * 100)}%
											</div>
										))}
									</div>
								</div>
							)}

							{/* Preferences */}
							{Object.keys(profile.preferences).length > 0 && (
								<div style={S.section}>
									<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>⚙️ Preferencias</h4>
									<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
										{Object.entries(profile.preferences).map(([k, v]) => (
											<div key={k} style={{ ...S.card, padding: 10 }}>
												<div style={{ fontSize: "0.72rem", color: "#525252", textTransform: "uppercase" }}>{k}</div>
												<div style={{ fontSize: "0.85rem", color: "#e4e4e7", fontWeight: 500 }}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</div>
											</div>
										))}
									</div>
								</div>
							)}

							{/* Traits */}
							{profile.traits.length > 0 && (
								<div style={S.section}>
									<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>🏷️ Rasgos</h4>
									<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
										{profile.traits.map((t) => (
											<span key={String(t)} style={{ padding: "4px 12px", borderRadius: 16, fontSize: "0.8rem", backgroundColor: "#27272a", color: "#a1a1aa" }}>
												{typeof t === "object" ? JSON.stringify(t) : String(t)}
											</span>
										))}
									</div>
								</div>
							)}

							{/* Decisions */}
							{profile.decisions.length > 0 && (
								<div style={S.section}>
									<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>📋 Decisiones Recientes</h4>
									{profile.decisions.slice(-10).reverse().map((d, i) => (
										<div key={`dec-${i}`} style={{ padding: 10, borderRadius: 6, background: "#0f1117", marginBottom: 6, borderLeft: "3px solid #f59e0b" }}>
											<div style={{ fontSize: "0.85rem", color: "#e4e4e7", fontWeight: 500 }}>{d.description}</div>
											<div style={{ fontSize: "0.78rem", color: "#71717a", marginTop: 2 }}>Eligió: {d.choice}</div>
											{d.reasoning && <div style={{ fontSize: "0.75rem", color: "#525252", marginTop: 2 }}>Razón: {d.reasoning}</div>}
										</div>
									))}
								</div>
							)}
						</>
					)}
				</>
			)}
		</div>
	);
};

const StatCard: React.FC<{ icon: string; title: string; value: string | number; color?: string }> = ({ icon, title, value, color = "#e0e0e0" }) => (
	<div style={{ padding: 14, borderRadius: 8, background: "#18181b", border: "1px solid #27272a", textAlign: "center" }}>
		<div style={{ fontSize: "1.4rem", marginBottom: 4 }}>{icon}</div>
		<div style={{ fontSize: "0.75rem", color: "#666", marginBottom: 4 }}>{title}</div>
		<div style={{ fontSize: "1.1rem", fontWeight: 600, color }}>{value}</div>
	</div>
);
