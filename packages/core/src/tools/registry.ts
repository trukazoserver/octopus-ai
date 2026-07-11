import type { LLMTool } from "../ai/types.js";

const JSON_SCHEMA_TYPES = new Set([
	"string",
	"number",
	"integer",
	"boolean",
	"object",
	"array",
]);

function normalizeSchemaType(type: unknown): string {
	if (typeof type === "string" && JSON_SCHEMA_TYPES.has(type)) return type;
	if (Array.isArray(type)) {
		const firstSupported = type.find(
			(item) => typeof item === "string" && JSON_SCHEMA_TYPES.has(item),
		);
		if (typeof firstSupported === "string") return firstSupported;
	}
	return "string";
}

export interface ToolContext {
	media: {
		/**
		 * Guarda un archivo multimedia localmente de forma segura y estructurada.
		 */
		save: (
			buffer: Buffer,
			mimeType: string,
			description?: string,
			metadata?: Record<string, unknown>,
		) => Promise<{
			id: string;
			url: string;
			filename: string;
			size: number;
			mimetype: string;
			metadata?: Record<string, unknown>;
		}>;
		/**
		 * Resuelve un archivo local o URL nativa de Octopus, y devuelve su Buffer.
		 */
		resolve: (url: string) => Promise<{ buffer: Buffer; mimeType: string }>;
	};
	agent?: {
		agentId?: string;
		model?: string;
		usesZaiVisionToolForImages?: boolean;
		workerId?: string;
		taskId?: string;
		role?: string;
		channelId?: string;
		runId?: string;
		toolScope?: string[];
		fileScope?: string[];
		abortSignal?: AbortSignal;
	};
	/**
	 * Canal de progreso para tools de larga duración (longRunning). El runtime
	 * provee un callback que el handler invoca con strings STATUS para que la
	 * UI muestre progreso en vivo mientras la tool aún no resuelve.
	 */
	onProgress?: (status: string) => void;
}

export interface ToolDefinition {
	name: string;
	description: string;
	uiIcon?: string;
	metadata?: Record<string, unknown>;
	/**
	 * When true, the tool resolves and validates path parameters itself (e.g.
	 * anchoring relative paths to the workspace) instead of relying on the
	 * ToolExecutor's generic cwd-based prevalidation. ToolExecutor skips its
	 * path prevalidation for these tools.
	 */
	managesOwnPathPolicy?: boolean;
	/**
	 * Marca la tool como de larga duración (p.ej. orquestación multi-agente).
	 * El runtime drena un canal de progreso (context.onProgress)
	 * concurrentemente mientras la tool no resuelve, para que la UI no se
	 * congele esperando el resultado.
	 */
	longRunning?: boolean;
	parameters: Record<
		string,
		{ type: string; description: string; required?: boolean }
	>;
	handler: (
		params: Record<string, unknown>,
		context: ToolContext,
	) => Promise<ToolResult>;
}

export type ToolErrorCode =
	| "TOOL_NOT_FOUND"
	| "INVALID_ARGUMENTS"
	| "ABORTED"
	| "TIMEOUT"
	| "SECURITY_BLOCKED"
	| "PROVIDER_AUTH"
	| "PROVIDER_PERMISSION"
	| "PROVIDER_QUOTA"
	| "PROVIDER_BILLING"
	| "PROVIDER_UNAVAILABLE"
	| "CIRCUIT_OPEN"
	| "EXECUTION_FAILED";

export interface ToolResult {
	success: boolean;
	output: string;
	error?: string;
	errorCode?: ToolErrorCode;
	metadata?: Record<string, unknown>;
}

export class ToolRegistry {
	private tools: Map<string, ToolDefinition> = new Map();

	register(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	unregister(name: string): void {
		this.tools.delete(name);
	}

	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	list(): ToolDefinition[] {
		return Array.from(this.tools.values());
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	toLLMTools(options?: { excludeServerNames?: string[] }): LLMTool[] {
		const exclude = options?.excludeServerNames;
		return this.list()
			.filter((tool) => {
				if (!exclude || exclude.length === 0) return true;
				const serverName = String(tool.metadata?.serverName ?? "");
				return !exclude.includes(serverName);
			})
			.map((tool) => ({
				type: "function" as const,
				function: {
					name: tool.name,
					description: tool.description,
					parameters: {
						type: "object",
						properties: Object.fromEntries(
							Object.entries(tool.parameters).map(([key, param]) => [
								key,
								{
									type: normalizeSchemaType(param.type),
									description:
										typeof param.description === "string"
											? param.description
											: "",
								},
							]),
						),
						required: Object.entries(tool.parameters)
							.filter(([, param]) => param.required)
							.map(([key]) => key),
					},
				},
			}));
	}
}
