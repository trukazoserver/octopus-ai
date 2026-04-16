import DOMPurify from "dompurify";
import { marked } from "marked";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../hooks/useApi.js";

const WS_URL = `ws://${window.location.hostname}:18789`;

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

interface WsMessage {
	id: string;
	type: string;
	channel: string;
	payload: any;
	timestamp: number;
}

function nanoid(size = 16): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
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

function renderMarkdown(text: string): string {
	try {
		const html = marked.parse(text, {
			async: false,
			breaks: true,
			gfm: true,
		}) as string;
		return DOMPurify.sanitize(html);
	} catch {
		return DOMPurify.sanitize(text);
	}
}

export const ChatPage: React.FC = () => {
	const [messages, setMessages] = useState<Message[]>([
		{
			id: "0",
			role: "assistant",
			content: "¡Hola! Soy **Octopus AI**. ¿En qué puedo ayudarte hoy?",
			timestamp: Date.now(),
		},
	]);
	const [input, setInput] = useState("");
	const [isConnected, setIsConnected] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [status, setStatus] = useState<StatusData | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const pendingIdRef = useRef<string>("");

	useEffect(() => {
		apiGet<StatusData>("/api/status")
			.then(setStatus)
			.catch(() => {});
	}, []);

	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [messages, scrollToBottom]);

	const connect = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) return;

		const ws = new WebSocket(WS_URL);

		ws.onopen = () => {
			setIsConnected(true);
			console.log("WebSocket connected");
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

				if (msg.type === "response") {
					const responseText =
						msg.payload?.response ||
						msg.payload?.text ||
						JSON.stringify(msg.payload);
					const assistantContent =
						typeof responseText === "string"
							? responseText
							: JSON.stringify(responseText);

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
				} else if (msg.type === "stream") {
					const chunk = msg.payload?.chunk || msg.payload?.text || "";
					const streamId = `stream-${msg.id}`;
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
				} else if (msg.type === "stream_end") {
					setIsLoading(false);
					pendingIdRef.current = "";
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
					pendingIdRef.current = "";
				}
			} catch (err) {
				console.error("Failed to parse WS message:", err);
			}
		};

		wsRef.current = ws;
	}, []);

	useEffect(() => {
		connect();
		return () => {
			wsRef.current?.close();
		};
	}, [connect]);

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

		const wsMsg: WsMessage = {
			id: requestId,
			type: "request",
			channel: "chat",
			payload: { message: text },
			timestamp: Date.now(),
		};

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(wsMsg));
		} else {
			setMessages((prev) => [
				...prev,
				{
					id: nanoid(),
					role: "assistant",
					content: "⚠️ No hay conexión con el servidor. Verifica que el backend esté corriendo.",
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
		<div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#09090b" }}>
			{/* Connection Bar */}
			<div style={{ padding: "10px 24px", background: "#09090b", borderBottom: "1px solid #27272a", display: "flex", alignItems: "center", gap: "10px" }}>
				<div style={{ width: "8px", height: "8px", borderRadius: "50%", background: isConnected ? "#10b981" : "#ef4444", flexShrink: 0, boxShadow: isConnected ? "0 0 8px rgba(16, 185, 129, 0.5)" : "0 0 8px rgba(239, 68, 68, 0.5)" }} />
				<span style={{ color: "#a1a1aa", fontSize: "0.8rem", fontWeight: 500 }}>
					{isConnected ? "Conectado" : "Desconectado"} — ws://{window.location.hostname}:18789
				</span>
				<div style={{ flex: 1 }} />
				{status?.provider && (
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						{status.thinking && status.thinking !== 'none' && (
							<span style={{ fontSize: "0.75rem", padding: "4px 10px", borderRadius: "20px", background: "rgba(16, 185, 129, 0.1)", color: "#10b981", border: "1px solid rgba(16, 185, 129, 0.2)", fontWeight: 500 }}>
								Razonamiento: {status.thinking}
							</span>
						)}
						<span style={{ fontSize: "0.75rem", padding: "4px 10px", borderRadius: "20px", background: "rgba(99, 102, 241, 0.1)", color: "#818cf8", border: "1px solid rgba(99, 102, 241, 0.2)", fontWeight: 500 }}>
							Modelo: {status.provider}
						</span>
					</div>
				)}
			</div>

			{/* Messages */}
			<div style={{ flex: 1, overflowY: "auto", padding: "30px 20px" }}>
				<div style={{ maxWidth: "800px", margin: "0 auto" }}>
					{messages.map((msg) => (
						<div key={msg.id} style={{ marginBottom: "32px", display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
							{msg.role === "assistant" && (
								<div style={{ width: "36px", height: "36px", borderRadius: "10px", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "16px", flexShrink: 0, fontSize: "18px", boxShadow: "0 2px 8px rgba(99, 102, 241, 0.25)" }}>
									🐙
								</div>
							)}
							<div style={{ maxWidth: msg.role === "user" ? "80%" : "calc(100% - 52px)" }}>
								{msg.role === "user" ? (
									<div style={{ padding: "14px 20px", borderRadius: "20px 20px 4px 20px", background: "#27272a", color: "#f4f4f5", fontSize: "0.95rem", lineHeight: "1.6", border: "1px solid #3f3f46" }}>
										{msg.content}
									</div>
								) : (
									<div style={{ color: "#e4e4e7", fontSize: "0.95rem", lineHeight: "1.7" }}>
										<div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
									</div>
								)}
								<div style={{ fontSize: "0.7rem", color: "#71717a", marginTop: "6px", textAlign: msg.role === "user" ? "right" : "left", paddingLeft: msg.role === "user" ? "0" : "4px" }}>
									{formatTime(msg.timestamp)}
								</div>
							</div>
						</div>
					))}
					{isLoading && (
						<div style={{ display: "flex", alignItems: "flex-start", marginBottom: "32px" }}>
							<div style={{ width: "36px", height: "36px", borderRadius: "10px", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "16px", flexShrink: 0, fontSize: "18px", boxShadow: "0 2px 8px rgba(99, 102, 241, 0.25)" }}>
								🐙
							</div>
							<div style={{ display: "flex", gap: "6px", padding: "14px 0", height: "24px", alignItems: "center" }}>
								<span className="dot-animation" style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#6366f1", animation: "pulse 1.4s infinite ease-in-out" }} />
								<span className="dot-animation" style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#6366f1", animation: "pulse 1.4s infinite ease-in-out 0.2s" }} />
								<span className="dot-animation" style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#6366f1", animation: "pulse 1.4s infinite ease-in-out 0.4s" }} />
							</div>
						</div>
					)}
					<div ref={messagesEndRef} style={{ height: "40px" }} />
				</div>
			</div>

			{/* Input Area */}
			<div style={{ padding: "0 20px 30px", background: "linear-gradient(180deg, rgba(9,9,11,0) 0%, rgba(9,9,11,1) 30%)" }}>
				<div style={{ maxWidth: "800px", margin: "0 auto", position: "relative" }}>
					<div style={{ display: "flex", background: "#18181b", borderRadius: "16px", border: "1px solid #3f3f46", padding: "8px 12px", alignItems: "flex-end", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)", transition: "border-color 0.2s" }}>
						<textarea
							ref={inputRef}
							value={input}
							onChange={handleInput}
							onKeyDown={handleKeyDown}
							placeholder={isConnected ? "Escribe un mensaje..." : "Conectando al servidor..."}
							disabled={!isConnected || isLoading}
							rows={1}
							style={{ flex: 1, padding: "10px 8px", background: "transparent", border: "none", color: "#f4f4f5", fontSize: "0.95rem", outline: "none", resize: "none", maxHeight: "200px", lineHeight: "1.5", fontFamily: "inherit" }}
						/>
						<button
							onClick={handleSend}
							disabled={!input.trim() || !isConnected || isLoading}
							style={{ width: "36px", height: "36px", borderRadius: "10px", border: "none", background: !input.trim() || !isConnected || isLoading ? "#27272a" : "#6366f1", color: !input.trim() || !isConnected || isLoading ? "#52525b" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: !input.trim() || !isConnected || isLoading ? "not-allowed" : "pointer", transition: "all 0.2s", marginBottom: "4px", flexShrink: 0 }}
						>
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<line x1="22" y1="2" x2="11" y2="13"></line>
								<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
							</svg>
						</button>
					</div>
					<div style={{ textAlign: "center", marginTop: "10px", fontSize: "0.7rem", color: "#71717a" }}>
						Octopus AI puede cometer errores. Considera verificar la información importante.
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
				::-webkit-scrollbar { width: 8px; height: 8px; }
				::-webkit-scrollbar-track { background: transparent; }
				::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; border: 2px solid #09090b; }
				::-webkit-scrollbar-thumb:hover { background: #52525b; }
			`}</style>
		</div>
	);
};