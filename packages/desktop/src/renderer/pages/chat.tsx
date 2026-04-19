import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface Message {
	id: number;
	text: string;
	sender: "user" | "ai";
	timestamp: Date;
	isStreaming?: boolean;
	toolUsed?: string;
}

const darkStyles = {
	container: {
		display: "flex" as const,
		flexDirection: "column" as const,
		height: "100%",
		backgroundColor: "#0f1117",
		color: "#e4e4e7",
		fontFamily: "Inter, system-ui, -apple-system, sans-serif",
	},
	header: {
		padding: "16px 20px",
		borderBottom: "1px solid #27272a",
		display: "flex" as const,
		alignItems: "center" as const,
		justifyContent: "space-between" as const,
	},
	messagesArea: {
		flex: 1,
		overflowY: "auto" as const,
		padding: "20px",
		display: "flex" as const,
		flexDirection: "column" as const,
		gap: "12px",
	},
	msgRow: (sender: string) =>
		({
			display: "flex",
			justifyContent: sender === "user" ? "flex-end" : "flex-start",
		}) as const,
	bubble: (sender: string) => ({
		maxWidth: "75%",
		padding: "10px 14px",
		borderRadius:
			sender === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
		backgroundColor: sender === "user" ? "#3b82f6" : "#1e1e2e",
		color: sender === "user" ? "#fff" : "#e4e4e7",
		fontSize: "14px",
		lineHeight: "1.6",
		whiteSpace: "pre-wrap" as const,
		wordBreak: "break-word" as const,
		border: sender === "ai" ? "1px solid #27272a" : "none",
	}),
	inputArea: {
		padding: "16px 20px",
		borderTop: "1px solid #27272a",
		display: "flex" as const,
		gap: "10px",
		backgroundColor: "#0f1117",
	},
	input: {
		flex: 1,
		padding: "10px 16px",
		borderRadius: "12px",
		border: "1px solid #27272a",
		backgroundColor: "#18181b",
		color: "#e4e4e7",
		fontSize: "14px",
		outline: "none",
	},
	button: (disabled: boolean) => ({
		padding: "10px 20px",
		borderRadius: "12px",
		backgroundColor: disabled ? "#3f3f46" : "#3b82f6",
		color: "#fff",
		border: "none",
		cursor: disabled ? "not-allowed" : "pointer",
		fontSize: "14px",
		fontWeight: 600,
	}),
	statusDot: (connected: boolean) => ({
		width: "8px",
		height: "8px",
		borderRadius: "50%",
		backgroundColor: connected ? "#22c55e" : "#ef4444",
		display: "inline-block",
	}),
	typing: {
		display: "flex",
		gap: "4px",
		padding: "4px 0",
	},
	dot: {
		width: "6px",
		height: "6px",
		borderRadius: "50%",
		backgroundColor: "#71717a",
		animation: "blink 1.4s infinite both",
	},
};

export const Chat: React.FC = () => {
	const [messages, setMessages] = useState<Message[]>([
		{
			id: 0,
			text: "Hello! I am Octopus AI. I can execute code, create tools, help with programming, and much more. How can I help you today?",
			sender: "ai",
			timestamp: new Date(),
		},
	]);
	const [input, setInput] = useState("");
	const [connected, setConnected] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [streamEnabled, setStreamEnabled] = useState(true);
	const wsRef = useRef<WebSocket | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint: dependency is intentional to scroll on new messages
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	useEffect(() => {
		const connectWs = () => {
			const ws = new WebSocket("ws://127.0.0.1:18789");
			wsRef.current = ws;

			ws.onopen = () => setConnected(true);
			ws.onclose = () => {
				setConnected(false);
				setTimeout(connectWs, 3000);
			};
			ws.onerror = () => setConnected(false);

			ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data);
					if (msg.channel === "chat" || msg.channel === "agent") {
						if (msg.type === "stream" && msg.payload?.content) {
							setMessages((prev) => {
								const last = prev[prev.length - 1];
								if (last?.isStreaming) {
									return [
										...prev.slice(0, -1),
										{ ...last, text: last.text + msg.payload.content },
									];
								}
								return [
									...prev,
									{
										id: Date.now(),
										text: msg.payload.content,
										sender: "ai" as const,
										timestamp: new Date(),
										isStreaming: true,
									},
								];
							});
						} else if (msg.type === "stream_end") {
							setMessages((prev) => {
								const last = prev[prev.length - 1];
								if (last?.isStreaming) {
									return [
										...prev.slice(0, -1),
										{ ...last, isStreaming: false },
									];
								}
								return prev;
							});
							setStreaming(false);
						} else if (msg.type === "response" && msg.payload?.content) {
							setMessages((prev) => [
								...prev,
								{
									id: Date.now(),
									text: msg.payload.content,
									sender: "ai",
									timestamp: new Date(),
								},
							]);
							setStreaming(false);
						}
					}
				} catch {
					/* ignore non-JSON */
				}
			};
		};

		connectWs();
		return () => {
			wsRef.current?.close();
		};
	}, []);

	const handleSend = useCallback(() => {
		if (!input.trim() || streaming) return;

		const userMsg: Message = {
			id: Date.now(),
			text: input,
			sender: "user",
			timestamp: new Date(),
		};
		setMessages((prev) => [...prev, userMsg]);
		setInput("");
		setStreaming(true);

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(
				JSON.stringify({
					id: `msg_${Date.now()}`,
					type: "request",
					channel: "chat",
					payload: { message: input, stream: streamEnabled },
					timestamp: Date.now(),
				}),
			);
		} else {
			fetch("http://127.0.0.1:18789/api/status")
				.then(() => {
					fetch("http://127.0.0.1:18789/api/code/execute", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ code: input, language: "text" }),
					})
						.then(() => {})
						.catch(() => {});
				})
				.catch(() => {});

			setTimeout(() => {
				setMessages((prev) => [
					...prev,
					{
						id: Date.now() + 1,
						text: "I'm having trouble connecting to the server. Please make sure Octopus AI server is running (`node packages/cli/dist/index.js start`).",
						sender: "ai",
						timestamp: new Date(),
					},
				]);
				setStreaming(false);
			}, 1000);
		}
	}, [input, streaming]);

	return (
		<div style={darkStyles.container}>
			<style>{`
				@keyframes blink { 0%, 80%, 100% { opacity: 0; } 40% { opacity: 1; } }
				.typing-dot:nth-child(2) { animation-delay: 0.2s; }
				.typing-dot:nth-child(3) { animation-delay: 0.4s; }
			`}</style>
			<div style={darkStyles.header}>
				<h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Chat</h2>
				<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
					<button
						type="button"
						onClick={() => setStreamEnabled((v) => !v)}
						style={{
							padding: "4px 10px",
							borderRadius: "6px",
							border: `1px solid ${streamEnabled ? "rgba(99, 102, 241, 0.4)" : "#3f3f46"}`,
							background: streamEnabled
								? "rgba(99, 102, 241, 0.1)"
								: "transparent",
							color: streamEnabled ? "#818cf8" : "#71717a",
							fontSize: "11px",
							cursor: "pointer",
							fontWeight: 500,
							fontFamily: "inherit",
						}}
					>
						{streamEnabled ? "⚡ Stream" : "📦 Completo"}
					</button>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							fontSize: "12px",
							color: "#71717a",
						}}
					>
						<span style={darkStyles.statusDot(connected)} />
						{connected ? "Connected" : "Disconnected"}
					</div>
				</div>
			</div>

			<div style={darkStyles.messagesArea}>
				{messages.map((msg) => (
					<div key={msg.id} style={darkStyles.msgRow(msg.sender)}>
						<div style={darkStyles.bubble(msg.sender)}>
							{msg.text}
							{msg.isStreaming && (
								<div style={darkStyles.typing}>
									<span className="typing-dot" style={darkStyles.dot} />
									<span className="typing-dot" style={darkStyles.dot} />
									<span className="typing-dot" style={darkStyles.dot} />
								</div>
							)}
						</div>
					</div>
				))}
				<div ref={messagesEndRef} />
			</div>

			<div style={darkStyles.inputArea}>
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleSend()}
					placeholder={
						connected ? "Type a message..." : "Server not connected..."
					}
					disabled={streaming}
					style={darkStyles.input}
				/>
				<button
					type="button"
					onClick={handleSend}
					disabled={streaming || !input.trim()}
					style={darkStyles.button(streaming || !input.trim())}
				>
					Send
				</button>
			</div>
		</div>
	);
};
