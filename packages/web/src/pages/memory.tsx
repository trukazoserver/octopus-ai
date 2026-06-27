import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type GraphViewEdge,
	type GraphViewNode,
	MemoryGraphView,
} from "../components/memory/MemoryGraphView.js";
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
	| "knowledge"
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

interface KnowledgeCollection {
	id: string;
	name: string;
	description: string | null;
	updated_at: string;
}

interface KnowledgeItem {
	id: string;
	collection_id: string;
	title: string | null;
	source_type: string;
	source_uri: string | null;
	status: string;
	updated_at: string;
}

interface KnowledgeSearchResult {
	id: string;
	item_id: string;
	content: string;
	modality: string;
	item_title: string | null;
	collection_id: string;
}

type LearningExperienceStatusFilter = "all" | LearningExperience["status"];

interface GraphNode {
	id: string;
	label: string;
	type: string;
	weight: number;
	content: string;
	keywords: string[];
	source: "memory" | "learning" | "profile" | "daily" | "shortTerm";
}

interface GraphEdge {
	from: string;
	to: string;
	keywords: string[];
}

interface DashboardGraphContext {
	profile: UserProfile | null;
	dailySummary?: string;
	dailyCount?: number;
	stmTurns?: STMTurn[];
	stmTotal?: number;
}

type GraphSource = GraphNode["source"];
type GraphSourceFilter = GraphSource | "all";

interface GraphClusterDef {
	source: GraphSource;
	label: string;
	x: number;
	y: number;
	radiusX: number;
	radiusY: number;
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

const GRAPH_CLUSTER_DEFS: GraphClusterDef[] = [
	{
		source: "shortTerm",
		label: "Corto plazo",
		x: 48,
		y: 25,
		radiusX: 10,
		radiusY: 8,
	},
	{
		source: "learning",
		label: "Aprendizaje",
		x: 31,
		y: 34,
		radiusX: 12,
		radiusY: 10,
	},
	{
		source: "memory",
		label: "Largo plazo",
		x: 64,
		y: 34,
		radiusX: 14,
		radiusY: 11,
	},
	{
		source: "profile",
		label: "Usuario",
		x: 63,
		y: 55,
		radiusX: 10,
		radiusY: 8,
	},
	{
		source: "daily",
		label: "Diaria",
		x: 33,
		y: 55,
		radiusX: 10,
		radiusY: 8,
	},
];

const GRAPH_SOURCE_FILTERS: Array<{ id: GraphSourceFilter; label: string }> = [
	{ id: "all", label: "Todas" },
	{ id: "shortTerm", label: "Corto plazo" },
	{ id: "memory", label: "Largo plazo" },
	{ id: "learning", label: "Aprendizaje" },
	{ id: "profile", label: "Usuario" },
	{ id: "daily", label: "Diaria" },
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
	const [ltmTypeFilter, setLtmTypeFilter] = useState<string>("all");
	const [knowledgeCollections, setKnowledgeCollections] = useState<
		KnowledgeCollection[]
	>([]);
	const [selectedKnowledgeCollectionId, setSelectedKnowledgeCollectionId] =
		useState("");
	const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
	const [knowledgeCollectionName, setKnowledgeCollectionName] = useState("");
	const [knowledgeItemTitle, setKnowledgeItemTitle] = useState("");
	const [knowledgeItemContent, setKnowledgeItemContent] = useState("");
	const [knowledgeFilePath, setKnowledgeFilePath] = useState("");
	const [knowledgeFileTitle, setKnowledgeFileTitle] = useState("");
	const [knowledgeQuery, setKnowledgeQuery] = useState("");
	const [knowledgeResults, setKnowledgeResults] = useState<
		KnowledgeSearchResult[]
	>([]);
	const [learningInsights, setLearningInsights] = useState<LearningInsight[]>(
		[],
	);
	const [selectedGraphNode, setSelectedGraphNode] = useState<string | null>(
		null,
	);
	const [openedGraphNode, setOpenedGraphNode] = useState<GraphNode | null>(
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
		let cancelled = false;

		const loadInitialMemoryState = async () => {
			try {
				const [
					statsData,
					memoriesData,
					insightsData,
					dailyData,
					profileData,
					stmData,
				] = await Promise.all([
					apiGet<MemoryStats>("/api/memory/stats"),
					apiGet<{ memories: LTMItem[] }>(
						"/api/memory/ltm/recent?limit=1000",
					).catch(() => ({ memories: [] })),
					apiGet<{ insights: LearningInsight[] }>(
						"/api/learning/insights?limit=1000",
					).catch(() => ({ insights: [] })),
					apiGet<{
						context: string;
						messageCount: number;
						date: string;
						structured: DailyStructured | null;
					}>("/api/memory/daily").catch(() => ({
						context: "",
						messageCount: 0,
						date: "",
						structured: null,
					})),
					apiGet<{ profile: UserProfile | null }>("/api/memory/profile").catch(
						() => ({ profile: null }),
					),
					apiGet<{ turns: STMTurn[]; total: number }>("/api/memory/stm").catch(
						() => ({ turns: [], total: 0 }),
					),
				]);

				if (cancelled) return;

				setStats(statsData);
				setLtmItems(memoriesData.memories ?? []);
				setLearningInsights(insightsData.insights ?? []);
				setDailyContext(dailyData.context ?? "");
				setDailyStructured(dailyData.structured ?? null);
				setDailyCount(dailyData.messageCount ?? 0);
				setDailyDate(dailyData.date ?? "");
				setProfile(profileData.profile ?? null);
				setTempName(profileData.profile?.displayName ?? "");
				setStmTurns(stmData.turns ?? []);
				setStmTotal(stmData.total ?? 0);
			} catch (e) {
				if (!cancelled) setMsg(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setLoading(false);
			}
		};

		loadInitialMemoryState();

		return () => {
			cancelled = true;
		};
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

	const loadKnowledge = useCallback(
		async (collectionId?: string) => {
			const collections = await apiGet<KnowledgeCollection[]>(
				"/api/memory/knowledge/collections",
			).catch(() => []);
			setKnowledgeCollections(collections);
			const selected =
				collectionId ||
				selectedKnowledgeCollectionId ||
				collections[0]?.id ||
				"";
			setSelectedKnowledgeCollectionId(selected);
			if (selected) {
				setKnowledgeItems(
					await apiGet<KnowledgeItem[]>(
						`/api/memory/knowledge/items?collectionId=${encodeURIComponent(selected)}`,
					).catch(() => []),
				);
			} else {
				setKnowledgeItems([]);
			}
		},
		[selectedKnowledgeCollectionId],
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
						apiGet<{ memories: LTMItem[] }>(
							"/api/memory/ltm/recent?limit=1000",
						),
						apiGet<{ insights: LearningInsight[] }>(
							"/api/learning/insights?limit=1000",
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
				} else if (tab === "knowledge") {
					await loadKnowledge();
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
		[loadKnowledge, loadLearningInsights],
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

	const handleCreateKnowledgeCollection = async () => {
		if (!knowledgeCollectionName.trim()) return;
		try {
			const collection = await apiPost("/api/memory/knowledge/collections", {
				name: knowledgeCollectionName.trim(),
			});
			setKnowledgeCollectionName("");
			await loadKnowledge(String(collection.id ?? ""));
			setMsg("✓ Colección creada");
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const handleCreateKnowledgeTextItem = async () => {
		if (!selectedKnowledgeCollectionId || !knowledgeItemContent.trim()) return;
		try {
			await apiPost("/api/memory/knowledge/items/text", {
				collectionId: selectedKnowledgeCollectionId,
				title: knowledgeItemTitle.trim() || "Nota de conocimiento",
				content: knowledgeItemContent,
			});
			setKnowledgeItemTitle("");
			setKnowledgeItemContent("");
			await loadKnowledge(selectedKnowledgeCollectionId);
			setMsg("✓ Conocimiento indexado");
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const handleCreateKnowledgeFileItem = async () => {
		if (!selectedKnowledgeCollectionId || !knowledgeFilePath.trim()) return;
		try {
			await apiPost("/api/memory/knowledge/items/file", {
				collectionId: selectedKnowledgeCollectionId,
				filePath: knowledgeFilePath.trim(),
				title: knowledgeFileTitle.trim() || undefined,
				metadata: { source: "memory-page-file-ingest" },
			});
			setKnowledgeFilePath("");
			setKnowledgeFileTitle("");
			await loadKnowledge(selectedKnowledgeCollectionId);
			setMsg("✓ Archivo multimodal indexado");
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const handleKnowledgeSearch = async () => {
		if (!knowledgeQuery.trim()) return;
		try {
			const params = new URLSearchParams({ q: knowledgeQuery, limit: "20" });
			if (selectedKnowledgeCollectionId) {
				params.set("collectionId", selectedKnowledgeCollectionId);
			}
			setKnowledgeResults(
				await apiGet<KnowledgeSearchResult[]>(
					`/api/memory/knowledge/search?${params.toString()}`,
				),
			);
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
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
		{ id: "knowledge", label: "Conocimiento", icon: "folder" },
		{ id: "daily", label: "Diaria", icon: "file" },
		{ id: "profile", label: "Perfil", icon: "user" },
	];

	const S = {
		card: {
			padding: "12px",
			borderRadius: "12px",
			background: "rgba(9, 9, 11, 0.45)",
			border: "1px solid rgba(255, 255, 255, 0.05)",
		} as React.CSSProperties,
		section: {
			padding: "18px",
			borderRadius: "16px",
			background:
				"linear-gradient(180deg, rgba(24,24,27,0.95), rgba(15,15,18,0.95))",
			border: "1px solid #27272a",
			boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
			marginBottom: "16px",
		} as React.CSSProperties,
		input: {
			flex: 1,
			padding: "10px 14px",
			borderRadius: "10px",
			border: "1px solid #27272a",
			background: "#0f1117",
			color: "#e4e4e7",
			fontSize: "0.9rem",
			outline: "none",
		} as React.CSSProperties,
	};

	const graph = useMemo(
		() =>
			buildMemoryGraph(ltmItems, learningInsights, {
				profile,
				dailySummary: dailyStructured?.summary ?? dailyContext,
				dailyCount,
				stmTurns,
				stmTotal,
			}),
		[
			ltmItems,
			learningInsights,
			profile,
			dailyStructured,
			dailyContext,
			dailyCount,
			stmTurns,
			stmTotal,
		],
	);
	const graphById = useMemo(
		() => new Map(graph.nodes.map((node) => [node.id, node])),
		[graph],
	);
	const graphViewNodes: GraphViewNode[] = useMemo(
		() =>
			graph.nodes.map((node) => ({
				id: node.id,
				label: node.label,
				type: node.type,
				source: node.source,
				weight: node.weight,
				content: node.content,
				keywords: node.keywords,
			})),
		[graph],
	);
	const graphViewEdges: GraphViewEdge[] = useMemo(
		() =>
			graph.edges.map((edge) => ({
				source: edge.from,
				target: edge.to,
				weight: Math.max(1, edge.keywords.length),
			})),
		[graph],
	);
	const selectedNode = graph.nodes.find(
		(node) => node.id === selectedGraphNode,
	);
	const selectedEdges = selectedNode
		? graph.edges.filter(
				(edge) => edge.from === selectedNode.id || edge.to === selectedNode.id,
			)
		: [];

	const tabCounts: Record<TabId, number | undefined> = {
		overview: undefined,
		graph: graph.nodes.length || undefined,
		learning: learningInsights.length || undefined,
		stm: stmTotal || undefined,
		ltm: ltmItems.length || undefined,
		knowledge: knowledgeCollections.length || undefined,
		daily: dailyCount || undefined,
		profile: undefined,
	};
	const openGraphNodeSource = async (node: GraphNode) => {
		const targetTab = getTabForGraphSource(node.source);
		const query = buildGraphNodeSearchQuery(node);
		setOpenedGraphNode(node);
		setSelectedGraphNode(node.id);

		if (targetTab === "ltm") {
			setActiveTab("ltm");
			setSearchQuery(node.label);
			setSearchPerformed(true);
			setSearching(true);
			try {
				// Show the exact memory directly (the graph is built from ltmItems,
				// so the node maps to a real memory by id). Avoids a flaky keyword
				// search that would otherwise report "no results".
				const matched = ltmItems.find((m) => `memory-${m.id}` === node.id);
				if (matched) {
					setSearchResults([matched]);
				} else {
					const results = await apiGet<{ results: LTMItem[] }>(
						`/api/memory/search?q=${encodeURIComponent(query)}`,
					);
					setSearchResults(results.results ?? []);
				}
			} catch (e) {
				setMsg(e instanceof Error ? e.message : String(e));
			} finally {
				setSearching(false);
			}
			return;
		}

		if (targetTab === "learning") {
			const nextFilter = getLearningFilterForGraphNode(node);
			setLearningFilter(nextFilter);
			setActiveTab("learning");
			try {
				await loadLearningInsights(nextFilter, experienceStatusFilter);
			} catch (e) {
				setMsg(e instanceof Error ? e.message : String(e));
			}
			return;
		}

		await loadTab(targetTab);
	};
	const returnToOpenedGraphNode = async () => {
		if (openedGraphNode) setSelectedGraphNode(openedGraphNode.id);
		await loadTab("graph");
	};

	useEffect(() => {
		if (graph.nodes.length === 0) return;
		if (
			!selectedGraphNode ||
			!graph.nodes.some((node) => node.id === selectedGraphNode)
		) {
			setSelectedGraphNode(graph.nodes[0]?.id ?? null);
		}
	}, [graph, selectedGraphNode]);

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
			<div className="cc-header animate-fade-in">
				<div className="cc-header-brand">
					<div className="cc-hero-logo">
						<AppIcon name="brain" size={26} />
					</div>
					<div>
						<div className="mem-header-line">
							<h1 className="ui-page-title" style={{ margin: 0 }}>
								Centro de Memoria
							</h1>
							<span
								className="cc-status-pill"
								style={
									{
										"--pill-color": stats?.enabled ? "#34d399" : "#f87171",
									} as React.CSSProperties
								}
							>
								<span className="cc-status-pill__dot" />
								{stats?.enabled ? "Activa" : "Inactiva"}
							</span>
						</div>
						<p className="ui-page-subtitle" style={{ margin: "6px 0 0" }}>
							Explora, conecta y gestiona lo que Octopus recuerda: memoria de
							trabajo, largo plazo, perfil del usuario y aprendizajes
							operativos.
						</p>
					</div>
				</div>
				<div className="mem-row" style={{ justifyContent: "flex-end" }}>
					<form
						className="mem-search"
						onSubmit={(event) => {
							event.preventDefault();
							void handleSearch();
							setActiveTab("ltm");
						}}
					>
						<AppIcon name="spark" size={15} />
						<input
							value={searchQuery}
							onChange={(event) => setSearchQuery(event.target.value)}
							placeholder="Buscar memorias, conceptos o conexiones..."
						/>
					</form>
					<button
						type="button"
						onClick={handleConsolidate}
						disabled={consolidating || !stats?.enabled}
						className="ui-btn ui-btn--primary"
					>
						<AppIcon name="database" size={16} />
						{consolidating ? "Consolidando" : "Consolidar"}
					</button>
				</div>
			</div>

			<nav
				className="mem-tabbar animate-slide-up"
				aria-label="Grafos de memoria"
			>
				{tabs.map((t) => {
					const count = tabCounts[t.id];
					return (
						<button
							key={t.id}
							type="button"
							onClick={() => loadTab(t.id)}
							className={`mem-tab${activeTab === t.id ? " is-active" : ""}`}
							aria-current={activeTab === t.id ? "page" : undefined}
						>
							<AppIcon name={t.icon} size={16} />
							<span>{t.label}</span>
							{count !== undefined ? (
								<span className="mem-tab__count">{count}</span>
							) : null}
						</button>
					);
				})}
			</nav>
			<p className="ui-section-subtitle" style={{ margin: "-10px 0 18px" }}>
				{getTabDescription(activeTab)}
			</p>

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

			{openedGraphNode && activeTab !== "graph" && activeTab !== "overview" && (
				<MemoryGraphFocusBanner
					node={openedGraphNode}
					query={buildGraphNodeSearchQuery(openedGraphNode)}
					onBackToGraph={() => void returnToOpenedGraphNode()}
					onClear={() => setOpenedGraphNode(null)}
				/>
			)}

			{/* Overview */}
			{activeTab === "overview" && (
				<MemoryOverviewDashboard
					stats={stats}
					graph={graph}
					selectedNode={selectedNode}
					selectedEdges={selectedEdges}
					ltmItems={ltmItems}
					learningInsights={learningInsights}
					profile={profile}
					dailySummary={dailyStructured?.summary ?? dailyContext}
					dailyCount={dailyCount}
					stmTotal={stmTotal}
					stmTurns={stmTurns}
					onSelectNode={setSelectedGraphNode}
					onOpenGraph={() => loadTab("graph")}
					onOpenSource={openGraphNodeSource}
				/>
			)}

			{activeTab === "graph" && (
				<MemoryGraphView
					nodes={graphViewNodes}
					edges={graphViewEdges}
					selectedNodeId={selectedGraphNode}
					onSelectNode={setSelectedGraphNode}
					onOpenNode={(node) => {
						const original = graphById.get(node.id);
						if (original) void openGraphNodeSource(original);
					}}
					height={680}
				/>
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
											learningFilter === filter ? "#6366f1" : "#0f1117",
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
														border: "1px solid #6366f133",
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
				<section className="mem-panel">
					<div className="cc-panel-head" style={{ marginBottom: 14 }}>
						<div>
							<h2 className="ui-section-title">⚡ Memoria a Corto Plazo</h2>
							<p className="ui-section-subtitle">
								{stmTotal} turnos en contexto
								{typeof stats?.shortTerm?.tokens === "number"
									? ` · ${stats.shortTerm.tokens} tokens`
									: ""}
								{typeof stats?.shortTerm?.load === "number"
									? ` · ${Math.round(Number(stats.shortTerm.load))}% de carga`
									: ""}
							</p>
						</div>
					</div>
					{stmTurns.length === 0 ? (
						<div className="ui-empty" style={{ padding: "28px 16px" }}>
							<div className="ui-empty-title">Sin conversaciones recientes</div>
							<div className="ui-empty-desc">
								Los turnos activos aparecerán aquí al conversar con Octopus.
							</div>
						</div>
					) : (
						<div style={{ display: "grid", gap: 8 }}>
							{stmTurns.map((t) => (
								<MemItem
									key={`${t.timestamp ?? "sin-fecha"}-${t.role}-${t.content.slice(0, 32)}`}
									accent={t.role === "user" ? "#6366f1" : "#22c55e"}
									meta={
										<>
											<span
												style={{
													color: t.role === "user" ? "#a5b4fc" : "#86efac",
													fontWeight: 700,
												}}
											>
												{t.role === "user" ? "👤 Usuario" : "🐙 Asistente"}
											</span>
											{t.channel ? <span>· {t.channel}</span> : null}
											{t.timestamp ? (
												<span>
													· {new Date(t.timestamp).toLocaleTimeString()}
												</span>
											) : null}
										</>
									}
								>
									<MemText text={t.content} />
								</MemItem>
							))}
						</div>
					)}
				</section>
			)}

			{/* LTM */}
			{activeTab === "ltm" && (
				<>
					<section className="mem-panel">
						<h2 className="ui-section-title">🔍 Buscar en Memoria</h2>
						<p className="ui-section-subtitle">
							Búsqueda semántica sobre el largo plazo
						</p>
						<div className="mem-row" style={{ marginTop: 12 }}>
							<input
								id="memory-search"
								name="memorySearch"
								type="text"
								className="mem-input"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && handleSearch()}
								placeholder="Buscar recuerdos..."
							/>
							<button
								type="button"
								className="ui-btn ui-btn--secondary"
								onClick={handleSearch}
								disabled={searching}
							>
								{searching ? "Buscando..." : "Buscar"}
							</button>
						</div>
						{searchResults.length > 0 ? (
							<div style={{ display: "grid", gap: 8, marginTop: 14 }}>
								<div className="ui-meta">
									{searchResults.length} resultado(s) para “{searchQuery}”
								</div>
								{searchResults.map((r) => {
									const type =
										((r as Record<string, unknown>).type as string) ?? "memory";
									const accent = MEMORY_TYPE_COLORS[type] ?? "#7c3aed";
									return (
										<MemItem
											key={
												r.id ??
												`${getMemoryCreatedAt(r) ?? "sin-fecha"}-${String(r.content).slice(0, 32)}`
											}
											accent={accent}
											meta={
												<>
													<span style={{ color: accent, fontWeight: 700 }}>
														{type}
													</span>
													{getMemoryCreatedAt(r) ? (
														<span>
															·{" "}
															{new Date(
																getMemoryCreatedAt(r) as string,
															).toLocaleString()}
														</span>
													) : null}
												</>
											}
										>
											<MemText
												text={
													typeof r.content === "string"
														? r.content
														: JSON.stringify(r.content ?? r)
												}
											/>
										</MemItem>
									);
								})}
							</div>
						) : null}
						{searchPerformed && !searching && searchResults.length === 0 ? (
							<div
								className="ui-empty"
								style={{ marginTop: 14, padding: "22px 16px" }}
							>
								<div className="ui-empty-title">Sin resultados</div>
								<div className="ui-empty-desc">
									Nada encontrado para “{searchQuery}”.
								</div>
							</div>
						) : null}
					</section>

					<section className="mem-panel">
						<div className="cc-panel-head" style={{ marginBottom: 12 }}>
							<div>
								<h2 className="ui-section-title">📋 Memorias Recientes</h2>
								<p className="ui-section-subtitle">
									{ltmItems.length} recuerdos almacenados
								</p>
							</div>
						</div>
						{ltmItems.length === 0 ? (
							<div className="ui-empty" style={{ padding: "28px 16px" }}>
								<div className="ui-empty-title">Sin memorias almacenadas</div>
								<div className="ui-empty-desc">
									Las memorias del largo plazo aparecerán tras consolidar.
								</div>
							</div>
						) : (
							<>
								<div
									className="settings-chip-list"
									style={{ marginBottom: 12 }}
								>
									{(
										[
											"all",
											...Array.from(
												new Set(ltmItems.map((m) => m.type ?? "unknown")),
											),
										] as string[]
									).map((t) => {
										const active = ltmTypeFilter === t;
										return (
											<button
												key={t}
												type="button"
												onClick={() => setLtmTypeFilter(t)}
												style={{
													padding: "5px 11px",
													borderRadius: 999,
													border: `1px solid ${active ? "rgba(99,102,241,0.4)" : "rgba(255,255,255,0.08)"}`,
													background: active
														? "rgba(99,102,241,0.14)"
														: "rgba(255,255,255,0.04)",
													color: active ? "#c7d2fe" : "#a1a1aa",
													fontSize: "0.76rem",
													fontWeight: 700,
													cursor: "pointer",
													fontFamily: "inherit",
												}}
											>
												{t === "all" ? "Todos" : t}
											</button>
										);
									})}
								</div>
								<div style={{ display: "grid", gap: 8 }}>
									{ltmItems
										.filter(
											(m) =>
												ltmTypeFilter === "all" ||
												(m.type ?? "unknown") === ltmTypeFilter,
										)
										.map((m) => {
											const type = m.type ?? "unknown";
											const accent = MEMORY_TYPE_COLORS[type] ?? "#6366f1";
											return (
												<MemItem
													key={
														m.id ??
														`${getMemoryCreatedAt(m) ?? "sin-fecha"}-${String(m.content).slice(0, 32)}`
													}
													accent={accent}
													meta={
														<>
															<span style={{ color: accent, fontWeight: 700 }}>
																{type}
															</span>
															<span>· importancia {m.importance ?? "?"}</span>
															{getMemoryCreatedAt(m) ? (
																<span>
																	·{" "}
																	{new Date(
																		getMemoryCreatedAt(m) as string,
																	).toLocaleString()}
																</span>
															) : null}
														</>
													}
												>
													<MemText
														text={
															typeof m.content === "string"
																? m.content
																: JSON.stringify(m)
														}
													/>
												</MemItem>
											);
										})}
								</div>
							</>
						)}
					</section>
				</>
			)}

			{/* Knowledge */}
			{activeTab === "knowledge" && (
				<div className="mem-grid-2">
					{/* Left: actions */}
					<div>
						<section className="mem-panel">
							<h2 className="ui-section-title">📚 Colecciones</h2>
							<p className="ui-section-subtitle">
								Base de conocimiento multimodal (RAG)
							</p>
							<div className="mem-row" style={{ marginTop: 12 }}>
								<input
									type="text"
									className="mem-input"
									value={knowledgeCollectionName}
									onChange={(e) => setKnowledgeCollectionName(e.target.value)}
									placeholder="Nueva colección"
								/>
								<button
									type="button"
									className="ui-btn ui-btn--primary"
									onClick={handleCreateKnowledgeCollection}
								>
									Crear
								</button>
							</div>
							{knowledgeCollections.length > 0 ? (
								<select
									className="mem-input mem-input--block"
									value={selectedKnowledgeCollectionId}
									onChange={(e) => void loadKnowledge(e.target.value)}
									style={{ marginTop: 10 }}
								>
									{knowledgeCollections.map((collection) => (
										<option key={collection.id} value={collection.id}>
											{collection.name}
										</option>
									))}
								</select>
							) : null}
						</section>

						<section className="mem-panel">
							<h2 className="ui-section-title">➕ Indexar texto</h2>
							<input
								type="text"
								className="mem-input mem-input--block"
								value={knowledgeItemTitle}
								onChange={(e) => setKnowledgeItemTitle(e.target.value)}
								placeholder="Título"
								style={{ marginTop: 10, marginBottom: 8 }}
							/>
							<textarea
								className="mem-input mem-input--block"
								value={knowledgeItemContent}
								onChange={(e) => setKnowledgeItemContent(e.target.value)}
								placeholder="Texto, notas, transcripción, descripción..."
								rows={4}
								style={{ resize: "vertical", fontFamily: "inherit" }}
							/>
							<button
								type="button"
								className="ui-btn ui-btn--secondary"
								onClick={handleCreateKnowledgeTextItem}
								disabled={
									!selectedKnowledgeCollectionId || !knowledgeItemContent.trim()
								}
								style={{ marginTop: 10 }}
							>
								Indexar texto
							</button>
						</section>

						<section className="mem-panel">
							<h2 className="ui-section-title">📎 Indexar archivo</h2>
							<p className="ui-section-subtitle">
								Texto, docs, imágenes, audio y video (rutas locales). Sidecars
								de OCR/transcripción: <code>.ocr.txt</code>,{" "}
								<code>.transcript.txt</code>, <code>.captions.vtt</code>
							</p>
							<input
								type="text"
								className="mem-input mem-input--block"
								value={knowledgeFileTitle}
								onChange={(e) => setKnowledgeFileTitle(e.target.value)}
								placeholder="Título opcional"
								style={{ marginTop: 10, marginBottom: 8 }}
							/>
							<input
								type="text"
								className="mem-input mem-input--block"
								value={knowledgeFilePath}
								onChange={(e) => setKnowledgeFilePath(e.target.value)}
								placeholder="Ruta local: ./docs/spec.md, ~/.octopus/media/..."
							/>
							<button
								type="button"
								className="ui-btn ui-btn--secondary"
								onClick={handleCreateKnowledgeFileItem}
								disabled={
									!selectedKnowledgeCollectionId || !knowledgeFilePath.trim()
								}
								style={{ marginTop: 10 }}
							>
								Indexar archivo
							</button>
						</section>
					</div>

					{/* Right: search + items */}
					<div>
						<section className="mem-panel">
							<h2 className="ui-section-title">🔎 Buscar en conocimiento</h2>
							<div className="mem-row" style={{ marginTop: 12 }}>
								<input
									type="text"
									className="mem-input"
									value={knowledgeQuery}
									onChange={(e) => setKnowledgeQuery(e.target.value)}
									onKeyDown={(e) =>
										e.key === "Enter" && handleKnowledgeSearch()
									}
									placeholder="Buscar chunks indexados..."
								/>
								<button
									type="button"
									className="ui-btn ui-btn--secondary"
									onClick={handleKnowledgeSearch}
								>
									Buscar
								</button>
							</div>
							{knowledgeResults.length > 0 ? (
								<div style={{ display: "grid", gap: 8, marginTop: 12 }}>
									{knowledgeResults.map((result) => (
										<MemItem
											key={result.id}
											accent="#7c3aed"
											meta={
												<>
													<span style={{ color: "#c4b5fd", fontWeight: 700 }}>
														{result.item_title ?? result.item_id}
													</span>
													<span>· {result.modality}</span>
												</>
											}
										>
											<MemText text={result.content} />
										</MemItem>
									))}
								</div>
							) : null}
						</section>

						<section className="mem-panel">
							<div className="cc-panel-head" style={{ marginBottom: 12 }}>
								<div>
									<h2 className="ui-section-title">🗂 Items de la colección</h2>
									<p className="ui-section-subtitle">
										{knowledgeItems.length} indexados
									</p>
								</div>
							</div>
							{knowledgeItems.length === 0 ? (
								<div className="ui-empty" style={{ padding: "24px 16px" }}>
									<div className="ui-empty-title">Sin items</div>
									<div className="ui-empty-desc">
										Indexa texto o archivos en esta colección.
									</div>
								</div>
							) : (
								<div style={{ display: "grid", gap: 8 }}>
									{knowledgeItems.map((item) => (
										<MemItem
											key={item.id}
											accent="#6366f1"
											title={item.title ?? item.id}
										>
											<div className="ui-meta">
												{item.source_type} ·{" "}
												<span
													className={`ui-status ${item.status === "ready" ? "is-success" : item.status === "failed" ? "is-error" : "is-info"}`}
												>
													{item.status}
												</span>
												{item.source_uri ? ` · ${item.source_uri}` : ""}
											</div>
										</MemItem>
									))}
								</div>
							)}
						</section>
					</div>
				</div>
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
													borderLeft: `3px solid ${msg.role === "user" ? "#6366f1" : msg.role === "system" ? "#8b5cf6" : "#22c55e"}`,
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
									background: "linear-gradient(135deg, #7c3aed, #6366f1)",
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
																: "#6366f122",
													color:
														conf >= 0.7
															? "#22c55e"
															: conf >= 0.4
																? "#f59e0b"
																: "#6366f1",
													border: `1px solid ${conf >= 0.7 ? "#22c55e44" : conf >= 0.4 ? "#f59e0b44" : "#6366f144"}`,
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

const MemoryOverviewDashboard: React.FC<{
	stats: MemoryStats | null;
	graph: { nodes: GraphNode[]; edges: GraphEdge[] };
	selectedNode?: GraphNode;
	selectedEdges: GraphEdge[];
	ltmItems: LTMItem[];
	learningInsights: LearningInsight[];
	profile: UserProfile | null;
	dailySummary: string;
	dailyCount: number;
	stmTotal: number;
	stmTurns: STMTurn[];
	onSelectNode: (id: string) => void;
	onOpenGraph: () => void;
	onOpenSource: (node: GraphNode) => void;
}> = ({
	stats,
	graph,
	selectedNode,
	selectedEdges,
	ltmItems,
	learningInsights,
	profile,
	dailySummary,
	dailyCount,
	stmTotal,
	stmTurns,
	onSelectNode,
	onOpenGraph,
	onOpenSource,
}) => {
	const stmTokens = getRecordNumber(stats?.shortTerm, "tokens");
	const overviewNodes: GraphViewNode[] = useMemo(
		() =>
			graph.nodes.map((node) => ({
				id: node.id,
				label: node.label,
				type: node.type,
				source: node.source,
				weight: node.weight,
				content: node.content,
				keywords: node.keywords,
			})),
		[graph],
	);
	const overviewEdges: GraphViewEdge[] = useMemo(
		() =>
			graph.edges.map((edge) => ({
				source: edge.from,
				target: edge.to,
				weight: Math.max(1, edge.keywords.length),
			})),
		[graph],
	);
	const overviewById = useMemo(
		() => new Map(graph.nodes.map((node) => [node.id, node])),
		[graph],
	);
	const stmMaxTokens = stats?.shortTerm?.maxTokens;
	const stmLoad = getRecordNumber(stats?.shortTerm, "load");
	const ltmCount = getRecordNumber(stats?.longTerm, "count") ?? ltmItems.length;
	const ltmMaxItems = stats?.longTerm?.maxItems;
	const averageImportance = ltmItems.length
		? ltmItems.reduce(
				(total, item) =>
					total + (typeof item.importance === "number" ? item.importance : 0.5),
				0,
			) / ltmItems.length
		: 0;
	const activeConcepts = Array.from(
		new Set(graph.nodes.flatMap((node) => node.keywords.slice(0, 4))),
	).slice(0, 12);
	const typeDistribution = Object.entries(
		ltmItems.reduce<Record<string, number>>((acc, item) => {
			const type = typeof item.type === "string" ? item.type : "memory";
			acc[type] = (acc[type] ?? 0) + 1;
			return acc;
		}, {}),
	)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4);

	return (
		<div className="animate-slide-up">
			<div className="stats-grid" style={{ marginBottom: 16 }}>
				<MemoryMetricCard
					icon="database"
					label="Memorias largo plazo"
					value={formatNumber(ltmCount)}
					detail={
						ltmMaxItems ? `capacidad ${formatNumber(ltmMaxItems)}` : "LTM"
					}
					color="#6366f1"
				/>
				<MemoryMetricCard
					icon="chat"
					label="Memoria activa"
					value={formatNumber(stmTotal || stmTurns.length)}
					detail={
						stmTokens && stmMaxTokens
							? `${formatNumber(stmTokens)} / ${formatNumber(stmMaxTokens)} tokens`
							: "corto plazo"
					}
					color="#06b6d4"
				/>
				<MemoryMetricCard
					icon="spark"
					label="Conexiones detectadas"
					value={formatNumber(graph.edges.length)}
					detail={`${formatNumber(graph.nodes.length)} nodos en red`}
					color="#8b5cf6"
				/>
				<MemoryMetricCard
					icon="check"
					label="Aprendizajes"
					value={formatNumber(learningInsights.length)}
					detail={`${Math.round(averageImportance * 100)}% importancia media`}
					color="#a78bfa"
				/>
				<MemoryMetricCard
					icon="user"
					label="Memoria usuario"
					value={profile ? formatNumber(profile.conversationCount) : "—"}
					detail={profile?.displayName ?? "perfil contextual"}
					color="#10b981"
				/>
			</div>

			<div
				style={{
					display: "grid",
					gridTemplateColumns:
						"repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
					gap: 16,
					alignItems: "stretch",
				}}
			>
				<div style={{ minWidth: 0 }}>
					<MemoryGraphView
						nodes={overviewNodes}
						edges={overviewEdges}
						selectedNodeId={selectedNode?.id ?? null}
						onSelectNode={(id) => {
							if (id) onSelectNode(id);
						}}
						onOpenNode={(node) => {
							const original = overviewById.get(node.id);
							if (original) onOpenSource(original);
						}}
						compact
						height={420}
					/>
				</div>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 16,
						minWidth: 0,
					}}
				>
					<MemoryNodeInspector
						graph={graph}
						selectedNode={selectedNode}
						selectedEdges={selectedEdges}
						onSelectNode={onSelectNode}
						onOpenSource={onOpenSource}
						compact
					/>
					<div className="surface-panel">
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								gap: 12,
								alignItems: "center",
							}}
						>
							<div>
								<h3 style={{ margin: 0, fontSize: "0.98rem" }}>
									Salud de memoria
								</h3>
								<div
									style={{
										color: "#71717a",
										fontSize: "0.78rem",
										marginTop: 4,
									}}
								>
									Capacidad, distribución y señal reciente
								</div>
							</div>
							<button
								type="button"
								onClick={onOpenGraph}
								style={ghostButtonStyle}
							>
								Abrir grafo
							</button>
						</div>
						<div style={{ marginTop: 16, display: "grid", gap: 12 }}>
							<ProgressMetric
								label="Carga STM"
								value={
									stmLoad ??
									(stmTokens && stmMaxTokens ? stmTokens / stmMaxTokens : 0)
								}
								color="#06b6d4"
							/>
							<ProgressMetric
								label="Capacidad LTM"
								value={ltmMaxItems ? ltmCount / ltmMaxItems : 0}
								color="#6366f1"
							/>
							<ProgressMetric
								label="Importancia promedio"
								value={averageImportance}
								color="#8b5cf6"
							/>
						</div>
						{typeDistribution.length > 0 && (
							<div style={{ marginTop: 16 }}>
								<div style={sectionLabelStyle}>Tipos dominantes</div>
								<div className="settings-chip-list">
									{typeDistribution.map(([type, count]) => (
										<span
											key={type}
											className="settings-chip settings-chip--mono"
										>
											{type} · {count}
										</span>
									))}
								</div>
							</div>
						)}
					</div>
				</div>
			</div>

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
					gap: 16,
					marginTop: 16,
				}}
			>
				<MemorySignalPanel
					title="Conceptos activos"
					description="Keywords extraídas de memorias y aprendizajes conectados."
					items={activeConcepts}
				/>
				<MemorySignalPanel
					title="Resumen diario"
					description={`${formatNumber(dailyCount)} mensajes registrados hoy`}
					items={dailySummary ? [truncateText(dailySummary, 220)] : []}
					empty="Aún no hay resumen diario disponible."
				/>
				<MemorySignalPanel
					title="Aprendizajes recientes"
					description="Señales que el motor puede reutilizar en futuras tareas."
					items={learningInsights.slice(0, 5).map((insight) => insight.content)}
					empty="Sin aprendizajes automáticos cargados."
				/>
			</div>
		</div>
	);
};

const WARM_NODE_COLORS: Record<GraphSource, string> = {
	memory: "#FFA500",
	learning: "#FFB347",
	profile: "#FF8C00",
	daily: "#FFD180",
	shortTerm: "#FFC107",
};

interface BrainMesh {
	points: Array<{ x: number; y: number }>;
	edges: Array<[number, number]>;
}

function insideBrainShape(x: number, y: number): boolean {
	const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
		((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
	return (
		ellipse(34, 41, 22, 27) ||
		ellipse(62, 41, 22, 27) ||
		ellipse(48, 25, 25, 14) ||
		ellipse(48, 63, 17, 11)
	);
}

function generateBrainMesh(count = 260): BrainMesh {
	const points: Array<{ x: number; y: number }> = [];
	let guard = 0;
	while (points.length < count && guard < count * 50) {
		guard += 1;
		const x = 10 + Math.random() * 78;
		const y = 12 + Math.random() * 60;
		if (insideBrainShape(x, y)) {
			points.push({
				x: x + (Math.random() - 0.5) * 1.2,
				y: y + (Math.random() - 0.5) * 1.2,
			});
		}
	}
	const edges: Array<[number, number]> = [];
	const seen = new Set<string>();
	points.forEach((point, i) => {
		const nearest = points
			.map((other, j) => ({
				j,
				d: (point.x - other.x) ** 2 + (point.y - other.y) ** 2,
			}))
			.filter((o) => o.j !== i)
			.sort((a, b) => a.d - b.d)
			.slice(0, 3);
		for (const o of nearest) {
			const key = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
			if (!seen.has(key)) {
				seen.add(key);
				edges.push([i, o.j]);
			}
		}
	});
	return { points, edges };
}

const MemoryNetworkMap: React.FC<{
	graph: { nodes: GraphNode[]; edges: GraphEdge[] };
	selectedNodeId: string | null;
	onSelectNode: (id: string) => void;
	onRefresh?: () => void;
	compact?: boolean;
}> = ({ graph, selectedNodeId, onSelectNode, onRefresh, compact = false }) => {
	const [sourceFilter, setSourceFilter] = useState<GraphSourceFilter>("all");
	const [mapZoom, setMapZoom] = useState(1);
	const [focusConnectionsOnly, setFocusConnectionsOnly] = useState(false);
	const visibleNodes = getVisibleGraphNodes(
		graph,
		selectedNodeId,
		sourceFilter,
		compact,
		focusConnectionsOnly,
	);
	const visibleIds = new Set(visibleNodes.map((node) => node.id));
	const visibleEdges = getVisibleGraphEdges(
		graph.edges,
		visibleIds,
		selectedNodeId,
		compact,
	);
	const layout = createGraphLayout(visibleNodes);
	const mapLayout = scaleGraphLayout(layout, mapZoom);
	const sourceCounts = countNodesBySource(graph.nodes);
	const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
	const activityItems = buildMemoryActivityItems(visibleNodes, selectedNode);
	const connectedIds = new Set(
		selectedNodeId
			? graph.edges.flatMap((edge) =>
					edge.from === selectedNodeId
						? [edge.to]
						: edge.to === selectedNodeId
							? [edge.from]
							: [],
				)
			: [],
	);
	const updateZoom = (nextZoom: number) => {
		setMapZoom(Math.max(0.8, Math.min(1.6, nextZoom)));
	};

	const stageRef = useRef<HTMLDivElement>(null);
	const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
	const [isPanning, setIsPanning] = useState(false);
	const dragRef = useRef<{
		x: number;
		y: number;
		px: number;
		py: number;
	} | null>(null);
	const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

	useEffect(() => {
		const el = stageRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const delta = -event.deltaY * 0.0016;
			setMapZoom((value) => Math.max(0.8, Math.min(1.45, value + delta)));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const onStagePointerDown = (event: React.PointerEvent) => {
		if ((event.target as HTMLElement).closest("button")) return;
		dragRef.current = {
			x: event.clientX,
			y: event.clientY,
			px: pan.x,
			py: pan.y,
		};
		setIsPanning(true);
		try {
			(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		} catch {
			/* pointer capture unavailable in this environment */
		}
	};
	const onStagePointerMove = (event: React.PointerEvent) => {
		const drag = dragRef.current;
		if (!drag) return;
		setPan({
			x: drag.px + (event.clientX - drag.x),
			y: drag.py + (event.clientY - drag.y),
		});
	};
	const onStagePointerUp = (event: React.PointerEvent) => {
		if (dragRef.current) {
			try {
				(event.currentTarget as HTMLElement).releasePointerCapture?.(
					event.pointerId,
				);
			} catch {
				/* pointer capture already released */
			}
		}
		dragRef.current = null;
		setIsPanning(false);
	};
	const resetView = () => {
		setMapZoom(1);
		setPan({ x: 0, y: 0 });
	};

	const focusId = hoveredNode?.id ?? selectedNodeId ?? null;
	const litIds = new Set<string>(
		focusId
			? [
					focusId,
					...graph.edges.flatMap((edge) =>
						edge.from === focusId
							? [edge.to]
							: edge.to === focusId
								? [edge.from]
								: [],
					),
				]
			: [],
	);
	const labelOpacity = Math.max(0, Math.min(1, (mapZoom - 1) / 0.45));
	const showLabels = mapZoom > 1.1;
	const weightRank = new Map<string, number>();
	[...visibleNodes]
		.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
		.forEach((node, index) => weightRank.set(node.id, index));
	const totalRanked = Math.max(visibleNodes.length, 1);
	const mesh = useMemo(() => generateBrainMesh(260), []);
	const meshPts = mesh.points.map((p) => scaleGraphPoint(p, mapZoom));

	return (
		<div
			className="surface-panel hover-glow"
			style={{
				position: "relative",
				minHeight: compact ? 560 : 690,
				overflow: "hidden",
				background:
					"radial-gradient(circle at 48% 42%, rgba(255,140,30,0.16), transparent 38%), radial-gradient(circle at 50% 108%, rgba(70,24,0,0.7), transparent 60%), linear-gradient(180deg, #08060c, #1a0c03)",
			}}
		>
			<div
				style={{
					position: "relative",
					zIndex: 3,
					display: "flex",
					justifyContent: "space-between",
					gap: 12,
					alignItems: "flex-start",
					flexWrap: "wrap",
				}}
			>
				<div>
					<h3 style={{ margin: 0, color: "#f4f4f5", fontSize: "1rem" }}>
						Red de memorias
					</h3>
					<div style={{ marginTop: 5, color: "#71717a", fontSize: "0.8rem" }}>
						{visibleNodes.length} visibles de {graph.nodes.length} nodos · foco
						por clúster
					</div>
				</div>
				{onRefresh && (
					<button type="button" onClick={onRefresh} style={ghostButtonStyle}>
						Actualizar
					</button>
				)}
			</div>

			{compact && (
				<div
					style={{
						position: "relative",
						zIndex: 8,
						display: "flex",
						gap: 8,
						flexWrap: "wrap",
						marginTop: 14,
					}}
				>
					{GRAPH_SOURCE_FILTERS.map((filter) => {
						const active = sourceFilter === filter.id;
						const color =
							filter.id === "all" ? "#818cf8" : getSourceColor(filter.id);
						const count =
							filter.id === "all"
								? graph.nodes.length
								: (sourceCounts[filter.id] ?? 0);
						return (
							<button
								key={filter.id}
								type="button"
								onClick={() => setSourceFilter(filter.id)}
								style={{
									padding: "8px 10px",
									borderRadius: 999,
									border: active
										? `1px solid ${hexToRgba(color, 0.58)}`
										: "1px solid #27272a",
									background: active
										? hexToRgba(color, 0.16)
										: "rgba(9,9,11,0.62)",
									color: active ? color : "#a1a1aa",
									cursor: "pointer",
									fontSize: "0.74rem",
									fontWeight: 800,
								}}
							>
								{filter.label} · {count}
							</button>
						);
					})}
				</div>
			)}

			{!compact && (
				<MemoryMapSidebar
					graph={graph}
					sourceCounts={sourceCounts}
					sourceFilter={sourceFilter}
					onSourceFilterChange={setSourceFilter}
					selectedNode={selectedNode}
					connectedCount={connectedIds.size}
				/>
			)}

			{visibleNodes.length === 0 ? (
				<div
					style={{
						position: "absolute",
						inset: 0,
						display: "grid",
						placeItems: "center",
						color: "#71717a",
						fontSize: "0.9rem",
					}}
				>
					Sin memorias o aprendizajes disponibles para visualizar.
				</div>
			) : (
				<>
					<div
						ref={stageRef}
						className={`mem-cosmos-stage${isPanning ? " is-panning" : ""}`}
						style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
						onPointerDown={onStagePointerDown}
						onPointerMove={onStagePointerMove}
						onPointerUp={onStagePointerUp}
						onPointerCancel={onStagePointerUp}
						onPointerLeave={onStagePointerUp}
					>
						<div className="mem-cosmos" />
						<div className="mem-cosmos-twinkle" />
						<svg
							viewBox="0 0 100 100"
							preserveAspectRatio="none"
							style={{
								position: "absolute",
								inset: 0,
								width: "100%",
								height: "100%",
							}}
						>
							<title>Conexiones semánticas entre memorias</title>
							<defs>
								<filter
									id="neural-bloom"
									x="-20%"
									y="-20%"
									width="140%"
									height="140%"
								>
									<feGaussianBlur stdDeviation="0.45" />
								</filter>
								<filter
									id="memory-glow"
									x="-50%"
									y="-50%"
									width="200%"
									height="200%"
								>
									<feGaussianBlur stdDeviation="0.5" result="b" />
									<feMerge>
										<feMergeNode in="b" />
										<feMergeNode in="SourceGraphic" />
									</feMerge>
								</filter>
								<radialGradient id="brain-warm" cx="48%" cy="42%" r="44%">
									<stop offset="0%" stopColor="rgba(255,150,40,0.22)" />
									<stop offset="60%" stopColor="rgba(255,120,0,0.08)" />
									<stop offset="100%" stopColor="rgba(255,120,0,0)" />
								</radialGradient>
							</defs>
							<g>
								<ellipse
									cx="48"
									cy="44"
									rx="36"
									ry="32"
									fill="url(#brain-warm)"
								/>
								<g
									stroke="#ff8c1a"
									strokeWidth="0.1"
									strokeOpacity="0.3"
									fill="none"
									filter="url(#neural-bloom)"
								>
									{mesh.edges.map(([a, b], i) => {
										const pa = meshPts[a];
										const pb = meshPts[b];
										if (!pa || !pb) return null;
										return (
											<line
												key={`mesh-${a}-${b}`}
												x1={pa.x}
												y1={pa.y}
												x2={pb.x}
												y2={pb.y}
											/>
										);
									})}
								</g>
								<g fill="#ffa733" filter="url(#neural-bloom)">
									{meshPts.map((p, i) => (
										<circle
											key={`mp-${p.x.toFixed(2)}-${p.y.toFixed(2)}`}
											cx={p.x}
											cy={p.y}
											r={0.32}
											opacity="0.7"
										/>
									))}
								</g>
							</g>
							{visibleEdges.map((edge, index) => {
								const from = mapLayout[edge.from];
								const to = mapLayout[edge.to];
								if (!from || !to) return null;
								const lit =
									!focusId || edge.from === focusId || edge.to === focusId;
								const color = lit ? "#ffd27a" : "#b85c00";
								return (
									<path
										key={`${edge.from}-${edge.to}-${index}`}
										d={`M ${from.x} ${from.y} C ${from.x} 44, ${to.x} 44, ${to.x} ${to.y}`}
										stroke={color}
										strokeWidth={lit ? 0.36 : 0.1}
										strokeOpacity={lit ? 0.85 : 0.1}
										fill="none"
										strokeDasharray={lit ? "2 1.6" : "1 2.2"}
										filter={lit ? "url(#memory-glow)" : undefined}
										style={{ transition: "stroke-opacity 0.2s ease" }}
									>
										<animate
											attributeName="stroke-dashoffset"
											values="0;6"
											dur={`${5 + (index % 5)}s`}
											repeatCount="indefinite"
										/>
									</path>
								);
							})}
						</svg>
					</div>
					{selectedNode && (
						<div
							style={{
								position: "absolute",
								left: "50%",
								top: compact ? "68%" : "66%",
								transform: "translateX(-50%)",
								zIndex: 5,
								padding: "8px 12px",
								borderRadius: 999,
								background: "rgba(9,9,11,0.82)",
								border: `1px solid ${hexToRgba(getSourceColor(selectedNode.source), 0.35)}`,
								color: "#d4d4d8",
								fontSize: "0.74rem",
								fontWeight: 800,
								maxWidth: "72%",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							{focusConnectionsOnly ? "Solo vecinos" : "Foco"}:{" "}
							{selectedNode.label} · {connectedIds.size} conexiones
						</div>
					)}
					{!compact && (
						<MemoryMiniMap
							layout={layout}
							nodes={visibleNodes}
							edges={visibleEdges}
							selectedNodeId={selectedNodeId}
						/>
					)}
					{visibleNodes.map((node) => {
						const point = mapLayout[node.id];
						if (!point) return null;
						const color = WARM_NODE_COLORS[node.source];
						const selected = selectedNodeId === node.id;
						const isFocus = !!focusId && node.id === focusId;
						const isNeighbor = !!focusId && litIds.has(node.id) && !isFocus;
						const lit = !focusId || litIds.has(node.id);
						const weight = node.weight ?? 0.5;
						const rank = weightRank.get(node.id) ?? 0;
						const radius = compact
							? 4 + (1 - rank / totalRanked) * 9
							: 6 + (1 - rank / totalRanked) * 22;
						const showName =
							showLabels ||
							selected ||
							hoveredNode?.id === node.id ||
							weight >= 0.85;
						return (
							<button
								key={node.id}
								type="button"
								onClick={() => onSelectNode(node.id)}
								onPointerEnter={() => setHoveredNode(node)}
								onPointerLeave={() => setHoveredNode(null)}
								className={`mem-dot${selected ? " is-selected" : ""}`}
								style={{
									position: "absolute",
									left: `${point.x}%`,
									top: `${point.y}%`,
									transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${isFocus ? 1.3 : isNeighbor ? 1.12 : 1})`,
									width: radius * 2,
									height: radius * 2,
									borderRadius: "50%",
									padding: 0,
									border: "none",
									background: `radial-gradient(circle at 34% 30%, ${hexToRgba(color, 1)}, ${hexToRgba(color, 0.6)} 55%, ${hexToRgba(color, 0.18)})`,
									boxShadow: isFocus
										? `0 0 16px ${color}, 0 0 34px ${hexToRgba(color, 0.55)}`
										: isNeighbor
											? `0 0 12px ${hexToRgba(color, 0.8)}`
											: selected
												? `0 0 14px ${hexToRgba(color, 0.6)}`
												: `0 0 8px ${hexToRgba(color, 0.45)}`,
									cursor: "pointer",
									opacity: lit ? 1 : 0.2,
									zIndex: isFocus ? 8 : selected ? 7 : isNeighbor ? 6 : 4,
									transition: "opacity 0.2s ease, box-shadow 0.2s ease",
								}}
							>
								{showName ? (
									<span
										className="mem-dot__label"
										style={{
											opacity:
												selected || hoveredNode?.id === node.id
													? 1
													: labelOpacity,
											color,
										}}
									>
										{truncateText(node.label, compact ? 16 : 22)}
									</span>
								) : null}
							</button>
						);
					})}
					{!compact && (
						<MemoryMapControls
							zoom={mapZoom}
							onZoomIn={() => updateZoom(mapZoom + 0.1)}
							onZoomOut={() => updateZoom(mapZoom - 0.1)}
							onReset={resetView}
							focusConnectionsOnly={focusConnectionsOnly}
							onToggleFocus={() => setFocusConnectionsOnly((value) => !value)}
							disabledFocus={!selectedNodeId}
						/>
					)}
					{!compact && <MemoryActivityStrip items={activityItems} />}
					<div className="mem-cosmos-hint">
						Arrastra para mover · rueda para zoom
					</div>
					{hoveredNode && mapLayout[hoveredNode.id] ? (
						<div
							className="mem-cosmos-tooltip"
							style={{
								left: `calc(${mapLayout[hoveredNode.id].x}% + ${pan.x}px)`,
								top: `calc(${mapLayout[hoveredNode.id].y}% + ${pan.y}px)`,
							}}
						>
							<div
								style={{
									color: getSourceColor(hoveredNode.source),
									fontWeight: 800,
								}}
							>
								{hoveredNode.label}
							</div>
							<div
								style={{
									color: "#a1a1aa",
									fontSize: "0.72rem",
									margin: "2px 0 5px",
								}}
							>
								{getSourceLabel(hoveredNode.source)} · {hoveredNode.type}
							</div>
							<div style={{ color: "#d4d4d8" }}>
								{truncateText(hoveredNode.content, 120)}
							</div>
						</div>
					) : null}
				</>
			)}
		</div>
	);
};

const MemoryGraphFocusBanner: React.FC<{
	node: GraphNode;
	query: string;
	onBackToGraph: () => void;
	onClear: () => void;
}> = ({ node, query, onBackToGraph, onClear }) => {
	const color = getSourceColor(node.source);
	return (
		<div
			className="animate-slide-up"
			style={{
				marginBottom: 16,
				padding: 14,
				borderRadius: 16,
				background: `linear-gradient(135deg, ${hexToRgba(color, 0.16)}, rgba(9,9,11,0.84))`,
				border: `1px solid ${hexToRgba(color, 0.32)}`,
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 14,
				flexWrap: "wrap",
			}}
		>
			<div
				style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}
			>
				<div
					style={{
						width: 42,
						height: 42,
						borderRadius: 14,
						background: hexToRgba(color, 0.18),
						border: `1px solid ${hexToRgba(color, 0.32)}`,
						color,
						display: "grid",
						placeItems: "center",
						flex: "0 0 auto",
					}}
				>
					<AppIcon name={getSourceIcon(node.source)} size={21} />
				</div>
				<div style={{ minWidth: 0 }}>
					<div style={{ ...sectionLabelStyle, color }}>
						Abierto desde el grafo
					</div>
					<div
						style={{
							color: "#f4f4f5",
							fontWeight: 900,
							fontSize: "0.95rem",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							maxWidth: 580,
						}}
					>
						{node.label}
					</div>
					<div style={{ color: "#a1a1aa", fontSize: "0.78rem", marginTop: 3 }}>
						{getSourceLabel(node.source)} · consulta: {truncateText(query, 80)}
					</div>
				</div>
			</div>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
				<button type="button" onClick={onBackToGraph} style={ghostButtonStyle}>
					Volver al mapa
				</button>
				<button
					type="button"
					onClick={onClear}
					style={{ ...ghostButtonStyle, color: "#71717a" }}
				>
					Limpiar foco
				</button>
			</div>
		</div>
	);
};

const MemoryMapSidebar: React.FC<{
	graph: { nodes: GraphNode[]; edges: GraphEdge[] };
	sourceCounts: Partial<Record<GraphSource, number>>;
	sourceFilter: GraphSourceFilter;
	onSourceFilterChange: (filter: GraphSourceFilter) => void;
	selectedNode?: GraphNode;
	connectedCount: number;
}> = ({
	graph,
	sourceCounts,
	sourceFilter,
	onSourceFilterChange,
	selectedNode,
	connectedCount,
}) => (
	<div
		style={{
			position: "absolute",
			left: 18,
			top: 128,
			bottom: 96,
			width: 190,
			zIndex: 9,
			padding: 12,
			borderRadius: 16,
			background: "rgba(3,7,18,0.7)",
			border: "1px solid rgba(39,39,42,0.92)",
			boxShadow: "0 18px 44px rgba(0,0,0,0.28)",
			backdropFilter: "blur(14px)",
			overflow: "hidden",
		}}
	>
		<div style={sectionLabelStyle}>Vistas</div>
		<div style={{ display: "grid", gap: 7, marginTop: 10 }}>
			{GRAPH_SOURCE_FILTERS.map((filter) => {
				const active = sourceFilter === filter.id;
				const color =
					filter.id === "all" ? "#38bdf8" : getSourceColor(filter.id);
				const count =
					filter.id === "all"
						? graph.nodes.length
						: (sourceCounts[filter.id] ?? 0);
				return (
					<button
						key={filter.id}
						type="button"
						onClick={() => onSourceFilterChange(filter.id)}
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							gap: 8,
							padding: "9px 10px",
							borderRadius: 10,
							border: active
								? `1px solid ${hexToRgba(color, 0.42)}`
								: "1px solid transparent",
							background: active ? hexToRgba(color, 0.17) : "transparent",
							color: active ? "#f4f4f5" : "#a1a1aa",
							cursor: "pointer",
							fontSize: "0.78rem",
							fontWeight: 800,
						}}
					>
						<span
							style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
						>
							<span
								style={{
									width: 7,
									height: 7,
									borderRadius: 999,
									background: color,
									boxShadow: `0 0 10px ${hexToRgba(color, 0.65)}`,
								}}
							/>
							{filter.label}
						</span>
						<span style={{ color: active ? color : "#71717a" }}>{count}</span>
					</button>
				);
			})}
		</div>

		<div style={{ height: 1, background: "#27272a", margin: "14px 0" }} />
		<div style={sectionLabelStyle}>Exploración</div>
		<div style={{ display: "grid", gap: 9, marginTop: 10 }}>
			<MemorySidebarStat
				label="Nodos"
				value={graph.nodes.length}
				color="#38bdf8"
			/>
			<MemorySidebarStat
				label="Enlaces"
				value={graph.edges.length}
				color="#8b5cf6"
			/>
			<MemorySidebarStat
				label="Vecinos"
				value={connectedCount}
				color="#10b981"
			/>
		</div>

		<div style={{ height: 1, background: "#27272a", margin: "14px 0" }} />
		<div style={sectionLabelStyle}>Foco actual</div>
		<div
			style={{
				marginTop: 10,
				padding: 10,
				borderRadius: 12,
				background: selectedNode
					? hexToRgba(getSourceColor(selectedNode.source), 0.1)
					: "rgba(24,24,27,0.64)",
				border: selectedNode
					? `1px solid ${hexToRgba(getSourceColor(selectedNode.source), 0.24)}`
					: "1px solid #27272a",
				color: "#d4d4d8",
				fontSize: "0.76rem",
				lineHeight: 1.45,
			}}
		>
			{selectedNode
				? truncateText(selectedNode.label, 70)
				: "Selecciona un nodo"}
		</div>
	</div>
);

const MemoryMiniMap: React.FC<{
	layout: Record<string, { x: number; y: number }>;
	nodes: GraphNode[];
	edges: GraphEdge[];
	selectedNodeId: string | null;
}> = ({ layout, nodes, edges, selectedNodeId }) => (
	<div
		style={{
			position: "absolute",
			right: 24,
			bottom: 116,
			width: 158,
			height: 104,
			zIndex: 8,
			padding: 8,
			borderRadius: 14,
			background: "rgba(3,7,18,0.72)",
			border: "1px solid rgba(39,39,42,0.92)",
			boxShadow: "0 14px 34px rgba(0,0,0,0.26)",
			backdropFilter: "blur(14px)",
		}}
	>
		<svg
			viewBox="0 0 100 100"
			preserveAspectRatio="none"
			style={{ width: "100%", height: "100%", display: "block" }}
		>
			<title>Minimapa de la red de memoria</title>
			<rect
				x="1"
				y="1"
				width="98"
				height="98"
				rx="10"
				fill="rgba(9,9,11,0.52)"
				stroke="rgba(59,130,246,0.24)"
			/>
			{edges.slice(0, 70).map((edge) => {
				const from = layout[edge.from];
				const to = layout[edge.to];
				if (!from || !to) return null;
				const selected =
					selectedNodeId === edge.from || selectedNodeId === edge.to;
				return (
					<line
						key={`mini-${edge.from}-${edge.to}`}
						x1={from.x}
						y1={from.y}
						x2={to.x}
						y2={to.y}
						stroke={selected ? "#67e8f9" : "#4f46e5"}
						strokeOpacity={selected ? 0.8 : 0.2}
						strokeWidth={selected ? 0.9 : 0.35}
					/>
				);
			})}
			{nodes.map((node) => {
				const point = layout[node.id];
				if (!point) return null;
				const selected = selectedNodeId === node.id;
				return (
					<circle
						key={`mini-${node.id}`}
						cx={point.x}
						cy={point.y}
						r={selected ? 2.2 : 1.25}
						fill={getSourceColor(node.source)}
						fillOpacity={selected ? 1 : 0.72}
					/>
				);
			})}
		</svg>
	</div>
);

const MemorySidebarStat: React.FC<{
	label: string;
	value: number;
	color: string;
}> = ({ label, value, color }) => (
	<div
		style={{
			display: "flex",
			justifyContent: "space-between",
			alignItems: "center",
			gap: 8,
			fontSize: "0.76rem",
			color: "#a1a1aa",
		}}
	>
		<span>{label}</span>
		<span style={{ color, fontWeight: 900 }}>{formatNumber(value)}</span>
	</div>
);

function mapControlButtonStyle(
	color: string,
	disabled = false,
): React.CSSProperties {
	return {
		minWidth: 32,
		height: 30,
		border: "none",
		borderRadius: 9,
		background: "transparent",
		display: "grid",
		placeItems: "center",
		color: disabled ? "#52525b" : color,
		fontSize: "0.78rem",
		fontWeight: 900,
		cursor: disabled ? "not-allowed" : "pointer",
		opacity: disabled ? 0.55 : 1,
	};
}

const MemoryMapControls: React.FC<{
	zoom: number;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onReset: () => void;
	focusConnectionsOnly: boolean;
	onToggleFocus: () => void;
	disabledFocus: boolean;
}> = ({
	zoom,
	onZoomIn,
	onZoomOut,
	onReset,
	focusConnectionsOnly,
	onToggleFocus,
	disabledFocus,
}) => (
	<div
		style={{
			position: "absolute",
			left: "50%",
			bottom: 96,
			transform: "translateX(-50%)",
			zIndex: 9,
			display: "flex",
			alignItems: "center",
			gap: 2,
			padding: 6,
			borderRadius: 14,
			background: "rgba(9,9,11,0.78)",
			border: "1px solid #27272a",
			boxShadow: "0 14px 34px rgba(0,0,0,0.28)",
		}}
	>
		<button
			type="button"
			onClick={onToggleFocus}
			disabled={disabledFocus}
			title="Mostrar solo vecinos del nodo seleccionado"
			style={mapControlButtonStyle(
				focusConnectionsOnly ? "#38bdf8" : "#a1a1aa",
				disabledFocus,
			)}
		>
			<AppIcon name="spark" size={15} />
		</button>
		<button
			type="button"
			onClick={onReset}
			title="Restablecer zoom"
			style={mapControlButtonStyle("#a1a1aa")}
		>
			<AppIcon name="activity" size={15} />
		</button>
		<button
			type="button"
			onClick={onZoomOut}
			title="Alejar"
			style={mapControlButtonStyle("#a1a1aa")}
		>
			-
		</button>
		<span
			style={{
				minWidth: 52,
				height: 30,
				borderRadius: 9,
				display: "grid",
				placeItems: "center",
				color: "#a1a1aa",
				fontSize: "0.78rem",
				fontWeight: 800,
			}}
		>
			{Math.round(zoom * 100)}%
		</span>
		<button
			type="button"
			onClick={onZoomIn}
			title="Acercar"
			style={mapControlButtonStyle("#a1a1aa")}
		>
			+
		</button>
		<button
			type="button"
			onClick={onReset}
			title="Centrar mapa"
			style={mapControlButtonStyle("#a1a1aa")}
		>
			<AppIcon name="settings" size={15} />
		</button>
	</div>
);

const MemoryActivityStrip: React.FC<{ items: string[] }> = ({ items }) => (
	<div
		style={{
			position: "absolute",
			left: 18,
			right: 18,
			bottom: 18,
			zIndex: 9,
			padding: 12,
			borderRadius: 16,
			background: "rgba(3,7,18,0.72)",
			border: "1px solid #27272a",
			boxShadow: "0 18px 44px rgba(0,0,0,0.24)",
			backdropFilter: "blur(14px)",
		}}
	>
		<div
			style={{
				display: "flex",
				justifyContent: "space-between",
				alignItems: "center",
				gap: 12,
				marginBottom: 10,
			}}
		>
			<div style={{ color: "#d4d4d8", fontSize: "0.82rem", fontWeight: 900 }}>
				Actividad reciente
			</div>
			<div style={{ color: "#10b981", fontSize: "0.72rem", fontWeight: 900 }}>
				En vivo
			</div>
		</div>
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
				gap: 10,
			}}
		>
			{items.slice(0, 4).map((item, index) => (
				<div
					key={item}
					style={{
						padding: "10px 12px",
						borderRadius: 12,
						background: "rgba(24,24,27,0.68)",
						border: "1px solid rgba(39,39,42,0.85)",
						color: "#d4d4d8",
						fontSize: "0.76rem",
						fontWeight: 800,
					}}
				>
					{truncateText(item, 62)}
					<div style={{ marginTop: 4, color: "#71717a", fontSize: "0.68rem" }}>
						Hace {2 + index * 7} min
					</div>
				</div>
			))}
		</div>
	</div>
);

const MemoryNodeInspector: React.FC<{
	graph: { nodes: GraphNode[]; edges: GraphEdge[] };
	selectedNode?: GraphNode;
	selectedEdges: GraphEdge[];
	onSelectNode: (id: string) => void;
	onOpenSource?: (node: GraphNode) => void;
	compact?: boolean;
}> = ({
	graph,
	selectedNode,
	selectedEdges,
	onSelectNode,
	onOpenSource,
	compact = false,
}) => (
	<div className="surface-panel" style={{ minHeight: compact ? 0 : 650 }}>
		<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
			<div
				style={{
					width: 48,
					height: 48,
					borderRadius: 16,
					background: selectedNode
						? hexToRgba(getSourceColor(selectedNode.source), 0.16)
						: "rgba(99,102,241,0.12)",
					border: selectedNode
						? `1px solid ${hexToRgba(getSourceColor(selectedNode.source), 0.48)}`
						: "1px solid rgba(99,102,241,0.25)",
					display: "grid",
					placeItems: "center",
					color: selectedNode ? getSourceColor(selectedNode.source) : "#818cf8",
					boxShadow: selectedNode
						? `0 0 22px ${hexToRgba(getSourceColor(selectedNode.source), 0.22)}`
						: undefined,
				}}
			>
				<AppIcon
					name={selectedNode ? getSourceIcon(selectedNode.source) : "brain"}
					size={24}
				/>
			</div>
			<div>
				<div style={sectionLabelStyle}>Memoria seleccionada</div>
				<h3 style={{ margin: "4px 0 0", color: "#f4f4f5", fontSize: "1rem" }}>
					{selectedNode?.label ?? "Selecciona un nodo"}
				</h3>
			</div>
		</div>

		{selectedNode ? (
			<>
				<div
					style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}
				>
					<span
						className="settings-chip"
						style={{
							background: hexToRgba(getSourceColor(selectedNode.source), 0.14),
							borderColor: hexToRgba(getSourceColor(selectedNode.source), 0.28),
							color: getSourceColor(selectedNode.source),
						}}
					>
						{getSourceLabel(selectedNode.source)}
					</span>
					<span className="settings-chip settings-chip--mono">
						{selectedNode.type}
					</span>
					<span className="settings-chip settings-chip--mono">
						peso {Math.round(selectedNode.weight * 100)}%
					</span>
				</div>

				<div
					style={{
						marginTop: 16,
						padding: 14,
						borderRadius: 14,
						background: "rgba(15,17,23,0.72)",
						border: "1px solid #27272a",
						color: "#d4d4d8",
						fontSize: "0.86rem",
						lineHeight: 1.55,
					}}
				>
					{truncateText(selectedNode.content, compact ? 420 : 620)}
				</div>

				{onOpenSource && (
					<button
						type="button"
						onClick={() => onOpenSource(selectedNode)}
						style={{
							width: "100%",
							marginTop: 12,
							padding: "12px 14px",
							borderRadius: 12,
							border: `1px solid ${hexToRgba(getSourceColor(selectedNode.source), 0.42)}`,
							background: `linear-gradient(135deg, ${hexToRgba(getSourceColor(selectedNode.source), 0.24)}, rgba(9,9,11,0.86))`,
							color: "#f4f4f5",
							fontWeight: 900,
							cursor: "pointer",
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 12,
						}}
					>
						<span>Abrir memoria</span>
						<span style={{ color: getSourceColor(selectedNode.source) }}>
							{getSourceLabel(selectedNode.source)}
						</span>
					</button>
				)}

				{selectedEdges[0] &&
					(() => {
						const edge = selectedEdges[0];
						const otherId = edge.from === selectedNode.id ? edge.to : edge.from;
						const other = graph.nodes.find((node) => node.id === otherId);
						if (!other) return null;
						const color = getSourceColor(other.source);
						return (
							<button
								type="button"
								onClick={() => onSelectNode(other.id)}
								style={{
									width: "100%",
									marginTop: 12,
									padding: "12px 14px",
									borderRadius: 12,
									border: `1px solid ${hexToRgba(color, 0.38)}`,
									background: `linear-gradient(135deg, ${hexToRgba(color, 0.22)}, rgba(9,9,11,0.82))`,
									color: "#f4f4f5",
									fontWeight: 900,
									cursor: "pointer",
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									gap: 12,
								}}
							>
								<span>Explorar conexión clave</span>
								<span style={{ color }}>{truncateText(other.label, 30)}</span>
							</button>
						);
					})()}

				{selectedNode.keywords.length > 0 && (
					<div style={{ marginTop: 16 }}>
						<div style={sectionLabelStyle}>Etiquetas</div>
						<div className="settings-chip-list">
							{selectedNode.keywords
								.slice(0, compact ? 8 : 14)
								.map((keyword) => (
									<span key={keyword} className="settings-chip">
										{keyword}
									</span>
								))}
						</div>
					</div>
				)}

				<div style={{ marginTop: 18 }}>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							gap: 12,
							alignItems: "center",
						}}
					>
						<div style={sectionLabelStyle}>
							Conexiones navegables ({selectedEdges.length})
						</div>
					</div>
					<div style={{ display: "grid", gap: 8, marginTop: 10 }}>
						{selectedEdges.slice(0, compact ? 5 : 12).map((edge) => {
							const otherId =
								edge.from === selectedNode.id ? edge.to : edge.from;
							const other = graph.nodes.find((node) => node.id === otherId);
							const otherColor = other
								? getSourceColor(other.source)
								: "#71717a";
							return (
								<button
									key={`${edge.from}-${edge.to}`}
									type="button"
									onClick={() => other && onSelectNode(other.id)}
									style={{
										padding: "11px 12px",
										borderRadius: 12,
										border: `1px solid ${hexToRgba(otherColor, 0.24)}`,
										background: `linear-gradient(90deg, ${hexToRgba(otherColor, 0.1)}, rgba(9,9,11,0.72))`,
										color: "#a1a1aa",
										cursor: other ? "pointer" : "default",
										textAlign: "left",
									}}
								>
									<div
										style={{
											color: otherColor,
											fontSize: "0.68rem",
											fontWeight: 900,
											letterSpacing: "0.05em",
											textTransform: "uppercase",
										}}
									>
										{selectedNode.label} → {other?.label ?? otherId}
									</div>
									<div
										style={{
											color: "#f4f4f5",
											fontWeight: 700,
											fontSize: "0.82rem",
											marginTop: 5,
										}}
									>
										{other?.label ?? otherId}
									</div>
									<div style={{ marginTop: 4, fontSize: "0.74rem" }}>
										{edge.keywords.join(", ") || "relación semántica"}
									</div>
								</button>
							);
						})}
						{selectedEdges.length === 0 && (
							<div style={{ color: "#71717a", fontSize: "0.84rem" }}>
								Este nodo aún no comparte keywords fuertes con otros recuerdos.
							</div>
						)}
					</div>
				</div>
			</>
		) : (
			<div
				style={{
					marginTop: 16,
					color: "#71717a",
					fontSize: "0.88rem",
					lineHeight: 1.55,
				}}
			>
				Selecciona cualquier nodo del mapa para inspeccionar contenido, fuente,
				keywords y memorias relacionadas.
			</div>
		)}
	</div>
);

const MemoryMetricCard: React.FC<{
	icon: AppIconName;
	label: string;
	value: string | number;
	detail: string;
	color: string;
}> = ({ icon, label, value, detail, color }) => (
	<div
		className="settings-summary-card hover-lift"
		style={{
			position: "relative",
			overflow: "hidden",
			background: `radial-gradient(circle at 18% 8%, ${hexToRgba(color, 0.18)}, transparent 34%), linear-gradient(180deg, rgba(24,24,27,0.96), rgba(9,9,11,0.95))`,
		}}
	>
		<div
			style={{
				position: "absolute",
				inset: "auto -30px -44px auto",
				width: 110,
				height: 110,
				borderRadius: 999,
				background: hexToRgba(color, 0.12),
				filter: "blur(10px)",
			}}
		/>
		<div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
			<div>
				<div className="settings-summary-label">{label}</div>
				<div
					className="settings-summary-value"
					style={{ fontSize: "1.45rem", color: "#f4f4f5" }}
				>
					{value}
				</div>
				<div style={{ marginTop: 5, color: "#71717a", fontSize: "0.78rem" }}>
					{detail}
				</div>
			</div>
			<div
				style={{
					width: 42,
					height: 42,
					borderRadius: 14,
					background: hexToRgba(color, 0.14),
					border: `1px solid ${hexToRgba(color, 0.26)}`,
					color,
					display: "grid",
					placeItems: "center",
					boxShadow: `0 0 20px ${hexToRgba(color, 0.18)}`,
				}}
			>
				<AppIcon name={icon} size={21} />
			</div>
		</div>
	</div>
);

const ProgressMetric: React.FC<{
	label: string;
	value: number;
	color: string;
}> = ({ label, value, color }) => {
	const normalized = Math.max(
		0,
		Math.min(1, Number.isFinite(value) ? value : 0),
	);
	return (
		<div>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					gap: 10,
					fontSize: "0.78rem",
					color: "#a1a1aa",
					marginBottom: 6,
				}}
			>
				<span>{label}</span>
				<span>{Math.round(normalized * 100)}%</span>
			</div>
			<div
				style={{
					height: 8,
					borderRadius: 999,
					background: "#18181b",
					overflow: "hidden",
					border: "1px solid #27272a",
				}}
			>
				<div
					style={{
						width: `${normalized * 100}%`,
						height: "100%",
						borderRadius: 999,
						background: `linear-gradient(90deg, ${color}, #67e8f9)`,
						boxShadow: `0 0 18px ${hexToRgba(color, 0.45)}`,
						transition: "width 450ms ease",
					}}
				/>
			</div>
		</div>
	);
};

const MemorySignalPanel: React.FC<{
	title: string;
	description: string;
	items: string[];
	empty?: string;
}> = ({ title, description, items, empty = "Sin datos disponibles." }) => (
	<div className="surface-panel">
		<h3 style={{ margin: 0, color: "#f4f4f5", fontSize: "0.98rem" }}>
			{title}
		</h3>
		<div style={{ marginTop: 5, color: "#71717a", fontSize: "0.78rem" }}>
			{description}
		</div>
		<div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
			{items.length > 0 ? (
				items.slice(0, 12).map((item) => (
					<span key={item} className="settings-chip" title={item}>
						{truncateText(item, 64)}
					</span>
				))
			) : (
				<span style={{ color: "#71717a", fontSize: "0.84rem" }}>{empty}</span>
			)}
		</div>
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
	if (type === "tool_strategy") return "#6366f1";
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
	return status === "all" ? "#6366f1" : getExperienceColor(status);
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

const ghostButtonStyle: React.CSSProperties = {
	padding: "8px 12px",
	borderRadius: 10,
	border: "1px solid #27272a",
	background: "rgba(9,9,11,0.72)",
	color: "#d4d4d8",
	cursor: "pointer",
	fontWeight: 700,
	fontSize: "0.8rem",
};

const sectionLabelStyle: React.CSSProperties = {
	fontSize: "0.72rem",
	textTransform: "uppercase",
	letterSpacing: "0.06em",
	color: "#71717a",
	fontWeight: 800,
};

const MEMORY_TYPE_COLORS: Record<string, string> = {
	episodic: "#f59e0b",
	fact: "#22c55e",
	procedural: "#6366f1",
	semantic: "#38bdf8",
	learn: "#a855f7",
	skill: "#ec4899",
};

const MemText: React.FC<{ text: string; limit?: number }> = ({
	text,
	limit = 280,
}) => {
	const [open, setOpen] = useState(false);
	const long = text.length > limit;
	return (
		<>
			<div className="mem-item__content">
				{open || !long ? text : `${text.slice(0, limit).trimEnd()}…`}
			</div>
			{long ? (
				<button
					type="button"
					className="mem-item__more"
					onClick={() => setOpen((v) => !v)}
				>
					{open ? "Ver menos" : "Ver más"}
				</button>
			) : null}
		</>
	);
};

const MemItem: React.FC<{
	accent?: string;
	meta?: React.ReactNode;
	title?: React.ReactNode;
	children?: React.ReactNode;
}> = ({ accent = "#6366f1", meta, title, children }) => (
	<div
		className="mem-item"
		style={{ "--mem-accent": accent } as React.CSSProperties}
	>
		<span className="mem-item__bar" />
		{meta ? <div className="mem-item__meta">{meta}</div> : null}
		{title ? <div className="mem-item__title">{title}</div> : null}
		{children}
	</div>
);

function getTabDescription(tab: TabId): string {
	const descriptions: Record<TabId, string> = {
		overview: "estado vivo",
		graph: "red visual",
		learning: "patrones",
		stm: "contexto actual",
		ltm: "recuerdos",
		knowledge: "multimodal",
		daily: "hoy",
		profile: "usuario",
	};
	return descriptions[tab];
}

function getRecordNumber(
	record: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("es").format(Math.round(value));
}

function getSourceColor(source: GraphNode["source"]): string {
	const colors: Record<GraphNode["source"], string> = {
		memory: "#6366f1",
		learning: "#a855f7",
		profile: "#10b981",
		daily: "#f59e0b",
		shortTerm: "#06b6d4",
	};
	return colors[source];
}

function getSourceIcon(source: GraphNode["source"]): AppIconName {
	const icons: Record<GraphNode["source"], AppIconName> = {
		memory: "database",
		learning: "check",
		profile: "user",
		daily: "file",
		shortTerm: "chat",
	};
	return icons[source];
}

function getSourceLabel(source: GraphNode["source"]): string {
	const labels: Record<GraphNode["source"], string> = {
		memory: "Largo plazo",
		learning: "Aprendizaje",
		profile: "Usuario",
		daily: "Memoria diaria",
		shortTerm: "Corto plazo",
	};
	return labels[source];
}

function getTabForGraphSource(source: GraphNode["source"]): TabId {
	const tabsBySource: Record<GraphNode["source"], TabId> = {
		memory: "ltm",
		learning: "learning",
		profile: "profile",
		daily: "daily",
		shortTerm: "stm",
	};
	return tabsBySource[source];
}

function buildGraphNodeSearchQuery(node: GraphNode): string {
	return (
		node.keywords.slice(0, 3).join(" ").trim() ||
		node.label.replace(/[·:]/g, " ").trim() ||
		truncateText(node.content, 80)
	);
}

function getLearningFilterForGraphNode(node: GraphNode): LearningInsightFilter {
	const normalized = node.type.replaceAll(" ", "_").toLowerCase();
	return LEARNING_FILTERS.includes(normalized as LearningInsightFilter)
		? (normalized as LearningInsightFilter)
		: "all";
}

function hexToRgba(hex: string, alpha: number): string {
	const normalized = hex.replace("#", "");
	const bigint = Number.parseInt(normalized, 16);
	const r = (bigint >> 16) & 255;
	const g = (bigint >> 8) & 255;
	const b = bigint & 255;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function createGraphLayout(
	nodes: GraphNode[],
): Record<string, { x: number; y: number }> {
	const layout: Record<string, { x: number; y: number }> = {};

	for (const cluster of GRAPH_CLUSTER_DEFS) {
		const clusterNodes = nodes.filter((node) => node.source === cluster.source);
		const total = Math.max(clusterNodes.length, 1);
		clusterNodes.forEach((node, index) => {
			if (total === 1) {
				layout[node.id] = { x: cluster.x, y: cluster.y };
				return;
			}
			const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
			const ring = index % 2 === 0 ? 0.82 : 1.08;
			layout[node.id] = {
				x: cluster.x + Math.cos(angle) * cluster.radiusX * ring,
				y: cluster.y + Math.sin(angle) * cluster.radiusY * ring,
			};
		});
	}

	return layout;
}

function scaleGraphLayout(
	layout: Record<string, { x: number; y: number }>,
	zoom: number,
): Record<string, { x: number; y: number }> {
	return Object.fromEntries(
		Object.entries(layout).map(([id, point]) => [
			id,
			scaleGraphPoint(point, zoom),
		]),
	);
}

function scaleGraphPoint(
	point: { x: number; y: number },
	zoom: number,
): { x: number; y: number } {
	const center = { x: 48, y: 44 };
	return {
		x: center.x + (point.x - center.x) * zoom,
		y: center.y + (point.y - center.y) * zoom,
	};
}

function countNodesBySource(
	nodes: GraphNode[],
): Partial<Record<GraphSource, number>> {
	return nodes.reduce<Partial<Record<GraphSource, number>>>((acc, node) => {
		acc[node.source] = (acc[node.source] ?? 0) + 1;
		return acc;
	}, {});
}

function getVisibleGraphNodes(
	graph: { nodes: GraphNode[]; edges: GraphEdge[] },
	selectedNodeId: string | null,
	sourceFilter: GraphSourceFilter,
	compact: boolean,
	focusConnectionsOnly = false,
): GraphNode[] {
	const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
	const connectedIds = new Set(
		selectedNodeId
			? graph.edges.flatMap((edge) =>
					edge.from === selectedNodeId
						? [edge.to]
						: edge.to === selectedNodeId
							? [edge.from]
							: [],
				)
			: [],
	);
	const perClusterLimit = compact ? 5 : 10;
	const visible = new Map<string, GraphNode>();

	if (focusConnectionsOnly && selectedNode) {
		visible.set(selectedNode.id, selectedNode);
		for (const id of connectedIds) {
			const node = graph.nodes.find((entry) => entry.id === id);
			if (node && (sourceFilter === "all" || node.source === sourceFilter)) {
				visible.set(node.id, node);
			}
		}
		return GRAPH_CLUSTER_DEFS.flatMap((cluster) =>
			Array.from(visible.values())
				.filter((node) => node.source === cluster.source)
				.sort((a, b) => b.weight - a.weight),
		);
	}

	for (const cluster of GRAPH_CLUSTER_DEFS) {
		if (sourceFilter !== "all" && sourceFilter !== cluster.source) continue;
		const clusterNodes = graph.nodes
			.filter((node) => node.source === cluster.source)
			.sort((a, b) => b.weight - a.weight)
			.slice(0, perClusterLimit);
		for (const node of clusterNodes) visible.set(node.id, node);
	}

	if (selectedNode) visible.set(selectedNode.id, selectedNode);
	for (const id of connectedIds) {
		const node = graph.nodes.find((entry) => entry.id === id);
		if (node && (sourceFilter === "all" || node.source === sourceFilter)) {
			visible.set(node.id, node);
		}
	}

	return GRAPH_CLUSTER_DEFS.flatMap((cluster) =>
		Array.from(visible.values())
			.filter((node) => node.source === cluster.source)
			.sort((a, b) => b.weight - a.weight),
	);
}

function getVisibleGraphEdges(
	edges: GraphEdge[],
	visibleIds: Set<string>,
	selectedNodeId: string | null,
	compact: boolean,
): GraphEdge[] {
	const visibleEdges = edges.filter(
		(edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to),
	);
	if (!selectedNodeId) return visibleEdges.slice(0, compact ? 28 : 42);

	const focused = visibleEdges.filter(
		(edge) => edge.from === selectedNodeId || edge.to === selectedNodeId,
	);
	const ambient = visibleEdges
		.filter(
			(edge) => edge.from !== selectedNodeId && edge.to !== selectedNodeId,
		)
		.slice(0, compact ? 10 : 16);
	return [...focused, ...ambient];
}

function buildMemoryActivityItems(
	visibleNodes: GraphNode[],
	selectedNode?: GraphNode,
): string[] {
	const base = selectedNode
		? [
				`Foco actualizado: ${selectedNode.label}`,
				`Conexiones recalculadas para ${getSourceLabel(selectedNode.source)}`,
			]
		: ["Red de memorias sincronizada"];
	const nodeEvents = visibleNodes
		.slice(0, 8)
		.map((node) => `${getSourceLabel(node.source)} · ${node.label}`);
	return [...base, ...nodeEvents];
}

function truncateText(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function humanizeGraphType(type: string): string {
	const normalized = type.replaceAll("_", " ").replaceAll("-", " ").trim();
	if (!normalized) return "Memoria";
	return normalized
		.split(/\s+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function formatMemoryNodeLabel(
	memory: LTMItem,
	index: number,
	content: string,
): string {
	const type = humanizeGraphType(memory.type ?? "memoria");
	const keyword = extractGraphKeywords(content)[0];
	return truncateText(
		keyword ? `${type} · ${keyword}` : `${type} ${index + 1}`,
		34,
	);
}

function formatInsightNodeLabel(
	insight: LearningInsight,
	index: number,
): string {
	const type = humanizeGraphType(
		insight.type || insight.domain || "aprendizaje",
	);
	const keyword =
		(insight.keywords ?? [])[0] ?? extractGraphKeywords(insight.content)[0];
	return truncateText(
		keyword ? `${type} · ${keyword}` : `${type} ${index + 1}`,
		34,
	);
}

function buildMemoryGraph(
	memories: LTMItem[],
	insights: LearningInsight[],
	context: DashboardGraphContext,
) {
	const syntheticNodes: GraphNode[] = [];
	if (context.stmTotal || context.stmTurns?.length) {
		const content =
			context.stmTurns?.map((turn) => turn.content).join(" ") ?? "";
		syntheticNodes.push({
			id: "system-short-term-memory",
			label: "Memoria activa",
			type: "short_term",
			weight: 0.82,
			content: content || `${context.stmTotal ?? 0} turnos activos en contexto`,
			keywords: extractGraphKeywords(
				content || "contexto activo conversacion reciente",
			),
			source: "shortTerm",
		});
	}
	if (context.dailySummary?.trim()) {
		syntheticNodes.push({
			id: "system-daily-memory",
			label: "Resumen diario",
			type: "daily",
			weight: 0.76,
			content: context.dailySummary,
			keywords: extractGraphKeywords(context.dailySummary),
			source: "daily",
		});
	}
	if (context.profile) {
		const profileText = [
			context.profile.displayName,
			context.profile.communicationStyle,
			context.profile.preferredLanguage,
			...Object.keys(context.profile.expertiseAreas ?? {}),
			...Object.values(context.profile.preferences ?? {}),
			...(context.profile.traits ?? []),
		]
			.filter(Boolean)
			.join(" ");
		syntheticNodes.push({
			id: "system-user-profile-memory",
			label: context.profile.displayName ?? "Perfil del usuario",
			type: "profile",
			weight: 0.88,
			content:
				profileText || "Preferencias, decisiones y patrones del usuario.",
			keywords: extractGraphKeywords(
				profileText || "usuario preferencias decisiones patrones",
			),
			source: "profile",
		});
	}

	const nodes: GraphNode[] = [
		...syntheticNodes,
		...memories.map((memory, index) => {
			const content = formatMemoryContent(memory);
			return {
				id: `memory-${memory.id ?? index}`,
				label: formatMemoryNodeLabel(memory, index, content),
				type: memory.type ?? "memory",
				weight: typeof memory.importance === "number" ? memory.importance : 0.5,
				content,
				keywords: extractGraphKeywords(content),
				source: "memory" as const,
			};
		}),
		...insights.map((insight, index) => ({
			id: `insight-${insight.id ?? index}`,
			label: formatInsightNodeLabel(insight, index),
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

	const edges: GraphEdge[] = [];
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

	// Anti-hairball: cap edges per node to the strongest few (no node cap — show all).
	const MAX_EDGES_PER_NODE = 6;
	const edgesByNode = new Map<string, GraphEdge[]>();
	for (const edge of edges) {
		if (!edgesByNode.has(edge.from)) edgesByNode.set(edge.from, []);
		if (!edgesByNode.has(edge.to)) edgesByNode.set(edge.to, []);
		const af = edgesByNode.get(edge.from);
		const at = edgesByNode.get(edge.to);
		if (af) af.push(edge);
		if (at) at.push(edge);
	}
	const keepEdge = new Set<GraphEdge>();
	for (const list of edgesByNode.values()) {
		const top = list
			.sort((a, b) => b.keywords.length - a.keywords.length)
			.slice(0, MAX_EDGES_PER_NODE);
		for (const e of top) keepEdge.add(e);
	}

	return {
		nodes,
		edges: edges.filter((edge) => keepEdge.has(edge)),
	};
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
