import DOMPurify from "dompurify";
import { marked } from "marked";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../hooks/useApi.js";

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
}

interface WsMessage {
	id: string;
	type: string;
	channel: string;
	payload: WsPayload;
	timestamp: number;
}

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

const MEDIA_BASE = `http://${window.location.hostname}:18789`;

function isMediaUrl(href: string): boolean {
	return (
		href.startsWith("/api/media/file/") || href.includes("/api/media/file/")
	);
}

function getMediaType(url: string): "image" | "audio" | "video" | null {
	const path = url.split("?")[0] ?? "";
	if (
		/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\/|$)/i.test(path) ||
		path.includes("/api/media/file/")
	) {
		const id = path.split("/api/media/file/")[1]?.split("/")[0] ?? "";
		return "image";
	}
	if (/\.(mp3|wav|ogg|m4a|weba|flac)(\/|$)/i.test(path)) return "audio";
	if (/\.(mp4|webm|ogv|avi|mov)(\/|$)/i.test(path)) return "video";
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
	const [agentStatus, setAgentStatus] = useState<
		"idle" | "thinking" | "tool" | "code" | "responding"
	>("idle");
	const [agentToolName, setAgentToolName] = useState<string | null>(null);
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
					setAgentToolName(null);
					pendingIdRef.current = "";
					loadConversations();
					inputRef.current?.focus();
				} else if (msg.type === "event") {
					const agentStatus = msg.payload?.agentStatus;
					if (
						agentStatus &&
						["thinking", "tool", "code", "responding"].includes(agentStatus)
					) {
						setAgentStatus(
							agentStatus as "thinking" | "tool" | "code" | "responding",
						);
						setAgentToolName(msg.payload?.toolName || null);
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
					pendingIdRef.current = "";
					loadConversations();
				}
			} catch (err) {
				console.error("Failed to parse WS message:", err);
			}
		};

		wsRef.current = ws;
	}, [loadConversations]);

	useEffect(() => {
		connect();
		return () => {
			wsRef.current?.close();
		};
	}, [connect]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSend = () => {
		const text = input.trim();
		if (!text || isLoading) return;

		const userMsg: Message = {
			id: nanoid(),
			role: "user",
			content: text,
			timestamp: Date.now(),
		};
		setMessages((prev) => [...prev, userMsg]);
		setInput("");
		setIsLoading(true);

		if (inputRef.current) {
			inputRef.current.style.height = "auto";
			inputRef.current.focus();
		}

		const requestId = nanoid();
		pendingIdRef.current = requestId;

		const payload: Record<string, unknown> = {
			message: text,
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

			if (isFirstMsg && text.trim().length > 0) {
				const targetConvId = convIdForTitle ?? activeConversationId;
				if (targetConvId) {
					const title =
						text.length > 50 ? `${text.substring(0, 50).trimEnd()}...` : text;
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
											{msg.content}
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
												{/* Agent Status Indicators - Positioned at the bottom of the chat flow */}
						{(isLoading || (isStreaming && agentStatus !== "idle")) && (
							<div
								style={{
									display: "flex",
									alignItems: "flex-start",
									marginBottom: "32px",
								}}
							>
								{isStreaming && agentStatus !== "idle" ? (
									<div
										style={{
											padding: "10px 16px",
											background: "rgba(39,39,42,0.6)",
											borderRadius: "12px",
											border: "1px solid rgba(63,63,70,0.5)",
											display: "flex",
											alignItems: "center",
											gap: "12px",
											boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
											animation: "fadeInFast 0.3s ease-out",
										}}
									>
										{agentStatus === "thinking" ? (
											<>
												<svg
													width="18"
													height="18"
													viewBox="0 0 24 24"
													fill="none"
													style={{ animation: "spin 2s linear infinite" }}
												>
													<circle cx="12" cy="12" r="9" stroke="#27272a" strokeWidth="2" />
													<path d="M12 3a9 9 0 019 9" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" />
													<circle cx="12" cy="6" r="1.5" fill="#818cf8" style={{ animation: "pulse 1.5s infinite ease-in-out" }} />
													<circle cx="8" cy="10" r="1" fill="#818cf8" style={{ animation: "pulse 1.5s infinite ease-in-out 0.3s" }} />
													<circle cx="16" cy="10" r="1" fill="#818cf8" style={{ animation: "pulse 1.5s infinite ease-in-out 0.6s" }} />
												</svg>
												<span style={{ fontSize: "0.85rem", color: "#818cf8", fontWeight: 600 }}>Pensando...</span>
											</>
										) : agentStatus === "tool" ? (
											<>
												{agentToolName?.includes("search") ? (
													<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" strokeWidth="2" style={{ animation: "pulse 2s infinite ease-in-out" }}>
														<circle cx="11" cy="11" r="8" />
														<line x1="21" y1="21" x2="16.65" y2="16.65" />
													</svg>
												) : agentToolName?.includes("file") || agentToolName === "manage_workspace" ? (
													<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2" style={{ animation: "pulse 2s infinite ease-in-out" }}>
														<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
														<polyline points="14 2 14 8 20 8" />
														<line x1="16" y1="13" x2="8" y2="13" />
														<line x1="16" y1="17" x2="8" y2="17" />
														<polyline points="10 9 9 9 8 9" />
													</svg>
												) : agentToolName?.includes("image") || agentToolName?.includes("nano-banana") ? (
													<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="2" style={{ animation: "pulse 2s infinite ease-in-out" }}>
														<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
														<circle cx="8.5" cy="8.5" r="1.5" />
														<polyline points="21 15 16 10 5 21" />
													</svg>
												) : (
													<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" style={{ animation: "spin 1.5s linear infinite" }}>
														<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" style={{ animation: "pulse 2s infinite ease-in-out", transformOrigin: "center" }} />
													</svg>
												)}
												<span style={{ fontSize: "0.85rem", color: agentToolName?.includes("search") ? "#0ea5e9" : agentToolName?.includes("file") || agentToolName === "manage_workspace" ? "#8b5cf6" : agentToolName?.includes("image") || agentToolName?.includes("nano-banana") ? "#ec4899" : "#f59e0b", fontWeight: 600 }}>
													{agentToolName?.includes("search") ? "Buscando en configuración/archivos..." : agentToolName?.includes("file") || agentToolName === "manage_workspace" ? "Creando/editando archivo..." : agentToolName?.includes("image") || agentToolName?.includes("nano-banana") ? "Procesando imagen (Nano Banana)..." : "Ejecutando herramienta..."}
												</span>
												<div style={{ display: "flex", gap: "3px", marginLeft: "4px" }}>
													{[0, 1, 2].map((i) => (
														<div key={i} style={{ width: "5px", height: "5px", borderRadius: "50%", background: agentToolName?.includes("search") ? "#0ea5e9" : agentToolName?.includes("file") || agentToolName === "manage_workspace" ? "#8b5cf6" : agentToolName?.includes("image") || agentToolName?.includes("nano-banana") ? "#ec4899" : "#f59e0b", opacity: 0.5, animation: "pulse 1s infinite ease-in-out", animationDelay: `${i * 0.2}s` }} />
													))}
												</div>
											</>
										) : agentStatus === "code" ? (
											<>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "pulse 2s infinite ease-in-out" }}>
													<polyline points="16 18 22 12 16 6" style={{ animation: "pulse 1.5s infinite ease-in-out" }} />
													<polyline points="8 6 2 12 8 18" style={{ animation: "pulse 1.5s infinite ease-in-out 0.3s" }} />
												</svg>
												<span style={{ fontSize: "0.85rem", color: "#10b981", fontWeight: 600 }}>Ejecutando script local...</span>
											</>
										) : (
											<>
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "pulse 2s infinite ease-in-out" }}>
													<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
												</svg>
												<span style={{ fontSize: "0.85rem", color: "#60a5fa", fontWeight: 600 }}>Escribiendo respuesta...</span>
											</>
										)}
									</div>
								) : (
									/* Default Loader (bouncing balls) - Only show if not specifically detailing an agentStatus */
									!isStreaming && (
										<div style={{ display: "flex", alignItems: "flex-start", width: "100%" }}>
											<div style={{ width: "36px", height: "36px", borderRadius: "10px", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "16px", flexShrink: 0, boxShadow: "0 2px 8px rgba(99, 102, 241, 0.25)" }}>
												<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5">
													<path d="M12 2C8 2 5 5 5 8c0 2 1 3.5 2 4.5V14a2 2 0 002 2h6a2 2 0 002-2v-1.5c1-1 2-2.5 2-4.5 0-3-3-6-7-6z" style={{ animation: "pulse 2s infinite ease-in-out", transformOrigin: "center" }} />
													<path d="M9 18h6M10 20h4" strokeLinecap="round" style={{ animation: "pulse 2s infinite ease-in-out 0.3s", opacity: 0.7 }} />
													<circle cx="9" cy="8" r="1" fill="#fff" style={{ animation: "pulse 1.5s infinite ease-in-out 0.2s" }} />
													<circle cx="15" cy="8" r="1" fill="#fff" style={{ animation: "pulse 1.5s infinite ease-in-out 0.5s" }} />
													<circle cx="12" cy="5" r="0.8" fill="#fff" style={{ animation: "pulse 1.5s infinite ease-in-out 0.8s" }} />
												</svg>
											</div>
											<div
												style={{
													padding: "10px 0",
													display: "flex",
													flexDirection: "column",
													gap: "10px",
												}}
											>
												<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
													<svg width="20" height="20" viewBox="0 0 24 24" style={{ animation: "spin 2s linear infinite" }}>
														<circle cx="12" cy="12" r="9" fill="none" stroke="#27272a" strokeWidth="2" />
														<path d="M12 3a9 9 0 019 9" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" />
													</svg>
													<span style={{ fontSize: "0.9rem", fontWeight: 600, color: "#a1a1aa" }}>Pensando...</span>
												</div>
												<div style={{ display: "flex", gap: "3px" }}>
													{[0, 1, 2, 3, 4].map((i) => (
														<div key={i} style={{ width: "28px", height: "3px", borderRadius: "2px", background: "#6366f1", opacity: 0.3, animation: "pulse 1.4s infinite ease-in-out", animationDelay: `${i * 0.15}s` }} />
													))}
												</div>
											</div>
										</div>
									)
								)}
							</div>
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
								background: "#18181b",
								borderRadius: "16px",
								border: "1px solid #3f3f46",
								padding: "8px 12px",
								alignItems: "flex-end",
								boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
								transition: "border-color 0.2s",
							}}
						>
							<textarea
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
								disabled={!input.trim() || !isConnected || isLoading}
								style={{
									width: "36px",
									height: "36px",
									borderRadius: "10px",
									border: "none",
									background:
										!input.trim() || !isConnected || isLoading
											? "#27272a"
											: "#6366f1",
									color:
										!input.trim() || !isConnected || isLoading
											? "#52525b"
											: "#fff",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									cursor:
										!input.trim() || !isConnected || isLoading
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
				@keyframes pulse {
					0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
					40% { opacity: 1; transform: scale(1); }
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
