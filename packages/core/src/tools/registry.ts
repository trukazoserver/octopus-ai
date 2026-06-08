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
}

export interface ToolDefinition {
	name: string;
	description: string;
	uiIcon?: string;
	metadata?: Record<string, unknown>;
	parameters: Record<
		string,
		{ type: string; description: string; required?: boolean }
	>;
	handler: (
		params: Record<string, unknown>,
		context: ToolContext,
	) => Promise<ToolResult>;
}

export interface ToolResult {
	success: boolean;
	output: string;
	error?: string;
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

	toLLMTools(): LLMTool[] {
		return this.list().map((tool) => ({
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
