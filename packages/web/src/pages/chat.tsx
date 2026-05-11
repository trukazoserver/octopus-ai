import DOMPurify from "dompurify";
import { marked } from "marked";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, apiDelete, apiGet, apiPatch, apiPost } from "../hooks/useApi.js";

const WS_URL = `ws://${window.location.hostname}:18789`;
const ACTIVE_CONVERSATION_STORAGE_KEY = "octopus-active-conversation";

interface StatusData {
	provider?: string;
	fallback?: string;
	thinking?: string;
	maxTokens?: number;
	channels?: string[];
	memoryEnabled?: boolean;
	skillsEnabled?: boolean;
}

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

interface WsPayload {
	content?: string;
	response?: string;
	text?: string;
	chunk?: string;
	error?: string;
	message?: string;
	conversationId?: string;
	agentStatus?: string;
	toolName?: string;
	uiIconB64?: string;
	activityDetail?: string | null;
}

interface WsMessage {
	id: string;
	type: string;
	channel: string;
	payload: WsPayload;
	timestamp: number;
}

type AgentActivityStatus =
	| "thinking"
	| "tool"
	| "code"
	| "responding"
	| "tool_done"
	| "tool_error"
	| "tool_skipped";

type AgentStatus = "idle" | AgentActivityStatus;

interface AgentActivity {
	id: string;
	status: AgentActivityStatus;
	label: string;
	detail: string;
	toolName?: string | null;
	iconSvg?: string | null;
	timestamp: number;
}

const AGENT_ACTIVITY_STATUSES = new Set<string>([
	"thinking",
	"tool",
	"code",
	"responding",
	"tool_done",
	"tool_error",
	"tool_skipped",
]);

interface Conversation {
	id: string;
	title?: string | null;
	messages?: Array<{
		id?: string;
		role: string;
		content: string;
		timestamp?: string;
		[key: string]: unknown;
	}>;
	created_at?: string;
	updated_at?: string;
	createdAt?: number;
	updatedAt?: number;
}

interface Agent {
	id: string;
	name: string;
	description?: string;
}

function nanoid(size = 16): string {
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < size; i++)
		id += chars[Math.floor(Math.random() * chars.length)];
	return id;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatToolLabel(toolName?: string | null): string {
	if (!toolName) return "herramienta";
	return toolName.replace(/[_-]/g, " ");
}

function getActivityCopy(
	status: AgentActivityStatus,
	toolName?: string | null,
): { label: string; detail: string } {
	const toolLabel = formatToolLabel(toolName);
	switch (status) {
		case "thinking":
			return {
				label: "Pensando",
				detail: "Analizando la solicitud y preparando el siguiente paso.",
			};
		case "tool":
			return {
				label: `Usando ${toolLabel}`,
				detail: "Ejecutando una herramienta conectada.",
			};
		case "code":
			return {
				label: `Ejecutando ${toolLabel}`,
				detail: "Procesando código o comandos locales.",
			};
		case "responding":
			return {
				label: "Preparando respuesta",
				detail: "Organizando el resultado final para mostrarlo limpio.",
			};
		case "tool_done":
			return {
				label: `${toolLabel} completada`,
				detail: "Resultado recibido y agregado al contexto.",
			};
		case "tool_error":
			return {
				label: `${toolLabel} falló`,
				detail: "La herramienta devolvió un error; el agente continuará si puede.",
			};
		case "tool_skipped":
			return {
				label: `${toolLabel} omitida`,
				detail: "Se evitó repetir una acción o exceder el presupuesto de herramientas.",
			};
	}
}

function activityColor(status: AgentActivityStatus): string {
	if (status === "tool_skipped") return "#a1a1aa";
	if (status === "tool" || status === "tool_done") return "#f59e0b";
	if (status === "code") return "#10b981";
	if (status === "tool_error") return "#ef4444";
	if (status === "responding") return "#60a5fa";
	return "#818cf8";
}

function AgentActivityIcon({
	activity,
	active,
}: {
	activity: AgentActivity;
	active?: boolean;
}) {
	const color = activityColor(activity.status);
	if (activity.iconSvg && (activity.status === "tool" || activity.status === "code")) {
		return (
			<span
				style={{
					display: "flex",
					width: 18,
					height: 18,
					color,
					animation: active ? "toolFloat 1.4s infinite ease-in-out" : undefined,
				}}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: controlled server SVG icon
				dangerouslySetInnerHTML={{ __html: activity.iconSvg }}
			/>
		);
	}

	if (activity.status === "tool_done") {
		return (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M20 6 9 17l-5-5" />
			</svg>
		);
	}

	if (activity.status === "tool_error") {
		return (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
				<circle cx="12" cy="12" r="9" />
				<path d="m15 9-6 6M9 9l6 6" />
			</svg>
		);
	}

	if (activity.status === "tool_skipped") {
		return (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M5 12h14" />
				<path d="M12 5v14" opacity="0.35" />
			</svg>
		);
	}

	if (activity.status === "responding") {
		return (
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: active ? "pulse 1.4s infinite ease-in-out" : undefined }}>
				<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</svg>
		);
	}

	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ animation: active ? "spin 1.8s linear infinite" : undefined }}>
			<circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
			<path d="M12 3a9 9 0 0 1 9 9" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
		</svg>
	);
}

function AgentActivityPanel({ activities }: { activities: AgentActivity[] }) {
	const latest = activities[activities.length - 1];
	if (!latest) return null;
	const recent = activities.slice(-5);
	const color = activityColor(latest.status);

	return (
		<div className="agent-activity-row">
			<div className="agent-activity-avatar">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
					<path d="M12 3c-3.4 0-6 2.3-6 5.4 0 2.2 1.2 3.7 2.5 4.5" />
					<path d="M15.5 12.9c1.3-.8 2.5-2.3 2.5-4.5C18 5.3 15.4 3 12 3" />
					<path d="M8 14c-1.2 1.4-2.3 2.2-4 2.4" />
					<path d="M10 15c-.7 1.8-1.5 3-3.2 4" />
					<path d="M14 15c.7 1.8 1.5 3 3.2 4" />
					<path d="M16 14c1.2 1.4 2.3 2.2 4 2.4" />
					<circle cx="9.5" cy="8" r=".8" fill="currentColor" stroke="none" />
					<circle cx="14.5" cy="8" r=".8" fill="currentColor" stroke="none" />
				</svg>
			</div>
			<div className="agent-activity-card" style={{ borderColor: `${color}55` }}>
				<div className="agent-activity-current">
					<div className="agent-activity-orb" style={{ background: `${color}22`, boxShadow: `0 0 22px ${color}33` }}>
						<AgentActivityIcon activity={latest} active />
					</div>
					<div style={{ minWidth: 0 }}>
						<div className="agent-activity-title" style={{ color }}>{latest.label}</div>
						<div className="agent-activity-detail">{latest.detail}</div>
					</div>
					<div className="agent-activity-dots" aria-hidden="true">
						{[0, 1, 2].map((i) => (
							<span key={i} style={{ animationDelay: `${i * 0.16}s`, background: color }} />
						))}
					</div>
				</div>
				{recent.length > 1 && (
					<div className="agent-activity-steps">
						{recent.map((activity, index) => (
							<div key={activity.id} className="agent-activity-step">
								<span className="agent-activity-step-line" />
								<span className="agent-activity-step-icon">
									<AgentActivityIcon activity={activity} active={index === recent.length - 1} />
								</span>
								<span className="agent-activity-step-text">{activity.label}</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

const MEDIA_BASE = `http://${window.location.hostname}:18789`;

function isMediaUrl(href: string): boolean {
	return (
		href.startsWith("/api/media/file/") || href.includes("/api/media/file/")
	);
}

function getMediaType(url: string): "image" | "audio" | "video" | null {
	const path = url.split("?")[0] ?? "";
	if (/\.(mp3|wav|ogg|m4a|weba|flac)(\/|$)/i.test(path)) return "audio";
	if (/\.(mp4|webm|ogv|avi|mov)(\/|$)/i.test(path)) return "video";
	if (
		/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\/|$)/i.test(path) ||
		path.includes("/api/media/file/")
	) {
		return "image";
	}
	return null;
}

function renderMediaInline(url: string, alt?: string): string {
	const fullUrl = url.startsWith("http") ? url : MEDIA_BASE + url;
	const mediaType = getMediaType(url);
	if (mediaType === "image") {
		return `<div class="media-embed media-image"><img src="${fullUrl}" alt="${alt || ""}" loading="lazy" style="max-width:100%;border-radius:12px;cursor:pointer" onclick="window.openMediaPreview(this.src)" /></div>`;
	}
	if (mediaType === "audio") {
		return `<div class="media-embed media-audio" style="padding:12px 0"><audio controls src="${fullUrl}" style="width:100%;max-width:500px" preload="metadata"></audio></div>`;
	}
	if (mediaType === "video") {
		return `<div class="media-embed media-video"><video controls src="${fullUrl}" style="max-width:100%;border-radius:12px" preload="metadata"></video></div>`;
	}
	return "";
}

const mediaRenderer = {
	image({ href, text }: { href: string; text: string }): string {
		if (isMediaUrl(href)) {
			const media = renderMediaInline(href, text);
			if (media) return media;
		}
		return false as unknown as string;
	},
	link({ href, text }: { href: string; text: string }): string {
		if (isMediaUrl(href)) {
			const media = renderMediaInline(href, text);
			if (media) return media;
		}
		return false as unknown as string;
	},
};

marked.use({ renderer: mediaRenderer });

function renderMarkdown(text: string): string {
	try {
		let processed = text;
		// Strip think tags so they aren't displayed in the text bubble
		processed = processed.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");
		
		// Convert relative markdown images to absolute URLs for rendering
		processed = processed.replace(/!\[(.*?)\]\(\/api\/media\/file\/([^)]+)\)/g, `![$1](${MEDIA_BASE}/api/media/file/$2)`);
		
		// Detect bare media URLs and convert to embeddable media
		processed = processed.replace(
			/(?:^|\n)\s*(https?:\/\/[^\s<>"']+\/(?:api\/media\/file\/)?[^\s<>"']+\.(?:png|jpg|jpeg|gif|webp|svg|mp3|wav|ogg|m4a|mp4|webm)|\/api\/media\/file\/[^\s<>"']+)/gi,
			(match: string, url: string) => {
				const fullUrl = url.startsWith("http") ? url : MEDIA_BASE + url;
				const mediaType = getMediaType(url);
				if (mediaType === "image") return `\n![image](${fullUrl})\n`;
				if (mediaType === "audio") return `\n${renderMediaInline(url)}\n`;
				if (mediaType === "video") return `\n${renderMediaInline(url)}\n`;
				return match;
			},
		);
		const html = marked.parse(processed, {
			async: false,
			breaks: true,
			gfm: true,
		}) as string;
		return DOMPurify.sanitize(html, {
			ADD_TAGS: ["img", "audio", "video", "source"],
			ADD_ATTR: [
				"src",
				"controls",
				"loading",
				"preload",
				"onclick",
				"style",
				"class",
			],
		});
	} catch {
		return DOMPurify.sanitize(text, {
			ADD_TAGS: ["img", "audio", "video", "source"],
			ADD_ATTR: [
				"src",
				"controls",
				"loading",
				"preload",
				"onclick",
				"style",
				"class",
			],
		});
	}
}

function getPayloadText(payload: WsPayload | string | undefined): string {
	if (typeof payload === "string") return payload;
	if (!payload) return "";

	const text =
		payload.content ??
		payload.response ??
		payload.text ??
		payload.chunk ??
		payload.message;

	if (typeof text === "string") return text;
	return JSON.stringify(payload);
}

const SIDEBAR_WIDTH = 280;

export const ChatPage: React.FC = () => {
	const [messages, setMessages] = useState<Message[]>([]);
	const messagesRef = useRef<Message[]>([]);
	const [input, setInput] = useState("");
	const [isConnected, setIsConnected] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [status, setStatus] = useState<StatusData | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const pendingIdRef = useRef<string>("");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isUploadingImage, setIsUploadingImage] = useState(false);
	const [pendingAttachments, setPendingAttachments] = useState<{url: string, file: File, previewUrl: string}[]>([]);
	const clearPendingAttachments = useCallback(() => {
		setPendingAttachments((current) => {
			for (const attachment of current) URL.revokeObjectURL(attachment.previewUrl);
			return [];
		});
	}, []);
	const removePendingAttachment = useCallback((index: number) => {
		setPendingAttachments((current) => {
			const removed = current[index];
			if (removed) URL.revokeObjectURL(removed.previewUrl);
			return current.filter((_, i) => i !== index);
		});
	}, []);

	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [conversationsLoaded, setConversationsLoaded] = useState(false);
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(() => {
		try {
			return localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
		} catch {
			return null;
		}
	});
	const activeConvRef = useRef<string | null>(null);
	const [agents, setAgents] = useState<Agent[]>([]);
	const [selectedAgentId, setSelectedAgentId] = useState<string>("");
	const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
		try {
			return localStorage.getItem("octopus-stream") !== "false";
		} catch {
			return true;
		}
	});
	const [isStreaming, setIsStreaming] = useState(false);
	const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
	const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
	const lastActivityKeyRef = useRef<string>("");
	const [editingConvId, setEditingConvId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState("");
	const [mediaPreviewSrc, setMediaPreviewSrc] = useState<string | null>(null);

	// Register global media preview handler for onclick in rendered HTML
	useEffect(() => {
		(window as unknown as Record<string, unknown>).openMediaPreview = (
			src: string,
		) => setMediaPreviewSrc(src);
		return () => {
			(window as unknown as Record<string, unknown>).openMediaPreview =
				undefined;
		};
	}, []);

	useEffect(() => {
		messagesRef.current = messages;
	}, [messages]);

	const [stats, setStats] = useState<{
		agents: number;
		tools: number;
		mcp: number;
		tasks: number;
		memories: number;
	} | null>(null);

	const addAgentActivity = useCallback(
		(
			status: AgentActivityStatus,
			toolName?: string | null,
			iconSvg?: string | null,
			activityDetail?: string | null,
		) => {
			const key = `${status}:${toolName ?? ""}:${activityDetail?.trim() ?? ""}`;
			if (
				lastActivityKeyRef.current === key &&
				status !== "tool_done" &&
				status !== "tool_error"
			) {
				return;
			}

			lastActivityKeyRef.current = key;
			const copy = getActivityCopy(status, toolName);
			const detail = activityDetail?.trim() || copy.detail;
			setAgentActivity((prev) => [
				...prev,
				{
					id: nanoid(8),
					status,
					label: copy.label,
					detail,
					toolName: toolName ?? null,
					iconSvg: iconSvg ?? null,
					timestamp: Date.now(),
				},
			].slice(-6));
		},
		[],
	);

	const loadDashboardStats = useCallback(async () => {
		try {
			const [agents, mcp, memory] = await Promise.all([
				apiGet<unknown[]>("/api/agents").catch(() => []),
				apiGet<unknown[]>("/api/mcp/servers").catch(() => []),
				apiGet<{ longTerm?: { maxItems?: number } }>("/api/memory/stats").catch(
					() => ({ longTerm: { maxItems: 0 } }),
				),
			]);
			setStats({
				agents: agents.length,
				tools: 10 + mcp.length * 3, // Est.
				mcp: mcp.length,
				tasks: 0,
				memories: memory.longTerm?.maxItems ?? 0,
			});
		} catch {}
	}, []);

	useEffect(() => {
		if (!activeConversationId && messages.length === 0) {
			loadDashboardStats();
		}
	}, [activeConversationId, messages.length, loadDashboardStats]);

	useEffect(() => {
		apiGet<StatusData>("/api/status")
			.then(setStatus)
			.catch(() => {});
	}, []);

	useEffect(() => {
		apiGet<Agent[]>("/api/agents")
			.then((list) => {
				setAgents(list);
				if (list.length > 0 && !selectedAgentId) {
					setSelectedAgentId(list[0].id);
				}
			})
			.catch(() => {});
	}, []);

	const loadConversations = useCallback(() => {
		apiGet<Conversation[]>("/api/conversations")
			.then((list) => {
				setConversations(list);
				setConversationsLoaded(true);
			})
			.catch(() => {
				setConversationsLoaded(true);
			});
	}, []);

	useEffect(() => {
		loadConversations();
	}, [loadConversations]);

	useEffect(() => {
		// Don't auto-select until conversations have been loaded from the API
		if (!conversationsLoaded) return;

		if (conversations.length === 0) {
			if (activeConversationId !== null) {
				setActiveConversationId(null);
			}
			return;
		}

		const exists =
			activeConversationId !== null &&
			conversations.some((conv) => conv.id === activeConversationId);
		
		if (!exists) {
			setActiveConversationId(conversations[0]?.id ?? null);
		}
	}, [conversations, activeConversationId, conversationsLoaded]);

	const loadConversationMessages = useCallback(async (convId: string) => {
		try {
			const raw = await apiGet<{ conversation: Conversation }>(
				`/api/conversations/${convId}`,
			);
			const conv = raw.conversation ?? (raw as unknown as Conversation);
			if (conv.messages && conv.messages.length > 0) {
				setMessages(
					conv.messages.map((m) => ({
						id: m.id || nanoid(),
						role: m.role as "user" | "assistant",
						content: m.content,
						timestamp: new Date(m.timestamp || Date.now()).getTime(),
					})),
				);
			} else {
				setMessages([]);
			}
		} catch {
			setMessages([]);
		}
	}, []);

	useEffect(() => {
		activeConvRef.current = activeConversationId;
		try {
			if (activeConversationId) {
				localStorage.setItem(
					ACTIVE_CONVERSATION_STORAGE_KEY,
					activeConversationId,
				);
			} else {
				localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
			}
		} catch {
			// ignore storage failures
		}

		if (activeConversationId) {
			void loadConversationMessages(activeConversationId);
		} else {
			setMessages([]);
		}
	}, [activeConversationId, loadConversationMessages]);

	const handleSelectConversation = useCallback(
		(convId: string) => {
			setActiveConversationId(convId);
		},
		[],
	);

	const handleNewChat = useCallback(async () => {
		try {
			const body: Record<string, string> = {};
			if (selectedAgentId) body.agentId = selectedAgentId;
			const result = await apiPost("/api/conversations", body);
			const created =
				(result.conversation as Conversation | undefined) ??
				(result as unknown as Conversation);
			const newConv: Conversation = {
				id: created.id || nanoid(),
				title: created.title || "Nueva conversación",
			};
			setConversations((prev) => [newConv, ...prev]);
			setActiveConversationId(newConv.id);
			activeConvRef.current = newConv.id;
			setMessages([]);
		} catch {
			setActiveConversationId(null);
			setMessages([]);
		}
	}, [selectedAgentId]);

	const handleDeleteConversation = useCallback(
		async (convId: string) => {
			try {
				await apiDelete(`/api/conversations/${convId}`);
				setConversations((prev) => prev.filter((c) => c.id !== convId));
				if (activeConversationId === convId) {
					setActiveConversationId(null);
					activeConvRef.current = null;
					setMessages([]);
				}
			} catch {}
		},
		[activeConversationId],
	);

	const scrollToBottom = useCallback((instant?: boolean) => {
		const doScroll = () => {
			if (messagesContainerRef.current) {
				const container = messagesContainerRef.current;
				if (instant) {
					container.scrollTop = container.scrollHeight;
				} else {
					container.scrollTo({
						top: container.scrollHeight,
						behavior: "smooth",
					});
				}
			} else {
				messagesEndRef.current?.scrollIntoView({
					behavior: instant ? "instant" as ScrollBehavior : "smooth",
					block: "end",
				});
			}
		};
		setTimeout(doScroll, 30);
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [messages, scrollToBottom]);

	const handleSaveTitle = async (convId: string) => {
		if (!editingTitle.trim()) {
			setEditingConvId(null);
			return;
		}
		try {
			await apiPatch(`/api/conversations/${convId}`, {
				title: editingTitle.trim(),
			});
			setConversations((prev) =>
				prev.map((c) =>
					c.id === convId ? { ...c, title: editingTitle.trim() } : c,
				),
			);
		} catch {}
		setEditingConvId(null);
	};

	const connect = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) return;

		const ws = new WebSocket(WS_URL);

		ws.onopen = () => {
			setIsConnected(true);
		};

		ws.onclose = () => {
			setIsConnected(false);
			setTimeout(connect, 3000);
		};

		ws.onerror = () => {
			ws.close();
		};

		ws.onmessage = (event) => {
			try {
				const msg: WsMessage = JSON.parse(event.data);

				if (msg.type === "pong") return;

				const conversationId = msg.payload?.conversationId;
				if (conversationId && !activeConvRef.current) {
					setActiveConversationId(conversationId);
					activeConvRef.current = conversationId;
					const lastUserMsg =
						messagesRef.current[messagesRef.current.length - 1];
					const autoTitle =
						lastUserMsg?.role === "user" &&
						lastUserMsg.content.trim().length > 0
							? lastUserMsg.content.length > 50
								? `${lastUserMsg.content.substring(0, 50).trimEnd()}...`
								: lastUserMsg.content
							: "Nueva conversación";
					setConversations((prev) => {
						if (prev.some((c) => c.id === conversationId))
							return prev;
						return [
							{
								id: conversationId,
								title: autoTitle,
							},
							...prev,
						];
					});
					if (
						autoTitle !== "Nueva conversación" &&
						lastUserMsg?.role === "user"
					) {
						apiPatch(`/api/conversations/${conversationId}`, {
							title: autoTitle,
						}).catch(() => {});
					}
				}

				if (msg.type === "response") {
					setAgentStatus("idle");
					setAgentActivity([]);
					lastActivityKeyRef.current = "";
					const assistantContent = getPayloadText(msg.payload);

					setMessages((prev) => {
						const existing = prev.find((m) => m.id === `stream-${msg.id}`);
						if (existing) {
							return prev.map((m) =>
								m.id === `stream-${msg.id}`
									? {
											...m,
											content: assistantContent,
											role: "assistant" as const,
										}
									: m,
							);
						}
						return [
							...prev,
							{
								id: msg.id,
								role: "assistant",
								content: assistantContent,
								timestamp: Date.now(),
							},
						];
					});
					setIsLoading(false);
					pendingIdRef.current = "";
					loadConversations();
					inputRef.current?.focus();
				} else if (msg.type === "stream") {
					const chunk = getPayloadText(msg.payload);
					const streamId = `stream-${msg.id}`;
					setIsStreaming(true);
					setAgentStatus("responding");
					addAgentActivity("responding");
					setMessages((prev) => {
						const existing = prev.find((m) => m.id === streamId);
						if (existing) {
							return prev.map((m) =>
								m.id === streamId ? { ...m, content: m.content + chunk } : m,
							);
						}
						return [
							...prev,
							{
								id: streamId,
								role: "assistant",
								content: chunk,
								timestamp: Date.now(),
							},
						];
					});
					// Auto-scroll on each streaming chunk
					scrollToBottom(true);
				} else if (msg.type === "stream_end") {
					setIsLoading(false);
					setIsStreaming(false);
					setAgentStatus("idle");
					setAgentActivity([]);
					lastActivityKeyRef.current = "";
					pendingIdRef.current = "";
					loadConversations();
					inputRef.current?.focus();
				} else if (msg.type === "event") {
					const agentStatus = msg.payload?.agentStatus;
					if (
						agentStatus &&
						AGENT_ACTIVITY_STATUSES.has(agentStatus)
					) {
						const nextStatus = agentStatus as AgentActivityStatus;
						const nextToolName = msg.payload?.toolName || null;
						const iconB64 = msg.payload?.uiIconB64;
						let nextIcon: string | null = null;
						if (iconB64) {
							try {
								nextIcon = atob(iconB64);
							} catch {
								nextIcon = null;
							}
						}
						setAgentStatus(nextStatus);
						addAgentActivity(
							nextStatus,
							nextToolName,
							nextIcon,
							msg.payload?.activityDetail,
						);
						scrollToBottom(true);
					}
				} else if (msg.type === "error") {
					const errMsg = msg.payload?.error || "Error desconocido";
					setMessages((prev) => [
						...prev,
						{
							id: nanoid(),
							role: "assistant",
							content: `⚠️ Error: ${errMsg}`,
							timestamp: Date.now(),
						},
					]);
					setIsLoading(false);
					setIsStreaming(false);
					setAgentStatus("idle");
					setAgentActivity([]);
					lastActivityKeyRef.current = "";
					pendingIdRef.current = "";
					loadConversations();
				}
			} catch (err) {
				console.error("Failed to parse WS message:", err);
			}
		};

		wsRef.current = ws;
	}, [addAgentActivity, loadConversations, scrollToBottom]);

	useEffect(() => {
		connect();
		return () => {
			wsRef.current?.close();
			clearPendingAttachments();
		};
	}, [connect, clearPendingAttachments]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSend = () => {
		const text = input.trim();
		if ((!text && pendingAttachments.length === 0) || !isConnected || isLoading) return;

		let finalContent = text;
		if (pendingAttachments.length > 0) {
			const imagesMd = pendingAttachments.map(a => `![Image](${a.url})`).join("\n");
			finalContent = finalContent ? `${finalContent}\n\n${imagesMd}` : imagesMd;
		}

		const userMsg: Message = {
			id: nanoid(),
			role: "user",
			content: text,
			timestamp: Date.now(),
		};
		setMessages((prev) => [...prev, userMsg]);
		setInput("");
		clearPendingAttachments();
		setIsLoading(true);
		setIsStreaming(false);
		setAgentStatus("thinking");
		lastActivityKeyRef.current = "";
		const initialActivityCopy = getActivityCopy("thinking");
		setAgentActivity([
			{
				id: nanoid(8),
				status: "thinking",
				label: initialActivityCopy.label,
				detail: initialActivityCopy.detail,
				timestamp: Date.now(),
			},
		]);
		lastActivityKeyRef.current = "thinking::";

		if (inputRef.current) {
			inputRef.current.style.height = "auto";
			inputRef.current.focus();
		}

		const requestId = nanoid();
		pendingIdRef.current = requestId;

		const payload: Record<string, unknown> = {
			message: finalContent,
			stream: streamEnabled,
		};
		if (activeConversationId) payload.conversationId = activeConversationId;
		if (selectedAgentId) payload.agentId = selectedAgentId;

		const wsMsg: WsMessage = {
			id: requestId,
			type: "request",
			channel: "chat",
			payload: payload as WsPayload,
			timestamp: Date.now(),
		};

		const convIdForTitle = payload.conversationId as string | undefined;
		const isFirstMsg = messagesRef.current.length === 0;

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(wsMsg));

			if (isFirstMsg && finalContent.trim().length > 0) {
				const targetConvId = convIdForTitle ?? activeConversationId;
				if (targetConvId) {
					const titleSource = text || "Imagen";
					const title =
						titleSource.length > 50 ? `${titleSource.substring(0, 50).trimEnd()}...` : titleSource;
					apiPatch(`/api/conversations/${targetConvId}`, { title }).catch(
						() => {},
					);
					setConversations((prev) =>
						prev.map((c) => (c.id === targetConvId ? { ...c, title } : c)),
					);
				}
			}
		} else {
			setMessages((prev) => [
				...prev,
				{
					id: nanoid(),
					role: "assistant",
					content:
						"⚠️ No hay conexión con el servidor. Verifica que el backend esté corriendo.",
					timestamp: Date.now(),
				},
			]);
			setIsLoading(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setInput(e.target.value);
		e.target.style.height = "auto";
		e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
	};

	const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		setIsUploadingImage(true);
		try {
			const formData = new FormData();
			formData.append("file", file);
			
			const res = await fetch(`${API_BASE}/api/media/upload`, {
				method: "POST",
				body: formData,
			});
			
			if (!res.ok) throw new Error("Error al subir archivo");
			const data = await res.json();
			
			const previewUrl = URL.createObjectURL(file);
			setPendingAttachments((prev) => [...prev, { url: data.url, file, previewUrl }]);
			if (inputRef.current) inputRef.current.focus();
		} catch (error) {
			console.error("Upload error:", error);
			setAgentActivity((prev) => [
				{
					id: nanoid(8),
					status: "tool_error",
					label: "No se pudo adjuntar la imagen",
					detail: error instanceof Error ? error.message : "Error de subida",
					timestamp: Date.now(),
				},
				...prev.slice(0, 4),
			]);
		} finally {
			setIsUploadingImage(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	return (
		<div
			style={{
				display: "flex",
				height: "100%",
				background: "#09090b",
				color: "#f4f4f5",
			}}
		>
			{/* Sidebar */}
			{sidebarOpen && (
				<div
					style={{
						width: SIDEBAR_WIDTH,
						minWidth: SIDEBAR_WIDTH,
						background: "#0f0f12",
						borderRight: "1px solid #27272a",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<div
						style={{
							padding: "16px 16px 12px",
							borderBottom: "1px solid #27272a",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
						}}
					>
						<span
							style={{ fontSize: "0.95rem", fontWeight: 600, color: "#f4f4f5" }}
						>
							Conversaciones
						</span>
						<button
							type="button"
							onClick={() => {
								void handleNewChat();
								inputRef.current?.focus();
							}}
							style={{
								padding: "6px",
								borderRadius: "8px",
								border: "1px solid #3f3f46",
								background: "#18181b",
								color: "#f4f4f5",
								cursor: "pointer",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								transition: "background 0.2s",
							}}
							title="Nueva conversación / Dashboard"
							onMouseEnter={(e) => {
								e.currentTarget.style.background = "#27272a";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.background = "#18181b";
							}}
						>
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<line x1="12" y1="5" x2="12" y2="19" />
								<line x1="5" y1="12" x2="19" y2="12" />
							</svg>
						</button>
					</div>

					<div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
						{conversations.length === 0 && (
							<div
								style={{
									padding: "20px 12px",
									textAlign: "center",
									color: "#52525b",
									fontSize: "0.8rem",
								}}
							>
								No hay conversaciones
							</div>
						)}
						{conversations.map((conv) => (
							<div
								key={conv.id}
								style={{
									display: "flex",
									alignItems: "center",
									padding: "10px 12px",
									borderRadius: "10px",
									cursor: "pointer",
									marginBottom: "2px",
									background:
										activeConversationId === conv.id
											? "#27272a"
											: "transparent",
									transition: "background 0.15s",
									gap: "8px",
								}}
								onClick={() => handleSelectConversation(conv.id)}
								onMouseEnter={(e) => {
									if (activeConversationId !== conv.id) {
										e.currentTarget.style.background = "#1c1c22";
									}
								}}
								onMouseLeave={(e) => {
									if (activeConversationId !== conv.id) {
										e.currentTarget.style.background = "transparent";
									}
								}}
							>
								<div style={{ flex: 1, overflow: "hidden" }}>
									{editingConvId === conv.id ? (
										<input
											id={`conversation-title-${conv.id}`}
											name="conversationTitle"
											type="text"
											value={editingTitle}
											onChange={(e) => setEditingTitle(e.target.value)}
											onBlur={() => void handleSaveTitle(conv.id)}
											onKeyDown={(e) => {
												if (e.key === "Enter") void handleSaveTitle(conv.id);
												if (e.key === "Escape") setEditingConvId(null);
											}}
											onClick={(e) => e.stopPropagation()}
											style={{
												width: "100%",
												background: "#09090b",
												border: "1px solid #3f3f46",
												color: "#f4f4f5",
												fontSize: "0.83rem",
												padding: "2px 4px",
												borderRadius: "4px",
												outline: "none",
											}}
										/>
									) : (
										<div
											style={{
												fontSize: "0.83rem",
												color:
													activeConversationId === conv.id
														? "#f4f4f5"
														: "#d4d4d8",
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
											}}
											onDoubleClick={(e) => {
												e.stopPropagation();
												setEditingConvId(conv.id);
												setEditingTitle(conv.title || "Sin título");
											}}
											title="Doble clic para editar"
										>
											{conv.title || "Sin título"}
										</div>
									)}
								</div>
								<div
									style={{
										display: "flex",
										gap: "4px",
										opacity: activeConversationId === conv.id ? 1 : 0.6,
									}}
								>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setEditingConvId(conv.id);
											setEditingTitle(conv.title || "Sin título");
										}}
										title="Editar título"
										style={{
											background: "none",
											border: "none",
											color: "#52525b",
											cursor: "pointer",
											padding: "4px",
											borderRadius: "6px",
											display: "flex",
											alignItems: "center",
											flexShrink: 0,
											transition: "color 0.15s",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.color = "#a1a1aa";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.color = "#52525b";
										}}
									>
										<svg
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
											<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
										</svg>
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											handleDeleteConversation(conv.id);
										}}
										title="Eliminar conversación"
										style={{
											background: "none",
											border: "none",
											color: "#52525b",
											cursor: "pointer",
											padding: "4px",
											borderRadius: "6px",
											display: "flex",
											alignItems: "center",
											flexShrink: 0,
											transition: "color 0.15s",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.color = "#ef4444";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.color = "#52525b";
										}}
									>
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<polyline points="3 6 5 6 21 6" />
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
										</svg>
									</button>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Main area */}
			<div
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					height: "100%",
					minWidth: 0,
				}}
			>
				{/* Top bar */}
				<div
					className="chat-status-bar"
					style={{
						padding: "10px 24px",
						background: "#09090b",
						borderBottom: "1px solid #27272a",
						display: "flex",
						alignItems: "center",
						gap: "10px",
						flexWrap: "wrap",
					}}
				>
					<button
						type="button"
						onClick={() => setSidebarOpen((v) => !v)}
						style={{
							background: "none",
							border: "1px solid #3f3f46",
							borderRadius: "8px",
							color: "#a1a1aa",
							cursor: "pointer",
							padding: "6px 8px",
							display: "flex",
							alignItems: "center",
							transition: "border-color 0.2s",
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.borderColor = "#6366f1";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.borderColor = "#3f3f46";
						}}
						title={sidebarOpen ? "Ocultar panel" : "Mostrar panel"}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
							<line x1="9" y1="3" x2="9" y2="21" />
						</svg>
					</button>

					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							padding: "6px 12px",
							borderRadius: "8px",
							background: isConnected
								? "rgba(16, 185, 129, 0.1)"
								: "rgba(239, 68, 68, 0.1)",
							border: `1px solid ${isConnected ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
						}}
					>
						<div
							style={{
								width: "8px",
								height: "8px",
								borderRadius: "50%",
								background: isConnected ? "#10b981" : "#ef4444",
								flexShrink: 0,
								boxShadow: isConnected
									? "0 0 8px rgba(16, 185, 129, 0.5)"
									: "0 0 8px rgba(239, 68, 68, 0.5)",
								animation: isConnected ? "pulse 2s infinite" : "none",
							}}
						/>
						<span
							style={{
								color: isConnected ? "#10b981" : "#ef4444",
								fontSize: "0.85rem",
								fontWeight: 700,
							}}
						>
							{isConnected ? "● CONECTADO" : "○ DESCONECTADO"}
						</span>
					</div>

					{/* Agent selector */}
					<select
						id="chat-agent-selector"
						name="agentId"
						value={selectedAgentId}
						onChange={(e) => setSelectedAgentId(e.target.value)}
						style={{
							marginLeft: "12px",
							padding: "6px 12px",
							borderRadius: "8px",
							border: "1px solid #3f3f46",
							background: "#18181b",
							color: "#f4f4f5",
							fontSize: "0.8rem",
							outline: "none",
							cursor: "pointer",
							fontFamily: "inherit",
						}}
					>
						<option value="">Seleccionar agente</option>
						{agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))}
					</select>

					<button
						type="button"
						onClick={() => {
							const next = !streamEnabled;
							setStreamEnabled(next);
							try {
								localStorage.setItem("octopus-stream", String(next));
							} catch {}
						}}
						title={
							streamEnabled
								? "Streaming activado (respuesta en tiempo real)"
								: "Streaming desactivado (respuesta completa)"
						}
						style={{
							marginLeft: "8px",
							padding: "6px 12px",
							borderRadius: "8px",
							border: `1px solid ${streamEnabled ? "rgba(99, 102, 241, 0.4)" : "#3f3f46"}`,
							background: streamEnabled ? "rgba(99, 102, 241, 0.1)" : "#18181b",
							color: streamEnabled ? "#818cf8" : "#71717a",
							fontSize: "0.8rem",
							cursor: "pointer",
							display: "flex",
							alignItems: "center",
							gap: "6px",
							fontWeight: 500,
							transition: "all 0.2s",
							fontFamily: "inherit",
						}}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
						</svg>
						{streamEnabled ? "Stream" : "Completo"}
					</button>

					<div style={{ flex: 1 }} />
					{status?.provider && (
						<div
							className="chat-status-meta"
							style={{ display: "flex", alignItems: "center", gap: "8px" }}
						>
							{status.thinking && status.thinking !== "none" && (
								<span
									style={{
										fontSize: "0.75rem",
										padding: "4px 10px",
										borderRadius: "20px",
										background: "rgba(16, 185, 129, 0.1)",
										color: "#10b981",
										border: "1px solid rgba(16, 185, 129, 0.2)",
										fontWeight: 500,
									}}
								>
									Razonamiento: {status.thinking}
								</span>
							)}
							<span
								style={{
									fontSize: "0.75rem",
									padding: "4px 10px",
									borderRadius: "20px",
									background: "rgba(99, 102, 241, 0.1)",
									color: "#818cf8",
									border: "1px solid rgba(99, 102, 241, 0.2)",
									fontWeight: 500,
								}}
							>
								Modelo: {status.provider}
							</span>
						</div>
					)}
				</div>

				{/* Messages */}
				<div
					ref={messagesContainerRef}
					className="chat-messages"
					style={{ flex: 1, overflowY: "auto", padding: "30px 20px" }}
				>
					<div
						className="chat-messages-inner"
						style={{ maxWidth: "800px", margin: "0 auto" }}
					>
						{messages.length === 0 && (
							<div
								style={{
									maxWidth: "700px",
									margin: "0 auto",
									padding: "40px 20px",
								}}
							>
								<div style={{ textAlign: "center", marginBottom: "40px" }}>
									<div
										style={{
											fontSize: "64px",
											marginBottom: "16px",
											filter: "drop-shadow(0 0 20px rgba(99,102,241,0.3))",
										}}
									>
										🐙
									</div>
									<div
										style={{
											fontSize: "1.8rem",
											color: "#f4f4f5",
											fontWeight: 700,
											marginBottom: "8px",
											letterSpacing: "-0.02em",
										}}
									>
										Octopus AI
									</div>
									<div style={{ fontSize: "1.05rem", color: "#a1a1aa" }}>
										Tu sistema autónomo multi-agente está listo.
									</div>
								</div>

								<div
									style={{
										display: "grid",
										gridTemplateColumns: "1fr 1fr",
										gap: "16px",
										marginBottom: "40px",
									}}
								>
									<div
										style={{
											background: "rgba(39, 39, 42, 0.4)",
											border: "1px solid rgba(255,255,255,0.05)",
											borderRadius: "16px",
											padding: "20px",
											display: "flex",
											alignItems: "center",
											gap: "16px",
										}}
									>
										<div
											style={{
												fontSize: "24px",
												background: "rgba(99, 102, 241, 0.1)",
												color: "#818cf8",
												width: "48px",
												height: "48px",
												borderRadius: "12px",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
											}}
										>
											🤖
										</div>
										<div>
											<div
												style={{
													fontSize: "1.5rem",
													fontWeight: 700,
													color: "#f4f4f5",
												}}
											>
												{stats ? stats.agents : "..."}
											</div>
											<div style={{ fontSize: "0.85rem", color: "#a1a1aa" }}>
												Agentes activos
											</div>
										</div>
									</div>
									<div
										style={{
											background: "rgba(39, 39, 42, 0.4)",
											border: "1px solid rgba(255,255,255,0.05)",
											borderRadius: "16px",
											padding: "20px",
											display: "flex",
											alignItems: "center",
											gap: "16px",
										}}
									>
										<div
											style={{
												fontSize: "24px",
												background: "rgba(16, 185, 129, 0.1)",
												color: "#10b981",
												width: "48px",
												height: "48px",
												borderRadius: "12px",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
											}}
										>
											🔌
										</div>
										<div>
											<div
												style={{
													fontSize: "1.5rem",
													fontWeight: 700,
													color: "#f4f4f5",
												}}
											>
												{stats ? stats.tools : "..."}
											</div>
											<div style={{ fontSize: "0.85rem", color: "#a1a1aa" }}>
												Herramientas ({stats?.mcp} MCP)
											</div>
										</div>
									</div>
									<div
										style={{
											background: "rgba(39, 39, 42, 0.4)",
											border: "1px solid rgba(255,255,255,0.05)",
											borderRadius: "16px",
											padding: "20px",
											display: "flex",
											alignItems: "center",
											gap: "16px",
										}}
									>
										<div
											style={{
												fontSize: "24px",
												background: "rgba(245, 158, 11, 0.1)",
												color: "#fbbf24",
												width: "48px",
												height: "48px",
												borderRadius: "12px",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
											}}
										>
											💭
										</div>
										<div>
											<div
												style={{
													fontSize: "1.5rem",
													fontWeight: 700,
													color: "#f4f4f5",
												}}
											>
												{stats ? (stats.memories > 0 ? "Activa" : "0") : "..."}
											</div>
											<div style={{ fontSize: "0.85rem", color: "#a1a1aa" }}>
												Base de memoria
											</div>
										</div>
									</div>
									<div
										style={{
											background: "rgba(39, 39, 42, 0.4)",
											border: "1px solid rgba(255,255,255,0.05)",
											borderRadius: "16px",
											padding: "20px",
											display: "flex",
											alignItems: "center",
											gap: "16px",
										}}
									>
										<div
											style={{
												fontSize: "24px",
												background: "rgba(236, 72, 153, 0.1)",
												color: "#f472b6",
												width: "48px",
												height: "48px",
												borderRadius: "12px",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
											}}
										>
											🧠
										</div>
										<div>
											<div
												style={{
													fontSize: "1.5rem",
													fontWeight: 700,
													color: "#f4f4f5",
												}}
											>
												{status?.provider?.split("/")[1] || "..."}
											</div>
											<div style={{ fontSize: "0.85rem", color: "#a1a1aa" }}>
												Modelo de IA
											</div>
										</div>
									</div>
								</div>

								<h3
									style={{
										fontSize: "1rem",
										color: "#f4f4f5",
										marginBottom: "16px",
										textAlign: "center",
									}}
								>
									Comienza rápido
								</h3>
								<div
									style={{
										display: "grid",
										gridTemplateColumns: "1fr 1fr",
										gap: "12px",
									}}
								>
									{[
										{
											icon: "💻",
											text: "Escribe un script en Python",
											prompt: "Escribe un script en Python que...",
										},
										{
											icon: "🔍",
											text: "Busca en la web",
											prompt: "Busca en internet información reciente sobre...",
										},
										{
											icon: "📁",
											text: "Lee el archivo de config",
											prompt:
												"Lee el archivo config.json en este proyecto y explícame qué hace",
										},
										{
											icon: "📊",
											text: "Resumen de datos",
											prompt: "Haz un resumen en viñetas de lo siguiente:\n\n",
										},
									].map((suggestion) => (
										<button
											key={suggestion.text}
											type="button"
											onClick={() => {
												setInput(suggestion.prompt);
												inputRef.current?.focus();
											}}
											style={{
												padding: "16px",
												background: "rgba(24, 24, 27, 0.5)",
												border: "1px solid #3f3f46",
												borderRadius: "12px",
												color: "#d4d4d8",
												fontSize: "0.9rem",
												cursor: "pointer",
												display: "flex",
												alignItems: "center",
												gap: "12px",
												transition: "all 0.2s",
											}}
											onMouseEnter={(e) => {
												e.currentTarget.style.background = "#27272a";
												e.currentTarget.style.borderColor = "#52525b";
											}}
											onMouseLeave={(e) => {
												e.currentTarget.style.background =
													"rgba(24, 24, 27, 0.5)";
												e.currentTarget.style.borderColor = "#3f3f46";
											}}
										>
											<span style={{ fontSize: "1.4rem" }}>
												{suggestion.icon}
											</span>
											<span style={{ textAlign: "left" }}>
												{suggestion.text}
											</span>
										</button>
									))}
								</div>
							</div>
						)}
						{messages.map((msg) => (
							<div
								key={msg.id}
								style={{
									marginBottom: "32px",
									display: "flex",
									justifyContent:
										msg.role === "user" ? "flex-end" : "flex-start",
								}}
							>
								{msg.role === "assistant" && (
									<div
										style={{
											width: "36px",
											height: "36px",
											borderRadius: "10px",
											background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
											display: "flex",
											alignItems: "center",
											justifyContent: "center",
											marginRight: "16px",
											flexShrink: 0,
											fontSize: "18px",
											boxShadow: "0 2px 8px rgba(99, 102, 241, 0.25)",
										}}
									>
										🐙
									</div>
								)}
								<div
									style={{
										maxWidth: msg.role === "user" ? "80%" : "calc(100% - 52px)",
									}}
								>
									{msg.role === "user" ? (
										<div
											style={{
												padding: "14px 20px",
												borderRadius: "20px 20px 4px 20px",
												background: "#27272a",
												color: "#f4f4f5",
												fontSize: "0.95rem",
												lineHeight: "1.6",
												border: "1px solid #3f3f46",
											}}
										>
											{msg.content.includes("/api/media/file/") ? (
												<div
													className="markdown-body"
													// biome-ignore lint/security/noDangerouslySetInnerHtml: user-uploaded local media
													dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
												/>
											) : (
												msg.content
											)}
										</div>
									) : (
										<div
											style={{
												color: "#e4e4e7",
												fontSize: "0.95rem",
												lineHeight: "1.7",
											}}
										>
											{/* eslint-disable-next-line react/no-danger */}
											<div
												className="markdown-body"
												dangerouslySetInnerHTML={{
													__html: renderMarkdown(msg.content),
												}}
											/>
										</div>
									)}
									<div
										style={{
											fontSize: "0.7rem",
											color: "#71717a",
											marginTop: "6px",
											textAlign: msg.role === "user" ? "right" : "left",
											paddingLeft: msg.role === "user" ? "0" : "4px",
										}}
									>
										{formatTime(msg.timestamp)}
									</div>
								</div>
							</div>
						))}
						{(isLoading || isStreaming || agentStatus !== "idle") && (
							<AgentActivityPanel activities={agentActivity} />
						)}

						<div ref={messagesEndRef} style={{ height: "1px", width: "100%" }} />
					</div>
				</div>

				{/* Input Area */}
				<div
					className="chat-input-area"
					style={{
						padding: "0 20px 30px",
						background:
							"linear-gradient(180deg, rgba(9,9,11,0) 0%, rgba(9,9,11,1) 30%)",
					}}
				>
					<div
						className="chat-composer-shell"
						style={{
							maxWidth: "800px",
							margin: "0 auto",
							position: "relative",
						}}
					>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								background: "#18181b",
								borderRadius: "16px",
								border: "1px solid #3f3f46",
								padding: "8px 12px",
								boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
								transition: "border-color 0.2s",
							}}
						>
							{pendingAttachments.length > 0 && (
								<div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingBottom: "8px", borderBottom: "1px solid #27272a", marginBottom: "8px" }}>
									{pendingAttachments.map((attachment, idx) => (
										<div key={idx} style={{ position: "relative", width: "60px", height: "60px", borderRadius: "8px", overflow: "hidden", border: "1px solid #3f3f46" }}>
											<img src={attachment.previewUrl} alt="adjunto" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
											<button
												onClick={() => removePendingAttachment(idx)}
												style={{
													position: "absolute",
													top: "2px",
													right: "2px",
													background: "rgba(0,0,0,0.6)",
													color: "white",
													border: "none",
													borderRadius: "50%",
													width: "20px",
													height: "20px",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													cursor: "pointer",
													fontSize: "12px"
												}}
											>
												✕
											</button>
										</div>
									))}
								</div>
							)}
							<div style={{ display: "flex", alignItems: "flex-end" }}>
								<input
								id="chat-image-upload"
								name="imageUpload"
								type="file"
								ref={fileInputRef}
								style={{ display: "none" }}
								onChange={handleFileUpload}
								accept="image/*"
							/>
							<button
								type="button"
								aria-label="Adjuntar imagen"
								onClick={() => fileInputRef.current?.click()}
								disabled={isUploadingImage}
								title="Adjuntar imagen"
								style={{
									width: "36px",
									height: "36px",
									borderRadius: "10px",
									border: "none",
									background: "transparent",
									color: isUploadingImage ? "#6366f1" : "#a1a1aa",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									cursor: isUploadingImage ? "wait" : "pointer",
									transition: "all 0.2s",
									marginBottom: "4px",
									marginRight: "4px",
									flexShrink: 0,
								}}
								onMouseEnter={(e) => {
									if (!isUploadingImage) e.currentTarget.style.color = "#f4f4f5";
								}}
								onMouseLeave={(e) => {
									if (!isUploadingImage) e.currentTarget.style.color = "#a1a1aa";
								}}
							>
								{isUploadingImage ? (
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 2s linear infinite" }}>
										<circle cx="12" cy="12" r="9" strokeDasharray="30" />
									</svg>
								) : (
									<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
									</svg>
								)}
							</button>
							<textarea
								id="chat-message-input"
								name="message"
								ref={inputRef}
								value={input}
								onChange={handleInput}
								onKeyDown={handleKeyDown}
								placeholder={
									isConnected
										? "Escribe un mensaje..."
										: "Conectando al servidor..."
								}
								disabled={!isConnected}
								rows={1}
								style={{
									flex: 1,
									padding: "10px 8px",
									background: "transparent",
									border: "none",
									color: "#f4f4f5",
									fontSize: "0.95rem",
									outline: "none",
									resize: "none",
									maxHeight: "200px",
									lineHeight: "1.5",
									fontFamily: "inherit",
								}}
							/>
							<button
								type="button"
								onClick={handleSend}
								disabled={(!input.trim() && pendingAttachments.length === 0) || !isConnected || isLoading}
								style={{
									width: "36px",
									height: "36px",
									borderRadius: "10px",
									border: "none",
									background:
										(!input.trim() && pendingAttachments.length === 0) || !isConnected || isLoading
											? "#27272a"
											: "#6366f1",
									color:
										(!input.trim() && pendingAttachments.length === 0) || !isConnected || isLoading
											? "#52525b"
											: "#fff",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									cursor:
										(!input.trim() && pendingAttachments.length === 0) || !isConnected || isLoading
											? "not-allowed"
											: "pointer",
									transition: "all 0.2s",
									marginBottom: "4px",
									flexShrink: 0,
								}}
							>
								<svg
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<title>Send</title>
									<line x1="22" y1="2" x2="11" y2="13" />
									<polygon points="22 2 15 22 11 13 2 9 22 2" />
								</svg>
							</button>
							</div>
						</div>
						<div
							style={{
								textAlign: "center",
								marginTop: "10px",
								fontSize: "0.7rem",
								color: "#71717a",
							}}
						>
							Octopus AI puede cometer errores. Considera verificar la
							información importante.
						</div>
					</div>
				</div>
			</div>

			<style>{`
				@keyframes spin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
				@keyframes pulse {
					0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
					40% { opacity: 1; transform: scale(1); }
				}
				@keyframes fadeInFast {
					from { opacity: 0; transform: translateY(8px); }
					to { opacity: 1; transform: translateY(0); }
				}
				@keyframes toolFloat {
					0%, 100% { transform: translateY(0) scale(1); }
					50% { transform: translateY(-2px) scale(1.04); }
				}
				.agent-activity-row { display: flex; align-items: flex-start; margin-bottom: 32px; animation: fadeInFast 0.22s ease-out; }
				.agent-activity-avatar { width: 36px; height: 36px; border-radius: 12px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; display: flex; align-items: center; justify-content: center; margin-right: 16px; flex-shrink: 0; box-shadow: 0 8px 24px rgba(99, 102, 241, 0.28); animation: toolFloat 2.2s infinite ease-in-out; }
				.agent-activity-card { min-width: 260px; max-width: min(620px, calc(100vw - 120px)); padding: 12px 14px; border-radius: 16px; background: linear-gradient(135deg, rgba(24,24,27,0.92), rgba(9,9,11,0.84)); border: 1px solid rgba(63,63,70,0.75); box-shadow: 0 12px 34px rgba(0,0,0,0.28); backdrop-filter: blur(10px); }
				.agent-activity-current { display: flex; align-items: center; gap: 12px; }
				.agent-activity-orb { width: 34px; height: 34px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
				.agent-activity-title { font-size: 0.88rem; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.agent-activity-detail { margin-top: 2px; font-size: 0.76rem; color: #a1a1aa; line-height: 1.35; }
				.agent-activity-dots { margin-left: auto; display: flex; gap: 4px; padding-left: 10px; }
				.agent-activity-dots span { width: 5px; height: 5px; border-radius: 999px; opacity: 0.35; animation: pulse 1s infinite ease-in-out; }
				.agent-activity-steps { margin-top: 12px; padding-top: 11px; border-top: 1px solid rgba(63,63,70,0.45); display: grid; gap: 8px; }
				.agent-activity-step { display: flex; align-items: center; gap: 9px; color: #d4d4d8; font-size: 0.76rem; min-width: 0; position: relative; }
				.agent-activity-step-line { width: 7px; height: 1px; border-radius: 999px; background: #3f3f46; flex-shrink: 0; }
				.agent-activity-step-icon { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; opacity: 0.9; }
				.agent-activity-step-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				@media (max-width: 640px) {
					.agent-activity-card { min-width: 0; max-width: calc(100vw - 92px); }
					.agent-activity-detail { font-size: 0.72rem; }
					.agent-activity-steps { display: none; }
				}
				.markdown-body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
				.markdown-body p { margin: 0 0 12px 0; }
				.markdown-body p:last-child { margin-bottom: 0; }
				.markdown-body code { background: #18181b; padding: 3px 6px; border-radius: 6px; border: 1px solid #27272a; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.85em; color: #e4e4e7; }
				.markdown-body pre { background: #18181b; padding: 16px; border-radius: 12px; border: 1px solid #27272a; overflow-x: auto; margin: 16px 0; }
				.markdown-body pre code { background: none; padding: 0; border: none; color: #e4e4e7; }
				.markdown-body ul, .markdown-body ol { margin: 8px 0 16px; padding-left: 24px; }
				.markdown-body li { margin-bottom: 4px; }
				.markdown-body blockquote { border-left: 4px solid #6366f1; margin: 16px 0; padding: 8px 16px; background: rgba(99, 102, 241, 0.05); border-radius: 0 8px 8px 0; color: #a1a1aa; }
				.markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 24px 0 12px; color: #f4f4f5; font-weight: 600; letter-spacing: -0.02em; }
				.markdown-body a { color: #818cf8; text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 0.2s; }
				.markdown-body a:hover { border-bottom-color: #818cf8; }
				.markdown-body table { border-collapse: collapse; margin: 16px 0; width: 100%; border-radius: 8px; overflow: hidden; border: 1px solid #27272a; }
				.markdown-body th, .markdown-body td { border-bottom: 1px solid #27272a; padding: 10px 14px; text-align: left; }
				.markdown-body th { background: #18181b; font-weight: 500; color: #e4e4e7; }
				.media-embed { margin: 12px 0; }
				.media-image img { display: block; max-width: 100%; border-radius: 12px; border: 1px solid #27272a; transition: transform 0.2s, box-shadow 0.2s; cursor: pointer; }
				.media-image img:hover { transform: scale(1.01); box-shadow: 0 4px 24px rgba(99, 102, 241, 0.2); }
				.media-audio { padding: 8px 0; }
				.media-audio audio { width: 100%; max-width: 500px; border-radius: 8px; }
				.media-video video { display: block; max-width: 100%; border-radius: 12px; border: 1px solid #27272a; }
				.media-preview-overlay { position: fixed; inset: 0; z-index: 1050; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); backdrop-filter: blur(4px); cursor: pointer; }
				.media-preview-overlay img { max-width: 92vw; max-height: 90vh; border-radius: 12px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }
				::-webkit-scrollbar { width: 8px; height: 8px; }
				::-webkit-scrollbar-track { background: transparent; }
				::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; border: 2px solid #09090b; }
				::-webkit-scrollbar-thumb:hover { background: #52525b; }
			`}</style>

			{/* Media preview overlay */}
			{mediaPreviewSrc && (
				<div
					className="media-preview-overlay"
					onClick={() => setMediaPreviewSrc(null)}
				>
					<img
						src={mediaPreviewSrc}
						alt="Preview"
						onClick={(e) => e.stopPropagation()}
					/>
				</div>
			)}
		</div>
	);
};
