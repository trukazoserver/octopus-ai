import {
	AgentRuntime,
	type Skill,
	type ToolDefinition,
	TransportClient,
	type UsageStats,
	getProviderRegistry,
} from "@octopus-ai/core";
import type { bootstrap } from "../bootstrap.js";

const STATUS_RE =
	/^\0STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\0$/;

const STREAM_CHECKPOINT_INTERVAL_MS = getPositiveIntEnv(
	"OCTOPUS_STREAM_CHECKPOINT_INTERVAL_MS",
	5000,
);
const CONVERSATION_HISTORY_LIMIT = getPositiveIntEnv(
	"OCTOPUS_CONVERSATION_HISTORY_LIMIT",
	80,
);

function getPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type OctopusSystem = Awaited<ReturnType<typeof bootstrap>>;

export type ConsoleStatus = {
	status?: string;
	provider?: string;
	providerDisplayName?: string;
	model?: string;
	fallback?: string;
	fallbackProvider?: string;
	fallbackModel?: string;
	thinking?: string;
	maxTokens?: number;
	availableProviders?: string[];
	usage?: UsageStats;
	memoryEnabled?: boolean;
	skillsEnabled?: boolean;
	server?: { host?: string; port?: number; transport?: string };
	uptime?: number;
	channels?: string[];
};

export type StreamEvent =
	| { type: "status"; status: string; toolName?: string; detail?: string }
	| { type: "content"; content: string }
	| { type: "done" };

export interface ConsoleSession {
	kind: "local" | "remote";
	webUrl: string;
	model: string;
	conversationId?: string;
	getStatus(): Promise<ConsoleStatus>;
	getTools(): Promise<ToolDefinition[]>;
	getSkills(): Promise<Skill[]>;
	getMemory(): Promise<Record<string, unknown>>;
	getConfig(key?: string): Promise<unknown>;
	setConfig?(key: string, value: unknown): Promise<unknown>;
	getAgents(): Promise<unknown[]>;
	getTasks(): Promise<unknown[]>;
	getChannels(): Promise<unknown[]>;
	getPlugins(): Promise<unknown[]>;
	clearContext(): Promise<void>;
	setModel?(model: string): Promise<void>;
	streamMessage(input: string): AsyncGenerator<StreamEvent>;
	shutdown(): Promise<void>;
}

function decodeStatusField(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

function describeModelRef(
	system: OctopusSystem,
	modelRef: string | undefined,
): { provider?: string; providerDisplayName?: string; model?: string } {
	if (!modelRef) return {};
	const registry = getProviderRegistry();
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelRef.slice(0, slashIndex);
		return {
			provider,
			providerDisplayName: registry[provider]?.displayName ?? provider,
			model: modelRef.slice(slashIndex + 1),
		};
	}

	for (const [provider, config] of Object.entries(system.config.ai.providers)) {
		const models =
			"models" in config && Array.isArray(config.models) ? config.models : [];
		if (models.includes(modelRef)) {
			return {
				provider,
				providerDisplayName: registry[provider]?.displayName ?? provider,
				model: modelRef,
			};
		}
	}

	for (const [provider, entry] of Object.entries(registry)) {
		if (entry.defaultModels.includes(modelRef)) {
			return {
				provider,
				providerDisplayName: entry.displayName,
				model: modelRef,
			};
		}
	}

	const activeProvider = system.router.getAvailableProviders()[0];
	return {
		provider: activeProvider,
		providerDisplayName: activeProvider
			? (registry[activeProvider]?.displayName ?? activeProvider)
			: undefined,
		model: modelRef,
	};
}

async function fetchJson<T>(
	baseUrl: string,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		signal: init?.signal ?? AbortSignal.timeout(10000),
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	return (await response.json()) as T;
}

export async function applyModelOverride(
	system: OctopusSystem,
	model: string,
): Promise<void> {
	const runtime = new AgentRuntime(
		{
			id: "default-agent",
			name: "Octavio",
			description: "Agente principal de Octopus AI",
			systemPrompt: `You are Octopus AI, an intelligent assistant with memory and skill capabilities.
You help users accomplish tasks efficiently by leveraging your memory of past interactions
and your library of learned skills. Be concise, helpful, and proactive.`,
			model,
			maxTokens: system.config.ai.maxTokens,
			toolIterationLimit: system.config.tools.iterationLimit,
			continuityGuard: system.config.continuityGuard,
			tenacidad: system.config.tenacidad,
		},
		system.router,
		system.stm,
		system.memoryRetrieval,
		system.memoryConsolidator,
		system.skillLoader,
	);
	runtime.setToolSystem(system.toolRegistry, system.toolExecutor);
	runtime.setDailyMemory(system.dailyMemory);
	runtime.setUserProfileManager(system.userProfileManager);
	runtime.setLearningEngine(system.learningEngine);
	await runtime.initialize();
	system.agentRuntime = runtime;
}

export function createLocalConsoleSession(
	system: OctopusSystem,
	webUrl: string,
	model = system.config.ai.default,
): ConsoleSession {
	let activeModel = model;
	let conversationId: string | undefined;
	return {
		kind: "local",
		webUrl,
		model: activeModel,
		get conversationId() {
			return conversationId;
		},
		set conversationId(value: string | undefined) {
			conversationId = value;
		},
		async getStatus() {
			const active = describeModelRef(system, activeModel);
			const fallback = describeModelRef(system, system.config.ai.fallback);
			return {
				status: "running",
				provider: active.provider,
				providerDisplayName: active.providerDisplayName,
				model: active.model ?? activeModel,
				fallback: system.config.ai.fallback,
				fallbackProvider: fallback.provider,
				fallbackModel: fallback.model,
				thinking: system.config.ai.thinking,
				maxTokens: system.config.ai.maxTokens,
				availableProviders: system.router.getAvailableProviders(),
				usage: system.router.getUsage(),
				memoryEnabled: system.config.memory.enabled,
				skillsEnabled: system.config.skills.enabled,
				server: system.config.server,
				uptime: process.uptime(),
			};
		},
		async getTools() {
			return system.toolRegistry.list();
		},
		async getSkills() {
			return system.skillRegistry.list();
		},
		async getMemory() {
			return {
				stmLoad: system.stm.getLoad(),
				stmTurns: system.stm.getContext().length,
				ltmItems: await system.ltm.count(),
				enabled: system.config.memory.enabled,
			};
		},
		async getConfig(key) {
			if (!key) return system.config;
			return key.split(".").reduce<unknown>((current, part) => {
				if (current && typeof current === "object") {
					return (current as Record<string, unknown>)[part];
				}
				return undefined;
			}, system.config as unknown);
		},
		async getAgents() {
			return system.agentManager?.listAgents?.() ?? [];
		},
		async getTasks() {
			return system.taskManager?.listTasks?.({ limit: 20, offset: 0 }) ?? [];
		},
		async getChannels() {
			return Object.entries(system.config.channels).map(([name, channel]) => ({
				name,
				enabled: channel.enabled,
			}));
		},
		async getPlugins() {
			return [];
		},
		async clearContext() {
			system.stm.clear();
			conversationId = undefined;
		},
		async setModel(modelName) {
			await applyModelOverride(system, modelName);
			activeModel = modelName;
			this.model = modelName;
		},
		async *streamMessage(input) {
			const title =
				input.length > 50 ? `${input.substring(0, 50).trimEnd()}...` : input;
			if (!conversationId) {
				const conv = await system.chatManager.createConversation({
					title,
					channel: "cli",
				});
				conversationId = conv.id;
			}

			await system.chatManager.addMessage(conversationId, "user", input);
			system.stm.clear();
			const history = await system.chatManager.getConversationMessages(
				conversationId,
				{ limit: CONVERSATION_HISTORY_LIMIT, recent: true },
			);
			for (const message of history.slice(0, -1)) {
				if (message.role !== "user" && message.role !== "assistant") continue;
				system.stm.add({
					role: message.role,
					content: message.content,
					timestamp: new Date(message.timestamp),
					metadata: { conversationId },
				});
			}

			let fullText = "";
			let assistantMessageId: string | undefined;
			let lastCheckpointAt = 0;
			const saveAssistantCheckpoint = async (
				status: "streaming" | "completed" | "interrupted",
				force = false,
			) => {
				if (!conversationId || !fullText.trim()) return;
				const now = Date.now();
				if (
					!force &&
					assistantMessageId &&
					now - lastCheckpointAt < STREAM_CHECKPOINT_INTERVAL_MS
				) {
					return;
				}
				const metadata = {
					status,
					partial: status !== "completed",
					checkpointedAt: new Date(now).toISOString(),
					source: "stream",
				};
				if (assistantMessageId) {
					await system.chatManager.updateMessage(assistantMessageId, fullText, {
						metadata,
					});
				} else {
					const msg = await system.chatManager.addMessage(
						conversationId,
						"assistant",
						fullText,
						{ metadata },
					);
					assistantMessageId = msg.id;
				}
				lastCheckpointAt = now;
			};

			try {
				for await (const chunk of system.agentRuntime.processMessageStream(
					input,
					conversationId,
				)) {
					const statusMatch = chunk.match(STATUS_RE);
					if (statusMatch) {
						yield {
							type: "status",
							status: statusMatch[1] ?? "status",
							toolName: statusMatch[2],
							detail: decodeStatusField(statusMatch[4]),
						};
						continue;
					}
					fullText += chunk;
					await saveAssistantCheckpoint("streaming");
					yield { type: "content", content: chunk };
				}
			} catch (err) {
				await saveAssistantCheckpoint("interrupted", true);
				throw err;
			}
			await saveAssistantCheckpoint("completed", true);
			if (system.config.memory.enabled) {
				await system.memoryConsolidator.consolidate(system.stm);
			}
			yield { type: "done" };
		},
		async shutdown() {},
	};
}

export async function createRemoteConsoleSession(
	webUrl: string,
	wsUrl: string,
): Promise<ConsoleSession> {
	const status = await fetchJson<ConsoleStatus>(webUrl, "/api/status");
	const client = new TransportClient({ url: wsUrl, reconnect: true });
	await client.connect();
	let conversationId: string | undefined;
	const session: ConsoleSession = {
		kind: "remote",
		webUrl,
		model: status.model ?? status.provider ?? "default",
		get conversationId() {
			return conversationId;
		},
		set conversationId(value: string | undefined) {
			conversationId = value;
		},
		getStatus: () => fetchJson<ConsoleStatus>(webUrl, "/api/status"),
		getTools: () => fetchJson<ToolDefinition[]>(webUrl, "/api/tools"),
		getSkills: () => fetchJson<Skill[]>(webUrl, "/api/skills"),
		getMemory: () =>
			fetchJson<Record<string, unknown>>(webUrl, "/api/memory/stats"),
		getConfig: (key?: string) =>
			fetchJson<unknown>(
				webUrl,
				key ? `/api/config/${encodeURIComponent(key)}` : "/api/config",
			),
		setConfig: (key, value) =>
			fetchJson<unknown>(webUrl, `/api/config/${encodeURIComponent(key)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value }),
			}),
		getAgents: () => fetchJson<unknown[]>(webUrl, "/api/agents"),
		getTasks: () => fetchJson<unknown[]>(webUrl, "/api/tasks?limit=20"),
		getChannels: () => fetchJson<unknown[]>(webUrl, "/api/channels"),
		getPlugins: () => fetchJson<unknown[]>(webUrl, "/api/plugins"),
		async clearContext() {
			conversationId = undefined;
		},
		async *streamMessage(input) {
			const queue: StreamEvent[] = [];
			let done = false;
			let error: Error | null = null;
			let wake: (() => void) | null = null;
			const notify = () => {
				wake?.();
				wake = null;
			};
			const unsubscribe = client.subscribe("chat", (payload) => {
				const data = payload as {
					content?: string;
					conversationId?: string;
					agentStatus?: string;
					toolName?: string | null;
					activityDetail?: string | null;
					done?: boolean;
					error?: string;
				};
				if (data.conversationId) conversationId = data.conversationId;
				if (data.error) error = new Error(data.error);
				else if (data.agentStatus) {
					queue.push({
						type: "status",
						status: data.agentStatus,
						toolName: data.toolName ?? undefined,
						detail: data.activityDetail ?? undefined,
					});
				} else if (data.content)
					queue.push({ type: "content", content: data.content });
				else if (data.done) done = true;
				notify();
			});
			client.send("chat", { message: input, stream: true, conversationId });
			try {
				while (!done || queue.length > 0) {
					if (error) throw error;
					const event = queue.shift();
					if (event) {
						yield event;
						continue;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
				yield { type: "done" };
			} finally {
				unsubscribe();
			}
		},
		async shutdown() {
			client.disconnect();
		},
	};
	return session;
}
