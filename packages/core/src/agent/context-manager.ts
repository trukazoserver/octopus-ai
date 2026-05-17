/**
 * ContextManager — Gestión inteligente de la ventana de contexto.
 *
 * Estrategias inspiradas en las mejores prácticas de agentes modernos:
 * 1. Progressive Summarization: resumir turnos viejos cada N turnos
 * 2. Tool Result Compression: guardar solo la conclusión, no el output completo
 * 3. Memory Injection Selectiva: solo inyectar memorias con relevancia > umbral
 * 4. Deduplicación: detectar y eliminar información redundante
 */

import type { LLMRouter } from "../ai/router.js";
import type { LLMMessage, LLMRequest } from "../ai/types.js";

export interface ContextManagerConfig {
	/** Máximo de tokens estimados para el contexto (por defecto ~100k chars ≈ 25k tokens) */
	maxContextChars: number;
	/** Cada cuántos turnos resumir los turnos anteriores */
	summarizeEveryNTurns: number;
	/** Máximo de caracteres por resultado de herramienta en contexto */
	maxToolResultChars: number;
	/** Umbral de relevancia para inyección de memorias (0-1) */
	memoryRelevanceThreshold: number;
	/** Modelo para generar resúmenes (puede ser uno más barato) */
	summaryModel?: string;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
	maxContextChars: 100_000,
	summarizeEveryNTurns: 8,
	maxToolResultChars: 8_000,
	memoryRelevanceThreshold: 0.3,
};

interface ConversationSegment {
	messages: LLMMessage[];
	summary?: string;
	turnCount: number;
}

export class ContextManager {
	private config: ContextManagerConfig;
	private segments: ConversationSegment[] = [];
	private currentSegment: ConversationSegment;

	constructor(
		private llmRouter: LLMRouter,
		private baseModel: string,
		config: Partial<ContextManagerConfig> = {},
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.currentSegment = { messages: [], turnCount: 0 };
	}

	/**
	 * Agregar un mensaje al contexto, aplicando compresión si es necesario.
	 */
	async addMessage(message: LLMMessage): Promise<void> {
		let messageToAdd = message;
		// Comprimir resultados de herramientas
		if (message.role === "tool" && typeof message.content === "string") {
			messageToAdd = {
				...message,
				content: this.compressToolResult(message.content),
			};
		}

		this.currentSegment.messages.push(messageToAdd);

		if (messageToAdd.role === "user" || messageToAdd.role === "assistant") {
			this.currentSegment.turnCount++;
		}

		// ¿Es hora de resumir?
		if (this.currentSegment.turnCount >= this.config.summarizeEveryNTurns) {
			await this.summarizeCurrentSegment();
		}
	}

	/**
	 * Obtener los mensajes optimizados para enviar al LLM.
	 */
	async getOptimizedMessages(systemPrompt?: string): Promise<LLMMessage[]> {
		const messages: LLMMessage[] = [];

		// System prompt
		if (systemPrompt) {
			messages.push({ role: "system", content: systemPrompt });
		}

		// Resúmenes de segmentos anteriores
		const summaries = this.segments
			.map((s) => s.summary)
			.filter((summary): summary is string => Boolean(summary));

		if (summaries.length > 0) {
			messages.push({
				role: "system",
				content: `# Resumen de la conversación anterior\n\n${summaries.join("\n\n---\n\n")}`,
			});
		}

		// Mensajes del segmento actual
		messages.push(...this.currentSegment.messages);

		// Verificar que no excedemos el límite
		const totalChars = this.estimateChars(messages);
		if (totalChars > this.config.maxContextChars) {
			return this.trimToFit(messages);
		}

		return messages;
	}

	/**
	 * Comprimir un resultado de herramienta para reducir uso de contexto.
	 */
	private compressToolResult(content: string): string {
		if (content.length <= this.config.maxToolResultChars) return content;

		// Eliminar datos base64 inline
		let compressed = content.replace(
			/data:image\/[a-zA-Z0-9+-]+;base64,[A-Za-z0-9+/=]{100,}/g,
			"[imagen base64 omitida]",
		);

		// Eliminar HTML largo
		compressed = compressed.replace(
			/<(?:html|body|head|script|style)[^>]*>[\s\S]{500,}?<\/(?:html|body|head|script|style)>/gi,
			"[contenido HTML largo omitido]",
		);

		// Eliminar JSONs largos repetitivos
		compressed = compressed.replace(
			/\{[^{}]{2000,}\}/g,
			"[objeto JSON largo omitido]",
		);

		// Si sigue siendo largo, truncar con contexto
		if (compressed.length > this.config.maxToolResultChars) {
			const half = Math.floor(this.config.maxToolResultChars / 2);
			compressed = `${compressed.slice(0, half)}\n...[resultado truncado, ${compressed.length - this.config.maxToolResultChars} chars omitidos]...\n${compressed.slice(-half)}`;
		}

		return compressed;
	}

	/**
	 * Resumir el segmento actual y archivarlo.
	 */
	private async summarizeCurrentSegment(): Promise<void> {
		if (this.currentSegment.messages.length === 0) return;

		const summary = await this.generateSummary(this.currentSegment.messages);

		this.segments.push({
			...this.currentSegment,
			summary,
		});

		this.currentSegment = { messages: [], turnCount: 0 };
	}

	/**
	 * Generar un resumen de un conjunto de mensajes.
	 */
	private async generateSummary(messages: LLMMessage[]): Promise<string> {
		// Filtrar solo contenido relevante para el resumen
		const relevantContent = messages
			.filter((m) => m.role !== "system")
			.map((m) => {
				const role =
					m.role === "user"
						? "Usuario"
						: m.role === "assistant"
							? "Asistente"
							: "Herramienta";
				const content =
					typeof m.content === "string"
						? m.content.slice(0, 500)
						: "[contenido complejo]";
				return `${role}: ${content}`;
			})
			.join("\n");

		try {
			const request: LLMRequest = {
				model: this.config.summaryModel || this.baseModel,
				messages: [
					{
						role: "system",
						content:
							"Resume esta conversación en 2-4 oraciones. Incluye: decisiones tomadas, resultados clave, y cualquier URL/ruta/dato importante. Sé conciso pero preciso.",
					},
					{ role: "user", content: relevantContent },
				],
				maxTokens: 500,
				temperature: 0.1,
			};

			const response = await this.llmRouter.chat(request);
			return response.content || this.fallbackSummary(messages);
		} catch {
			return this.fallbackSummary(messages);
		}
	}

	/**
	 * Resumen de fallback sin usar el LLM.
	 */
	private fallbackSummary(messages: LLMMessage[]): string {
		const userMessages = messages
			.filter((m) => m.role === "user")
			.map((m) =>
				typeof m.content === "string" ? m.content.slice(0, 100) : "",
			)
			.filter(Boolean);

		const toolsUsed = messages
			.filter((m) => m.role === "assistant" && m.toolCalls)
			.flatMap((m) => m.toolCalls?.map((tc) => tc.function.name) || []);

		const uniqueTools = [...new Set(toolsUsed)];

		return [
			`El usuario pidió: ${userMessages.join("; ").slice(0, 300)}`,
			uniqueTools.length > 0
				? `Herramientas usadas: ${uniqueTools.join(", ")}`
				: "",
			`(${messages.length} mensajes en total)`,
		]
			.filter(Boolean)
			.join(". ");
	}

	/**
	 * Deduplicar mensajes del sistema repetidos.
	 */
	deduplicateSystemMessages(messages: LLMMessage[]): LLMMessage[] {
		const seen = new Set<string>();
		return messages.filter((m) => {
			if (m.role !== "system") return true;
			const key = typeof m.content === "string" ? m.content.slice(0, 200) : "";
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	/**
	 * Estimar el número de caracteres en un array de mensajes.
	 */
	private estimateChars(messages: LLMMessage[]): number {
		return messages.reduce((total, m) => {
			if (typeof m.content === "string") return total + m.content.length;
			if (Array.isArray(m.content)) {
				return (
					total +
					m.content.reduce((sum, part) => {
						if (part.type === "text") return sum + (part.text?.length || 0);
						return sum + 100; // Estimación para imágenes
					}, 0)
				);
			}
			return total + 100;
		}, 0);
	}

	/**
	 * Recortar mensajes para que quepan en el límite.
	 */
	private trimToFit(messages: LLMMessage[]): LLMMessage[] {
		const limit = this.config.maxContextChars;

		// Mantener siempre: primer system prompt + últimos N mensajes
		const systemMessages = messages.filter((m) => m.role === "system");
		const nonSystem = messages.filter((m) => m.role !== "system");

		// Empezar desde el final y agregar hasta llenar
		const kept: LLMMessage[] = [...systemMessages];
		let usedChars = this.estimateChars(kept);

		for (let i = nonSystem.length - 1; i >= 0; i--) {
			const msgChars = this.estimateChars([nonSystem[i]]);
			if (usedChars + msgChars > limit) break;
			kept.splice(systemMessages.length, 0, nonSystem[i]);
			usedChars += msgChars;
		}

		return kept;
	}

	/**
	 * Resetear el contexto (para nueva conversación).
	 */
	reset(): void {
		this.segments = [];
		this.currentSegment = { messages: [], turnCount: 0 };
	}

	/**
	 * Estadísticas del contexto actual.
	 */
	getStats(): {
		totalSegments: number;
		currentTurns: number;
		totalMessages: number;
		estimatedChars: number;
	} {
		const allMessages = [
			...this.segments.flatMap((s) => s.messages),
			...this.currentSegment.messages,
		];
		return {
			totalSegments: this.segments.length,
			currentTurns: this.currentSegment.turnCount,
			totalMessages: allMessages.length,
			estimatedChars: this.estimateChars(allMessages),
		};
	}
}
