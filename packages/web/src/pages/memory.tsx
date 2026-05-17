import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon, type AppIconName } from "../components/ui/AppIcon.js";
import { Loading } from "../components/ui/Loading.js";
import {
	apiDelete,
	apiGet,
	apiPost,
	apiPut,
	apiPutJson,
} from "../hooks/useApi.js";

type TabId =
	| "overview"
	| "graph"
	| "learning"
	| "stm"
	| "ltm"
	| "daily"
	| "profile";

type LearningInsightFilter =
	| "all"
	| "what_worked"
	| "what_failed"
	| "procedure"
	| "anti_pattern"
	| "tool_strategy"
	| "skill_candidate";

interface MemoryStats {
	enabled: boolean;
	shortTerm: { maxTokens?: number; [key: string]: unknown };
	longTerm: {
		maxItems?: number;
		importanceThreshold?: number;
		[key: string]: unknown;
	};
	consolidation: { [key: string]: unknown };
	retrieval: {
		maxResults?: number;
		minRelevance?: number;
		[key: string]: unknown;
	};
}

interface STMTurn {
	role: string;
	content: string;
	timestamp: string | null;
	channel: string | null;
}
interface LTMItem {
	id?: string;
	content?: string;
	type?: string;
	importance?: number;
	created_at?: string;
	createdAt?: string;
	[key: string]: unknown;
}
interface DailyMessage {
	id?: string;
	role?: string;
	source?: string;
	created_at?: string;
	content?: string;
	[key: string]: unknown;
}
interface DailyStructured {
	summary?: string;
	rawMessages?: DailyMessage[];
}
interface UserProfile {
	userId: string;
	displayName: string | null;
	communicationStyle: string;
	preferredLanguage: string;
	expertiseAreas: Record<string, number>;
	preferences: Record<string, string>;
	decisions: {
		description: string;
		choice: string;
		reasoning: string;
		timestamp: string;
	}[];
	workflowPatterns: {
		name: string;
		steps: string[];
		frequency: number;
		lastUsed: string;
	}[];
	traits: string[];
	conversationCount: number;
	createdAt: string;
	updatedAt: string;
}

interface LearningInsight {
	id: string;
	type: string;
	domain?: string | null;
	keywords?: string[];
	content: string;
	evidence?: string | null;
	confidence: number;
	importance: number;
	useCount: number;
	createdAt: string;
}

interface LearningSettings {
	enabled: boolean;
	autoReflect: boolean;
	autoCreateSkills: boolean;
	retainFailedInsights: boolean;
}

interface LearningExperience {
	id: string;
	userRequest: string;
	finalResponse: string;
	status: "succeeded" | "failed" | "partial" | "unknown";
	confidence: number;
	toolsUsed: Array<{ name: string; success: boolean; summary?: string }>;
	skillsUsed: Array<{ id: string; name: string; level?: number }>;
	durationMs?: number;
	metadata?: {
		feedback?: Array<{
			rating: "positive" | "negative" | number;
			comment?: string;
			at?: string;
			messageId?: string;
		}>;
		[key: string]: unknown;
	};
	createdAt: string;
}

type LearningExperienceStatusFilter = "all" | LearningExperience["status"];

interface GraphNode {
	id: string;
	label: string;
	type: string;
	weight: number;
	content: string;
	keywords: string[];
	source: "memory" | "learning";
}

const LEARNING_FILTERS: LearningInsightFilter[] = [
	"all",
	"procedure",
	"tool_strategy",
	"anti_pattern",
	"what_worked",
	"what_failed",
	"skill_candidate",
];

const EXPERIENCE_STATUS_FILTERS: LearningExperienceStatusFilter[] = [
	"all",
	"succeeded",
	"partial",
	"failed",
	"unknown",
];

const getMemoryCreatedAt = (item: LTMItem): string | undefined => {
	const value = item.created_at ?? item.createdAt;
	return typeof value === "string" ? value : undefined;
};

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
	const [searchPerformed, setSearchPerformed] = useState(false);
	const [learningInsights, setLearningInsights] = useState<LearningInsight[]>(
		[],
	);
	const [selectedGraphNode, setSelectedGraphNode] = useState<string | null>(
		null,
	);
	const [learningFilter, setLearningFilter] =
		useState<LearningInsightFilter>("all");
	const [forgettingInsightId, setForgettingInsightId] = useState<string | null>(
		null,
	);
	const [feedbackExperienceId, setFeedbackExperienceId] = useState<
		string | null
	>(null);
	const [learningSettings, setLearningSettings] =
		useState<LearningSettings | null>(null);
	const [learningExperiences, setLearningExperiences] = useState<
		LearningExperience[]
	>([]);
	const [feedbackComments, setFeedbackComments] = useState<
		Record<string, string>
	>({});
	const [experienceStatusFilter, setExperienceStatusFilter] =
		useState<LearningExperienceStatusFilter>("all");
	const [savingLearningKey, setSavingLearningKey] = useState<string | null>(
		null,
	);

	// Daily
	const [dailyContext, setDailyContext] = useState("");
	const [dailyStructured, setDailyStructured] = useState<{
		summary?: string;
		rawMessages?: DailyMessage[];
	} | null>(null);
	const [dailyCount, setDailyCount] = useState(0);
	const [dailyDate, setDailyDate] = useState("");

	// Profile
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [editingName, setEditingName] = useState(false);
	const [tempName, setTempName] = useState("");

	// Consolidation
	const [consolidating, setConsolidating] = useState(false);

	useEffect(() => {
		apiGet<MemoryStats>("/api/memory/stats")
			.then((s) => {
				setStats(s);
				setLoading(false);
			})
			.catch((e) => {
				setMsg(e.message);
				setLoading(false);
			});
	}, []);

	const loadLearningInsights = useCallback(
		async (
			filter: LearningInsightFilter = learningFilter,
			statusFilter: LearningExperienceStatusFilter = experienceStatusFilter,
		) => {
			const typeParam =
				filter === "all" ? "" : `&type=${encodeURIComponent(filter)}`;
			const statusParam =
				statusFilter === "all"
					? ""
					: `&status=${encodeURIComponent(statusFilter)}`;
			const [data, experienceData] = await Promise.all([
				apiGet<{
					config?: LearningSettings;
					insights: LearningInsight[];
				}>(`/api/learning/insights?limit=100${typeParam}`),
				apiGet<{ experiences: LearningExperience[] }>(
					`/api/learning/experiences?limit=20${statusParam}`,
				).catch(() => ({ experiences: [] })),
			]);
			setLearningInsights(data.insights ?? []);
			setLearningExperiences(experienceData.experiences ?? []);
			setLearningSettings(data.config ?? null);
		},
		[experienceStatusFilter, learningFilter],
	);

	const loadTab = useCallback(
		async (tab: TabId) => {
			setActiveTab(tab);
			try {
				if (tab === "stm") {
					const data = await apiGet<{ turns: STMTurn[]; total: number }>(
						"/api/memory/stm",
					);
					setStmTurns(data.turns ?? []);
					setStmTotal(data.total ?? 0);
				} else if (tab === "graph") {
					const [memories, insights] = await Promise.all([
						apiGet<{ memories: LTMItem[] }>("/api/memory/ltm/recent?limit=40"),
						apiGet<{ insights: LearningInsight[] }>(
							"/api/learning/insights?limit=60",
						).catch(() => ({ insights: [] })),
					]);
					setLtmItems(memories.memories ?? []);
					setLearningInsights(insights.insights ?? []);
				} else if (tab === "learning") {
					await loadLearningInsights();
				} else if (tab === "ltm") {
					const data = await apiGet<{ memories: LTMItem[] }>(
						"/api/memory/ltm/recent?limit=30",
					);
					setLtmItems(data.memories ?? []);
				} else if (tab === "daily") {
					const data = await apiGet<{
						context: string;
						messageCount: number;
						date: string;
						structured: DailyStructured | null;
					}>("/api/memory/daily");
					setDailyContext(data.context ?? "");
					setDailyStructured(data.structured ?? null);
					setDailyCount(data.messageCount ?? 0);
					setDailyDate(data.date ?? "");
				} else if (tab === "profile") {
					const data = await apiGet<{ profile: UserProfile | null }>(
						"/api/memory/profile",
					);
					setProfile(data.profile ?? null);
					setTempName(data.profile?.displayName ?? "");
				}
			} catch (e) {
				setMsg(e instanceof Error ? e.message : String(e));
			}
		},
		[loadLearningInsights],
	);

	const handleSearch = async () => {
		if (!searchQuery.trim()) return;
		setSearchPerformed(true);
		setSearching(true);
		try {
			const r = await apiGet<{ results: LTMItem[] }>(
				`/api/memory/search?q=${encodeURIComponent(searchQuery)}`,
			);
			setSearchResults(r.results ?? []);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setSearching(false);
		}
	};

	const handleConsolidate = async () => {
		setConsolidating(true);
		setMsg(null);
		try {
			await apiPost("/api/memory/consolidate");
			setMsg("✓ Consolidación completada");
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setConsolidating(false);
		}
	};

	const handleSaveName = async () => {
		try {
			await apiPutJson("/api/memory/profile", { displayName: tempName });
			setMsg("✓ Nombre actualizado");
			setEditingName(false);
			loadTab("profile");
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const handleFilterLearning = async (filter: LearningInsightFilter) => {
		setLearningFilter(filter);
		try {
			await loadLearningInsights(filter, experienceStatusFilter);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};

	const handleExperienceStatusFilter = async (
		statusFilter: LearningExperienceStatusFilter,
	) => {
		setExperienceStatusFilter(statusFilter);
		try {
			await loadLearningInsights(learningFilter, statusFilter);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};

	const handleForgetInsight = async (insight: LearningInsight) => {
		if (forgettingInsightId !== insight.id) {
			setForgettingInsightId(insight.id);
			return;
		}
		try {
			await apiDelete(
				`/api/learning/insights/${encodeURIComponent(insight.id)}`,
			);
			setMsg("✓ Aprendizaje eliminado");
			setForgettingInsightId(null);
			await loadLearningInsights();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const handleLearningSettingToggle = async (key: keyof LearningSettings) => {
		if (!learningSettings) return;
		const previous = learningSettings;
		const next = { ...learningSettings, [key]: !learningSettings[key] };
		setLearningSettings(next);
		setSavingLearningKey(key);
		try {
			await apiPut(`/api/config/learning.${key}`, next[key]);
			setMsg(`✓ Learning '${key}' actualizado`);
		} catch (e) {
			setLearningSettings(previous);
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSavingLearningKey(null);
		}
	};

	const handleExperienceFeedback = async (
		experience: LearningExperience,
		rating: "positive" | "negative",
	) => {
		setFeedbackExperienceId(experience.id);
		const fallbackComment =
			rating === "positive"
				? "Marcado como correcto desde la UI"
				: "Marcado como incorrecto desde la UI";
		const comment = feedbackComments[experience.id]?.trim() || fallbackComment;
		try {
			await apiPost("/api/learning/feedback", {
				experienceId: experience.id,
				rating,
				comment,
			});
			setFeedbackComments((previous) => {
				const next = { ...previous };
				delete next[experience.id];
				return next;
			});
			setMsg(
				rating === "positive"
					? "✓ Experiencia marcada como correcta"
					: "✓ Experiencia marcada como incorrecta",
			);
			await loadLearningInsights();
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setFeedbackExperienceId(null);
		}
	};

	const tabs: { id: TabId; label: string; icon: AppIconName }[] = [
		{ id: "overview", label: "Resumen", icon: "activity" },
		{ id: "graph", label: "Grafo", icon: "spark" },
		{ id: "learning", label: "Aprendizajes", icon: "check" },
		{ id: "stm", label: "Corto Plazo", icon: "chat" },
		{ id: "ltm", label: "Largo Plazo", icon: "database" },
		{ id: "daily", label: "Diaria", icon: "file" },
		{ id: "profile", label: "Perfil", icon: "user" },
	];

	const S = {
		card: {
			padding: "14px",
			borderRadius: "8px",
			backgroundColor: "#18181b",
			border: "1px solid #27272a",
		} as React.CSSProperties,
		section: {
			padding: "16px",
			borderRadius: "10px",
			backgroundColor: "#18181b",
			border: "1px solid #27272a",
			marginBottom: "16px",
		} as React.CSSProperties,
		input: {
			flex: 1,
			padding: "10px 14px",
			borderRadius: "8px",
			border: "1px solid #27272a",
			background: "#0f1117",
			color: "#e4e4e7",
			fontSize: "0.9rem",
			outline: "none",
		} as React.CSSProperties,
	};

	const graph = buildMemoryGraph(ltmItems, learningInsights);
	const selectedNode = graph.nodes.find(
		(node) => node.id === selectedGraphNode,
	);
	const selectedEdges = selectedNode
		? graph.edges.filter(
				(edge) => edge.from === selectedNode.id || edge.to === selectedNode.id,
			)
		: [];
	const latestFeedbackByExperience = new Map(
		learningExperiences.map((experience) => [
			experience.id,
			experience.metadata?.feedback?.at(-1),
		]),
	);

	if (loading) return <Loading text="Cargando memoria..." />;

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
				<h2
					style={{
						margin: 0,
						fontSize: "20px",
						fontWeight: 700,
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<AppIcon name="brain" size={22} /> Base de Memoria
				</h2>
				<div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => loadTab(t.id)}
							style={{
								padding: "7px 14px",
								borderRadius: "8px",
								border: "none",
								cursor: "pointer",
								fontSize: "13px",
								fontWeight: 500,
								backgroundColor: activeTab === t.id ? "#3b82f6" : "#27272a",
								color: activeTab === t.id ? "#fff" : "#a1a1aa",
							}}
						>
							<span
								style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
							>
								<AppIcon name={t.icon} size={14} /> {t.label}
							</span>
						</button>
					))}
				</div>
			</div>

			{msg && (
				<div
					style={{
						padding: "10px 16px",
						borderRadius: 8,
						marginBottom: 12,
						fontSize: "0.85rem",
						background: msg.startsWith("✓")
							? "rgba(34,197,94,0.1)"
							: "rgba(239,68,68,0.1)",
						color: msg.startsWith("✓") ? "#22c55e" : "#ef4444",
					}}
				>
					{msg}
				</div>
			)}

			{/* Overview */}
			{activeTab === "overview" && (
				<>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
							gap: 10,
							marginBottom: 20,
						}}
					>
						<StatCard
							icon="brain"
							title="Habilitada"
							value={stats?.enabled ? "Sí" : "No"}
							color={stats?.enabled ? "#22c55e" : "#ef4444"}
						/>
						<StatCard
							icon="chat"
							title="STM Max Tokens"
							value={stats?.shortTerm?.maxTokens ?? "—"}
						/>
						<StatCard
							icon="database"
							title="LTM Max Items"
							value={stats?.longTerm?.maxItems?.toLocaleString() ?? "—"}
						/>
						<StatCard
							icon="activity"
							title="Umbral Importancia"
							value={stats?.longTerm?.importanceThreshold ?? "—"}
						/>
						<StatCard
							icon="settings"
							title="Resultados Max"
							value={stats?.retrieval?.maxResults ?? "—"}
						/>
						<StatCard
							icon="check"
							title="Relevancia Min"
							value={stats?.retrieval?.minRelevance ?? "—"}
						/>
					</div>
					<button
						type="button"
						onClick={handleConsolidate}
						disabled={consolidating || !stats?.enabled}
						style={{
							padding: "10px 20px",
							borderRadius: 8,
							border: "none",
							background: consolidating || !stats?.enabled ? "#333" : "#7c3aed",
							color: consolidating || !stats?.enabled ? "#666" : "#fff",
							cursor:
								consolidating || !stats?.enabled ? "not-allowed" : "pointer",
							fontWeight: 600,
						}}
					>
						{consolidating ? "Consolidando..." : "🔄 Consolidar ahora"}
					</button>
					<span style={{ fontSize: "0.78rem", color: "#666", marginLeft: 10 }}>
						{stats?.enabled
							? "Transfiere recuerdos corto → largo plazo"
							: "Activa la memoria en Configuración para consolidar"}
					</span>
				</>
			)}

			{activeTab === "graph" && (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
						gap: 16,
					}}
				>
					<div style={S.section}>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								gap: 12,
								alignItems: "center",
								marginBottom: 14,
								flexWrap: "wrap",
							}}
						>
							<h3 style={{ margin: 0, fontSize: "1rem" }}>
								Mapa de conocimiento ({graph.nodes.length} nodos,{" "}
								{graph.edges.length} conexiones)
							</h3>
							<button
								type="button"
								onClick={() => loadTab("graph")}
								style={{
									padding: "7px 12px",
									borderRadius: 8,
									border: "1px solid #27272a",
									background: "#0f1117",
									color: "#a1a1aa",
									cursor: "pointer",
								}}
							>
								Actualizar
							</button>
						</div>
						{graph.nodes.length === 0 ? (
							<div style={{ color: "#71717a", fontSize: "0.85rem" }}>
								Sin memorias o aprendizajes disponibles para visualizar.
							</div>
						) : (
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
									gap: 10,
								}}
							>
								{graph.nodes.map((node) => (
									<button
										key={node.id}
										type="button"
										onClick={() => setSelectedGraphNode(node.id)}
										style={{
											textAlign: "left",
											padding: 12,
											borderRadius: 12,
											border:
												selectedGraphNode === node.id
													? "1px solid #818cf8"
													: "1px solid #27272a",
											background:
												node.source === "learning"
													? "rgba(124,58,237,0.16)"
													: "rgba(59,130,246,0.14)",
											color: "#e4e4e7",
											cursor: "pointer",
										}}
									>
										<div style={{ fontWeight: 700, fontSize: "0.85rem" }}>
											{node.label}
										</div>
										<div
											style={{
												color: "#a1a1aa",
												fontSize: "0.73rem",
												marginTop: 5,
											}}
										>
											{node.source} · {node.type} · peso{" "}
											{Math.round(node.weight * 100)}%
										</div>
										<div
											style={{
												color: "#71717a",
												fontSize: "0.72rem",
												marginTop: 8,
											}}
										>
											{node.keywords.slice(0, 4).join(", ") || "sin keywords"}
										</div>
									</button>
								))}
							</div>
						)}
					</div>

					<div style={S.section}>
						<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
							Nodo seleccionado
						</h3>
						{selectedNode ? (
							<div>
								<div
									style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: 6 }}
								>
									{selectedNode.label}
								</div>
								<div
									style={{
										color: "#71717a",
										fontSize: "0.78rem",
										marginBottom: 12,
									}}
								>
									{selectedNode.source} · {selectedNode.type} ·{" "}
									{selectedEdges.length} conexiones
								</div>
								<div
									style={{
										color: "#d4d4d8",
										fontSize: "0.85rem",
										lineHeight: 1.5,
									}}
								>
									{selectedNode.content}
								</div>
								{selectedEdges.slice(0, 12).map((edge) => {
									const otherId =
										edge.from === selectedNode.id ? edge.to : edge.from;
									const other = graph.nodes.find((node) => node.id === otherId);
									return (
										<div
											key={`${edge.from}-${edge.to}`}
											style={{
												padding: "8px 10px",
												borderRadius: 8,
												background: "#0f1117",
												marginTop: 8,
												fontSize: "0.78rem",
												color: "#a1a1aa",
											}}
										>
											{other?.label ?? otherId} · {edge.keywords.join(", ")}
										</div>
									);
								})}
							</div>
						) : (
							<div style={{ color: "#71717a", fontSize: "0.85rem" }}>
								Selecciona un nodo para inspeccionar contenido, fuente y
								relaciones.
							</div>
						)}
					</div>
				</div>
			)}

			{activeTab === "learning" && (
				<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
					{learningSettings && (
						<div
							style={{
								...S.section,
								display: "grid",
								gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
								gap: 10,
							}}
						>
							<LearningConfigToggle
								label="Learning"
								description="Registra experiencias y recupera aprendizajes relevantes."
								checked={learningSettings.enabled}
								saving={savingLearningKey === "enabled"}
								onClick={() => handleLearningSettingToggle("enabled")}
							/>
							<LearningConfigToggle
								label="Reflexión LLM"
								description="Extrae insights con ayuda del modelo cuando aplica."
								checked={learningSettings.autoReflect}
								saving={savingLearningKey === "autoReflect"}
								onClick={() => handleLearningSettingToggle("autoReflect")}
							/>
							<LearningConfigToggle
								label="Crear skills"
								description="Convierte patrones repetidos exitosos en habilidades."
								checked={learningSettings.autoCreateSkills}
								saving={savingLearningKey === "autoCreateSkills"}
								onClick={() => handleLearningSettingToggle("autoCreateSkills")}
							/>
							<LearningConfigToggle
								label="Guardar fallos"
								description="Conserva anti-patrones y errores para no repetirlos."
								checked={learningSettings.retainFailedInsights}
								saving={savingLearningKey === "retainFailedInsights"}
								onClick={() =>
									handleLearningSettingToggle("retainFailedInsights")
								}
							/>
						</div>
					)}

					<div style={S.section}>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								gap: 12,
								alignItems: "center",
								flexWrap: "wrap",
							}}
						>
							<div>
								<h3 style={{ margin: "0 0 4px", fontSize: "1rem" }}>
									Aprendizajes automáticos
								</h3>
								<div style={{ color: "#71717a", fontSize: "0.8rem" }}>
									{learningInsights.length} insight(s) cargados desde el motor
									de learning
								</div>
							</div>
							<button
								type="button"
								onClick={() => loadLearningInsights()}
								style={{
									padding: "7px 12px",
									borderRadius: 8,
									border: "1px solid #27272a",
									background: "#0f1117",
									color: "#a1a1aa",
									cursor: "pointer",
								}}
							>
								Actualizar
							</button>
						</div>
						<div
							style={{
								display: "flex",
								gap: 6,
								flexWrap: "wrap",
								marginTop: 14,
							}}
						>
							{LEARNING_FILTERS.map((filter) => (
								<button
									key={filter}
									type="button"
									onClick={() => handleFilterLearning(filter)}
									style={{
										padding: "6px 10px",
										borderRadius: 999,
										border: "1px solid #27272a",
										background:
											learningFilter === filter ? "#3b82f6" : "#0f1117",
										color: learningFilter === filter ? "#fff" : "#a1a1aa",
										cursor: "pointer",
										fontSize: "0.75rem",
									}}
								>
									{getLearningFilterLabel(filter)}
								</button>
							))}
						</div>
					</div>

					<div style={S.section}>
						<h3 style={{ margin: "0 0 4px", fontSize: "1rem" }}>
							Experiencias recientes
						</h3>
						<div
							style={{ color: "#71717a", fontSize: "0.8rem", marginBottom: 12 }}
						>
							{learningExperiences.length} ejecución(es) registradas para
							auditar éxitos, parciales y fallos.
						</div>
						<div
							style={{
								display: "flex",
								gap: 6,
								flexWrap: "wrap",
								marginBottom: 12,
							}}
						>
							{EXPERIENCE_STATUS_FILTERS.map((statusFilter) => (
								<button
									key={statusFilter}
									type="button"
									onClick={() => handleExperienceStatusFilter(statusFilter)}
									style={{
										padding: "5px 9px",
										borderRadius: 999,
										border: `1px solid ${getExperienceStatusFilterColor(statusFilter)}55`,
										background:
											experienceStatusFilter === statusFilter
												? `${getExperienceStatusFilterColor(statusFilter)}22`
												: "#0f1117",
										color:
											experienceStatusFilter === statusFilter
												? getExperienceStatusFilterColor(statusFilter)
												: "#a1a1aa",
										cursor: "pointer",
										fontSize: "0.72rem",
									}}
								>
									{getExperienceStatusFilterLabel(statusFilter)}
								</button>
							))}
						</div>
						{learningExperiences.length === 0 ? (
							<div style={{ color: "#71717a", fontSize: "0.85rem" }}>
								Sin experiencias registradas todavía.
							</div>
						) : (
							<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
								{learningExperiences.slice(0, 8).map((experience) => {
									const latestFeedback = latestFeedbackByExperience.get(
										experience.id,
									);
									return (
										<div
											key={experience.id}
											style={{
												padding: 10,
												borderRadius: 8,
												background: "#0f1117",
												borderLeft: `3px solid ${getExperienceColor(experience.status)}`,
											}}
										>
											<div
												style={{
													display: "flex",
													justifyContent: "space-between",
													gap: 10,
													flexWrap: "wrap",
													alignItems: "center",
												}}
											>
												<span
													style={{
														fontSize: "0.72rem",
														fontWeight: 700,
														color: getExperienceColor(experience.status),
													}}
												>
													{getExperienceStatusLabel(experience.status)}
												</span>
												<div
													style={{
														display: "flex",
														gap: 8,
														alignItems: "center",
														flexWrap: "wrap",
													}}
												>
													<span
														style={{ color: "#71717a", fontSize: "0.72rem" }}
													>
														conf {Math.round(experience.confidence * 100)}%
														{experience.durationMs
															? ` · ${experience.durationMs}ms`
															: ""}
														· {new Date(experience.createdAt).toLocaleString()}
													</span>
													<button
														type="button"
														onClick={() =>
															handleExperienceFeedback(experience, "positive")
														}
														disabled={feedbackExperienceId === experience.id}
														style={{
															padding: "4px 8px",
															borderRadius: 6,
															border: "1px solid #22c55e44",
															background: "transparent",
															color: "#22c55e",
															cursor:
																feedbackExperienceId === experience.id
																	? "wait"
																	: "pointer",
															fontSize: "0.7rem",
														}}
													>
														Correcta
													</button>
													<button
														type="button"
														onClick={() =>
															handleExperienceFeedback(experience, "negative")
														}
														disabled={feedbackExperienceId === experience.id}
														style={{
															padding: "4px 8px",
															borderRadius: 6,
															border: "1px solid #ef444444",
															background: "transparent",
															color: "#ef4444",
															cursor:
																feedbackExperienceId === experience.id
																	? "wait"
																	: "pointer",
															fontSize: "0.7rem",
														}}
													>
														Incorrecta
													</button>
												</div>
											</div>
											<div
												style={{
													color: "#e4e4e7",
													fontSize: "0.84rem",
													fontWeight: 600,
													marginTop: 5,
												}}
											>
												{truncateText(experience.userRequest, 180)}
											</div>
											<div
												style={{
													color: "#a1a1aa",
													fontSize: "0.78rem",
													marginTop: 4,
												}}
											>
												{truncateText(experience.finalResponse, 220)}
											</div>
											<input
												type="text"
												value={feedbackComments[experience.id] ?? ""}
												onChange={(event) =>
													setFeedbackComments((previous) => ({
														...previous,
														[experience.id]: event.target.value,
													}))
												}
												placeholder="Nota opcional para convertir esta experiencia en aprendizaje"
												style={{
													width: "100%",
													boxSizing: "border-box",
													marginTop: 8,
													padding: "7px 9px",
													borderRadius: 7,
													border: "1px solid #27272a",
													background: "#09090b",
													color: "#e4e4e7",
													fontSize: "0.74rem",
													outline: "none",
												}}
											/>
											{latestFeedback && (
												<div
													style={{
														marginTop: 8,
														padding: "7px 9px",
														borderRadius: 7,
														background: "rgba(59,130,246,0.08)",
														border: "1px solid #3b82f633",
														color: "#bfdbfe",
														fontSize: "0.72rem",
													}}
												>
													Feedback:{" "}
													{getExperienceFeedbackLabel(latestFeedback.rating)}
													{latestFeedback.comment
														? ` · ${latestFeedback.comment}`
														: ""}
													{latestFeedback.at
														? ` · ${new Date(latestFeedback.at).toLocaleString()}`
														: ""}
												</div>
											)}
											{experience.skillsUsed.length > 0 && (
												<div
													style={{
														display: "flex",
														gap: 5,
														flexWrap: "wrap",
														marginTop: 8,
													}}
												>
													{experience.skillsUsed.slice(0, 6).map((skill) => (
														<span
															key={`${experience.id}-${skill.id}`}
															style={{
																fontSize: "0.68rem",
																color: "#c4b5fd",
																background: "rgba(124,58,237,0.14)",
																padding: "2px 6px",
																borderRadius: 999,
															}}
														>
															Skill: {skill.name}
															{skill.level ? ` L${skill.level}` : ""}
														</span>
													))}
												</div>
											)}
											{experience.toolsUsed.length > 0 && (
												<div
													style={{
														display: "flex",
														gap: 5,
														flexWrap: "wrap",
														marginTop: 8,
													}}
												>
													{experience.toolsUsed.slice(0, 6).map((tool) => (
														<span
															key={`${experience.id}-${tool.name}`}
															style={{
																fontSize: "0.68rem",
																color: tool.success ? "#22c55e" : "#ef4444",
																background: tool.success
																	? "rgba(34,197,94,0.1)"
																	: "rgba(239,68,68,0.1)",
																padding: "2px 6px",
																borderRadius: 999,
															}}
														>
															{tool.name}
														</span>
													))}
												</div>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>

					{learningInsights.length === 0 ? (
						<div
							style={{ ...S.section, color: "#71717a", textAlign: "center" }}
						>
							Aún no hay aprendizajes para este filtro. Se crearán al registrar
							experiencias exitosas, parciales o fallidas.
						</div>
					) : (
						learningInsights.map((insight) => (
							<div
								key={insight.id}
								style={{
									...S.section,
									marginBottom: 0,
									borderLeft: `4px solid ${getInsightColor(insight.type)}`,
								}}
							>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										gap: 12,
										flexWrap: "wrap",
										marginBottom: 8,
									}}
								>
									<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
										<span
											style={{
												fontSize: "0.72rem",
												fontWeight: 700,
												color: getInsightColor(insight.type),
												background: `${getInsightColor(insight.type)}18`,
												padding: "3px 8px",
												borderRadius: 999,
											}}
										>
											{insight.type.replaceAll("_", " ")}
										</span>
										{insight.domain && (
											<span style={{ fontSize: "0.75rem", color: "#71717a" }}>
												{insight.domain}
											</span>
										)}
									</div>
									<div
										style={{ display: "flex", gap: 8, alignItems: "center" }}
									>
										<span style={{ fontSize: "0.75rem", color: "#71717a" }}>
											conf {Math.round(insight.confidence * 100)}% · imp{" "}
											{Math.round(insight.importance * 100)}% · usado{" "}
											{insight.useCount}
										</span>
										<button
											type="button"
											onClick={() => handleForgetInsight(insight)}
											style={{
												padding: "5px 10px",
												borderRadius: 6,
												border: "1px solid #ef444444",
												background: "transparent",
												color: "#ef4444",
												cursor: "pointer",
												fontSize: "0.75rem",
											}}
										>
											{forgettingInsightId === insight.id
												? "Confirmar"
												: "Olvidar"}
										</button>
									</div>
								</div>
								<div
									style={{
										color: "#d4d4d8",
										fontSize: "0.86rem",
										lineHeight: 1.55,
									}}
								>
									{insight.content}
								</div>
								{insight.evidence && (
									<div
										style={{
											color: "#71717a",
											fontSize: "0.75rem",
											marginTop: 8,
										}}
									>
										Evidencia: {insight.evidence}
									</div>
								)}
								{insight.keywords && insight.keywords.length > 0 && (
									<div
										style={{
											display: "flex",
											gap: 5,
											flexWrap: "wrap",
											marginTop: 10,
										}}
									>
										{insight.keywords.slice(0, 12).map((keyword) => (
											<span
												key={keyword}
												style={{
													fontSize: "0.68rem",
													color: "#a1a1aa",
													background: "#27272a",
													padding: "2px 6px",
													borderRadius: 999,
												}}
											>
												{keyword}
											</span>
										))}
									</div>
								)}
							</div>
						))
					)}
				</div>
			)}

			{/* STM */}
			{activeTab === "stm" && (
				<div style={S.section}>
					<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
						⚡ Memoria a Corto Plazo ({stmTotal} turnos)
					</h3>
					{stmTurns.length === 0 ? (
						<div style={{ color: "#525252", fontSize: "0.85rem" }}>
							Sin conversaciones recientes
						</div>
					) : (
						stmTurns.map((t) => (
							<div
								key={`${t.timestamp ?? "sin-fecha"}-${t.role}-${t.content.slice(0, 32)}`}
								style={{
									padding: 10,
									borderRadius: 6,
									background: "#0f1117",
									marginBottom: 6,
									borderLeft: `3px solid ${t.role === "user" ? "#3b82f6" : "#22c55e"}`,
								}}
							>
								<div
									style={{
										fontSize: "0.75rem",
										color: "#525252",
										marginBottom: 2,
									}}
								>
									{t.role === "user" ? "👤 Usuario" : "🐙 Asistente"}
									{t.channel ? ` · ${t.channel}` : ""}
									{t.timestamp
										? ` · ${new Date(t.timestamp).toLocaleTimeString()}`
										: ""}
								</div>
								<div style={{ fontSize: "0.85rem", color: "#d4d4d8" }}>
									{t.content}
								</div>
							</div>
						))
					)}
				</div>
			)}

			{/* LTM */}
			{activeTab === "ltm" && (
				<>
					<div style={{ ...S.section }}>
						<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
							🔍 Buscar en Memoria
						</h3>
						<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
							<input
								id="memory-search"
								name="memorySearch"
								type="text"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && handleSearch()}
								placeholder="Buscar recuerdos..."
								style={S.input}
							/>
							<button
								type="button"
								onClick={handleSearch}
								disabled={searching}
								style={{
									padding: "10px 20px",
									borderRadius: 8,
									border: "none",
									background: "#7c3aed",
									color: "#fff",
									cursor: "pointer",
									fontWeight: 600,
								}}
							>
								{searching ? "..." : "Buscar"}
							</button>
						</div>
						{searchResults.length > 0 && (
							<div style={{ marginTop: 12 }}>
								<div
									style={{
										color: "#71717a",
										fontSize: "0.78rem",
										marginBottom: 8,
									}}
								>
									{searchResults.length} resultado(s) para "{searchQuery}"
								</div>
								{searchResults.map((r) => (
									<div
										key={
											r.id ??
											`${getMemoryCreatedAt(r) ?? "sin-fecha"}-${String(r.content).slice(0, 32)}`
										}
										style={{
											padding: 10,
											borderRadius: 6,
											background: "#0f1117",
											marginBottom: 6,
											borderLeft: "3px solid #7c3aed",
										}}
									>
										<div
											style={{
												fontSize: "0.75rem",
												color: "#525252",
												marginBottom: 2,
											}}
										>
											{((r as Record<string, unknown>).type as string) ??
												"memory"}{" "}
											·{" "}
											{getMemoryCreatedAt(r)
												? new Date(
														getMemoryCreatedAt(r) as string,
													).toLocaleString()
												: ""}
										</div>
										<div style={{ fontSize: "0.85rem", color: "#d4d4d8" }}>
											{typeof r.content === "string"
												? r.content
												: JSON.stringify(r.content ?? r)}
										</div>
									</div>
								))}
							</div>
						)}
						{searchPerformed && !searching && searchResults.length === 0 && (
							<div
								style={{
									marginTop: 12,
									padding: 14,
									borderRadius: 8,
									background: "#0f1117",
									color: "#71717a",
									border: "1px dashed #27272a",
								}}
							>
								Sin resultados para "{searchQuery}".
							</div>
						)}
					</div>
					<div style={S.section}>
						<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
							📋 Memorias Recientes
						</h3>
						{ltmItems.length === 0 ? (
							<div style={{ color: "#525252", fontSize: "0.85rem" }}>
								Sin memorias almacenadas
							</div>
						) : (
							ltmItems.map((m) => (
								<div
									key={
										m.id ??
										`${getMemoryCreatedAt(m) ?? "sin-fecha"}-${String(m.content).slice(0, 32)}`
									}
									style={{
										padding: 10,
										borderRadius: 6,
										background: "#0f1117",
										marginBottom: 6,
										borderLeft: `3px solid ${m.type === "episodic" ? "#f59e0b" : m.type === "fact" ? "#22c55e" : "#6366f1"}`,
									}}
								>
									<div
										style={{
											fontSize: "0.75rem",
											color: "#525252",
											marginBottom: 2,
										}}
									>
										{m.type ?? "unknown"} · importancia: {m.importance ?? "?"} ·{" "}
										{getMemoryCreatedAt(m)
											? new Date(
													getMemoryCreatedAt(m) as string,
												).toLocaleString()
											: ""}
									</div>
									<div style={{ fontSize: "0.85rem", color: "#d4d4d8" }}>
										{typeof m.content === "string"
											? m.content.length > 300
												? `${m.content.substring(0, 300)}...`
												: m.content
											: JSON.stringify(m)}
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
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "baseline",
							marginBottom: 16,
						}}
					>
						<h3
							style={{
								margin: 0,
								fontSize: "1.1rem",
								display: "flex",
								alignItems: "center",
								gap: 8,
							}}
						>
							<span>📅</span> Memoria Diaria
						</h3>
						<span
							style={{
								fontSize: "0.85rem",
								color: "#a1a1aa",
								backgroundColor: "#27272a",
								padding: "4px 10px",
								borderRadius: 12,
							}}
						>
							{typeof dailyDate === "object"
								? JSON.stringify(dailyDate)
								: String(dailyDate)}
						</span>
					</div>

					{dailyStructured ? (
						<>
							{/* Global Summary */}
							<div
								style={{
									padding: 16,
									borderRadius: 8,
									background: "linear-gradient(145deg, #1e1b4b20, #312e8110)",
									border: "1px solid #4338ca40",
									marginBottom: 20,
								}}
							>
								<h4
									style={{
										margin: "0 0 10px",
										fontSize: "0.95rem",
										color: "#818cf8",
										display: "flex",
										alignItems: "center",
										gap: 6,
									}}
								>
									<span>📝</span> Resumen del Día
								</h4>
								<div
									style={{
										color: "#e4e4e7",
										fontSize: "0.9rem",
										lineHeight: 1.6,
										whiteSpace: "pre-wrap",
									}}
								>
									{dailyStructured.summary ? (
										dailyStructured.summary.trim()
									) : (
										<span style={{ color: "#71717a", fontStyle: "italic" }}>
											Sin resumen disponible todavía.
										</span>
									)}
								</div>
							</div>

							{/* Recent Activity */}
							<div>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										marginBottom: 12,
									}}
								>
									<h4
										style={{
											margin: 0,
											fontSize: "0.95rem",
											color: "#d4d4d8",
											display: "flex",
											alignItems: "center",
											gap: 6,
										}}
									>
										<span>⏱️</span> Actividad Reciente sin Resumir
									</h4>
									<span style={{ fontSize: "0.75rem", color: "#71717a" }}>
										{dailyStructured.rawMessages?.length ?? 0} mensajes en
										buffer hoy
									</span>
								</div>

								{dailyStructured.rawMessages &&
								dailyStructured.rawMessages.length > 0 ? (
									<div
										style={{ display: "flex", flexDirection: "column", gap: 8 }}
									>
										{dailyStructured.rawMessages.map((msg) => (
											<div
												key={
													msg.id ??
													`${msg.created_at ?? "sin-fecha"}-${String(msg.content).slice(0, 32)}`
												}
												style={{
													padding: 12,
													borderRadius: 8,
													background: "#0f1117",
													borderLeft: `3px solid ${msg.role === "user" ? "#3b82f6" : msg.role === "system" ? "#8b5cf6" : "#22c55e"}`,
												}}
											>
												<div
													style={{
														display: "flex",
														justifyContent: "space-between",
														marginBottom: 4,
														fontSize: "0.75rem",
													}}
												>
													<span
														style={{
															color: "#a1a1aa",
															fontWeight: 600,
															textTransform: "capitalize",
														}}
													>
														{msg.role === "user"
															? "👤 Usuario"
															: msg.role === "system"
																? "⚙️ Sistema"
																: "🐙 Asistente"}
													</span>
													<span style={{ color: "#525252" }}>
														{msg.source} ·{" "}
														{msg.created_at
															? new Date(msg.created_at).toLocaleTimeString()
															: ""}
													</span>
												</div>
												<div
													style={{
														fontSize: "0.85rem",
														color: "#d4d4d8",
														whiteSpace: "pre-wrap",
														overflowWrap: "anywhere",
													}}
												>
													{msg.content}
												</div>
											</div>
										))}
									</div>
								) : (
									<div
										style={{
											padding: 20,
											textAlign: "center",
											color: "#525252",
											fontSize: "0.85rem",
											background: "#0f1117",
											borderRadius: 8,
											border: "1px dashed #27272a",
										}}
									>
										No hay nueva actividad pendiente de resumir.
									</div>
								)}
							</div>
						</>
					) : (
						<div
							style={{
								color: "#525252",
								fontSize: "0.85rem",
								padding: 20,
								textAlign: "center",
								background: "#0f1117",
								borderRadius: 8,
							}}
						>
							Sin actividad registrada hoy
						</div>
					)}
				</div>
			)}

			{/* Profile */}
			{activeTab === "profile" &&
				(!profile ? (
					<div
						style={{
							...S.section,
							textAlign: "center",
							color: "#525252",
							padding: 40,
						}}
					>
						El perfil de usuario se creará automáticamente cuando interactúes
						con el agente.
					</div>
				) : (
					<>
						<div
							style={{
								...S.section,
								display: "flex",
								gap: 16,
								alignItems: "center",
								flexWrap: "wrap",
							}}
						>
							<div
								style={{
									width: 56,
									height: 56,
									borderRadius: "50%",
									background: "linear-gradient(135deg, #7c3aed, #3b82f6)",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									fontSize: 24,
									flexShrink: 0,
								}}
							>
								👤
							</div>
							<div style={{ flex: 1 }}>
								{editingName ? (
									<div
										style={{ display: "flex", gap: 8, alignItems: "center" }}
									>
										<input
											id="memory-profile-name"
											name="displayName"
											type="text"
											value={tempName}
											onChange={(e) => setTempName(e.target.value)}
											style={{ ...S.input, maxWidth: 200 }}
										/>
										<button
											type="button"
											onClick={handleSaveName}
											style={{
												padding: "6px 14px",
												borderRadius: 6,
												border: "none",
												background: "#22c55e",
												color: "#fff",
												cursor: "pointer",
												fontSize: 12,
											}}
										>
											✓
										</button>
										<button
											type="button"
											onClick={() => setEditingName(false)}
											style={{
												padding: "6px 14px",
												borderRadius: 6,
												border: "1px solid #27272a",
												background: "transparent",
												color: "#a1a1aa",
												cursor: "pointer",
												fontSize: 12,
											}}
										>
											✗
										</button>
									</div>
								) : (
									<div
										style={{ display: "flex", gap: 8, alignItems: "center" }}
									>
										<span
											style={{
												fontWeight: 700,
												fontSize: "1.1rem",
												color: "#e4e4e7",
											}}
										>
											{profile.displayName ?? "Sin nombre"}
										</span>
										<button
											type="button"
											onClick={() => {
												setEditingName(true);
												setTempName(profile.displayName ?? "");
											}}
											style={{
												padding: "2px 8px",
												borderRadius: 4,
												border: "1px solid #27272a",
												background: "transparent",
												color: "#71717a",
												cursor: "pointer",
												fontSize: 11,
											}}
										>
											✏️
										</button>
									</div>
								)}
								<div
									style={{
										fontSize: "0.8rem",
										color: "#71717a",
										marginTop: 2,
									}}
								>
									Estilo: {profile.communicationStyle} · Idioma:{" "}
									{profile.preferredLanguage} · {profile.conversationCount}{" "}
									conversaciones
								</div>
							</div>
						</div>

						{/* Expertise */}
						{Object.keys(profile.expertiseAreas).length > 0 && (
							<div style={S.section}>
								<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>
									🎯 Áreas de Experiencia
								</h4>
								<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
									{Object.entries(profile.expertiseAreas)
										.sort(([, a], [, b]) => b - a)
										.map(([area, conf]) => (
											<div
												key={area}
												style={{
													padding: "6px 14px",
													borderRadius: 20,
													fontSize: "0.8rem",
													fontWeight: 500,
													backgroundColor:
														conf >= 0.7
															? "#22c55e22"
															: conf >= 0.4
																? "#f59e0b22"
																: "#3b82f622",
													color:
														conf >= 0.7
															? "#22c55e"
															: conf >= 0.4
																? "#f59e0b"
																: "#3b82f6",
													border: `1px solid ${conf >= 0.7 ? "#22c55e44" : conf >= 0.4 ? "#f59e0b44" : "#3b82f644"}`,
												}}
											>
												{area} · {Math.round(conf * 100)}%
											</div>
										))}
								</div>
							</div>
						)}

						{/* Preferences */}
						{Object.keys(profile.preferences).length > 0 && (
							<div style={S.section}>
								<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>
									⚙️ Preferencias
								</h4>
								<div
									style={{
										display: "grid",
										gridTemplateColumns:
											"repeat(auto-fill, minmax(200px, 1fr))",
										gap: 8,
									}}
								>
									{Object.entries(profile.preferences).map(([k, v]) => (
										<div key={k} style={{ ...S.card, padding: 10 }}>
											<div
												style={{
													fontSize: "0.72rem",
													color: "#525252",
													textTransform: "uppercase",
												}}
											>
												{k}
											</div>
											<div
												style={{
													fontSize: "0.85rem",
													color: "#e4e4e7",
													fontWeight: 500,
												}}
											>
												{typeof v === "object" ? JSON.stringify(v) : String(v)}
											</div>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Traits */}
						{profile.traits.length > 0 && (
							<div style={S.section}>
								<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>
									🏷️ Rasgos
								</h4>
								<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
									{profile.traits.map((t) => (
										<span
											key={String(t)}
											style={{
												padding: "4px 12px",
												borderRadius: 16,
												fontSize: "0.8rem",
												backgroundColor: "#27272a",
												color: "#a1a1aa",
											}}
										>
											{typeof t === "object" ? JSON.stringify(t) : String(t)}
										</span>
									))}
								</div>
							</div>
						)}

						{/* Decisions */}
						{profile.decisions.length > 0 && (
							<div style={S.section}>
								<h4 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>
									📋 Decisiones Recientes
								</h4>
								{profile.decisions
									.slice(-10)
									.reverse()
									.map((d) => (
										<div
											key={`${d.timestamp}-${d.description.slice(0, 32)}`}
											style={{
												padding: 10,
												borderRadius: 6,
												background: "#0f1117",
												marginBottom: 6,
												borderLeft: "3px solid #f59e0b",
											}}
										>
											<div
												style={{
													fontSize: "0.85rem",
													color: "#e4e4e7",
													fontWeight: 500,
												}}
											>
												{d.description}
											</div>
											<div
												style={{
													fontSize: "0.78rem",
													color: "#71717a",
													marginTop: 2,
												}}
											>
												Eligió: {d.choice}
											</div>
											{d.reasoning && (
												<div
													style={{
														fontSize: "0.75rem",
														color: "#525252",
														marginTop: 2,
													}}
												>
													Razón: {d.reasoning}
												</div>
											)}
										</div>
									))}
							</div>
						)}
					</>
				))}
		</div>
	);
};

const StatCard: React.FC<{
	icon: AppIconName;
	title: string;
	value: string | number;
	color?: string;
}> = ({ icon, title, value, color = "#e0e0e0" }) => (
	<div
		style={{
			padding: 14,
			borderRadius: 8,
			background: "#18181b",
			border: "1px solid #27272a",
			textAlign: "center",
		}}
	>
		<div style={{ color, marginBottom: 4 }}>
			<AppIcon name={icon} size={22} />
		</div>
		<div style={{ fontSize: "0.75rem", color: "#666", marginBottom: 4 }}>
			{title}
		</div>
		<div style={{ fontSize: "1.1rem", fontWeight: 600, color }}>{value}</div>
	</div>
);

const LearningConfigToggle: React.FC<{
	label: string;
	description: string;
	checked: boolean;
	saving: boolean;
	onClick: () => void;
}> = ({ label, description, checked, saving, onClick }) => (
	<button
		type="button"
		onClick={onClick}
		disabled={saving}
		style={{
			padding: 12,
			borderRadius: 10,
			border: checked ? "1px solid #22c55e55" : "1px solid #27272a",
			background: checked ? "rgba(34,197,94,0.08)" : "#0f1117",
			color: "#e4e4e7",
			cursor: saving ? "wait" : "pointer",
			textAlign: "left",
		}}
	>
		<div
			style={{
				display: "flex",
				justifyContent: "space-between",
				gap: 8,
				alignItems: "center",
			}}
		>
			<span style={{ fontWeight: 700, fontSize: "0.85rem" }}>{label}</span>
			<span
				style={{
					fontSize: "0.7rem",
					color: checked ? "#22c55e" : "#71717a",
				}}
			>
				{saving ? "..." : checked ? "ON" : "OFF"}
			</span>
		</div>
		<div style={{ color: "#71717a", fontSize: "0.75rem", marginTop: 5 }}>
			{description}
		</div>
	</button>
);

function getLearningFilterLabel(filter: LearningInsightFilter): string {
	const labels: Record<LearningInsightFilter, string> = {
		all: "Todos",
		what_worked: "Qué funcionó",
		what_failed: "Qué falló",
		procedure: "Procedimientos",
		anti_pattern: "Anti-patrones",
		tool_strategy: "Estrategias tool",
		skill_candidate: "Candidatos skill",
	};
	return labels[filter];
}

function getInsightColor(type: string): string {
	if (type === "what_failed" || type === "anti_pattern") return "#ef4444";
	if (type === "what_worked" || type === "procedure") return "#22c55e";
	if (type === "tool_strategy") return "#3b82f6";
	if (type === "skill_candidate") return "#a78bfa";
	return "#f59e0b";
}

function getExperienceColor(status: LearningExperience["status"]): string {
	if (status === "succeeded") return "#22c55e";
	if (status === "failed") return "#ef4444";
	if (status === "partial") return "#f59e0b";
	return "#71717a";
}

function getExperienceStatusFilterColor(
	status: LearningExperienceStatusFilter,
): string {
	return status === "all" ? "#3b82f6" : getExperienceColor(status);
}

function getExperienceStatusFilterLabel(
	status: LearningExperienceStatusFilter,
): string {
	return status === "all" ? "Todas" : getExperienceStatusLabel(status);
}

function getExperienceStatusLabel(
	status: LearningExperience["status"],
): string {
	const labels: Record<LearningExperience["status"], string> = {
		succeeded: "exitosa",
		failed: "fallida",
		partial: "parcial",
		unknown: "sin clasificar",
	};
	return labels[status];
}

function getExperienceFeedbackLabel(
	rating: "positive" | "negative" | number,
): string {
	if (typeof rating === "number")
		return rating > 0 ? `+${rating}` : String(rating);
	return rating === "positive" ? "correcta" : "incorrecta";
}

function truncateText(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function buildMemoryGraph(memories: LTMItem[], insights: LearningInsight[]) {
	const nodes: GraphNode[] = [
		...memories.map((memory, index) => {
			const content = formatMemoryContent(memory);
			return {
				id: `memory-${memory.id ?? index}`,
				label: `${memory.type ?? "memoria"} ${index + 1}`,
				type: memory.type ?? "memory",
				weight: typeof memory.importance === "number" ? memory.importance : 0.5,
				content,
				keywords: extractGraphKeywords(content),
				source: "memory" as const,
			};
		}),
		...insights.map((insight, index) => ({
			id: `insight-${insight.id ?? index}`,
			label: insight.type.replaceAll("_", " "),
			type: insight.domain ?? insight.type,
			weight: Math.max(insight.importance ?? 0, insight.confidence ?? 0.5),
			content: insight.content,
			keywords: Array.from(
				new Set([
					...(insight.keywords ?? []),
					...extractGraphKeywords(insight.content),
				]),
			).slice(0, 12),
			source: "learning" as const,
		})),
	].sort((a, b) => b.weight - a.weight);

	const edges: Array<{ from: string; to: string; keywords: string[] }> = [];
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const left = nodes[i];
			const right = nodes[j];
			if (!left || !right) continue;
			const overlap = left.keywords.filter((keyword) =>
				right.keywords.includes(keyword),
			);
			if (overlap.length > 0) {
				edges.push({
					from: left.id,
					to: right.id,
					keywords: overlap.slice(0, 4),
				});
			}
		}
	}

	return { nodes: nodes.slice(0, 60), edges };
}

function formatMemoryContent(memory: LTMItem): string {
	return typeof memory.content === "string"
		? memory.content
		: JSON.stringify(memory.content ?? memory);
}

function extractGraphKeywords(text: string): string[] {
	const stop = new Set([
		"para",
		"como",
		"cuando",
		"desde",
		"este",
		"esta",
		"that",
		"this",
		"with",
		"from",
	]);
	const words = text.toLowerCase().match(/[a-z0-9áéíóúñ_-]{4,}/gi) ?? [];
	return Array.from(new Set(words.filter((word) => !stop.has(word)))).slice(
		0,
		12,
	);
}
