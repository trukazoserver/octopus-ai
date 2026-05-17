import type { AgentRuntime } from "../agent/runtime.js";

export interface BlackboardEvent {
	id: string;
	timestamp: number;
	fromWorkerId: string;
	type: "broadcast" | "ask_orchestrator" | "file_lock";
	data: unknown;
}

export class TeamBlackboard {
	private activeWorkers = new Map<string, AgentRuntime>();
	private fileLocks = new Map<string, string>(); // filePath -> workerId
	private orchestrator: AgentRuntime | null = null;
	private events: BlackboardEvent[] = [];

	registerOrchestrator(runtime: AgentRuntime) {
		this.orchestrator = runtime;
	}

	registerWorker(workerId: string, runtime: AgentRuntime) {
		this.activeWorkers.set(workerId, runtime);
	}

	unregisterWorker(workerId: string) {
		this.activeWorkers.delete(workerId);
		// Eliminar locks de este worker
		for (const [file, owner] of this.fileLocks.entries()) {
			if (owner === workerId) {
				this.fileLocks.delete(file);
			}
		}
	}

	/**
	 * Envía un mensaje a todos los demás workers activos.
	 */
	broadcast(fromWorkerId: string, message: string) {
		const event: BlackboardEvent = {
			id: `bb_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			timestamp: Date.now(),
			fromWorkerId,
			type: "broadcast",
			data: { message },
		};
		this.events.push(event);

		const alertMessage = `[ALERTA DEL EQUIPO - Worker ${fromWorkerId}]: ${message}`;
		for (const [id, worker] of this.activeWorkers.entries()) {
			if (id !== fromWorkerId) {
				worker.injectSystemMessage(alertMessage);
			}
		}
	}

	/**
	 * Permite a un worker solicitar ayuda al orquestador en segundo plano.
	 */
	async askOrchestrator(
		fromWorkerId: string,
		question: string,
	): Promise<string> {
		if (!this.orchestrator) {
			return "Error: Orquestador no disponible o no registrado.";
		}

		try {
			// Hacer una consulta rápida al LLM del orquestador sin afectar su hilo principal
			// El orquestador usa su propio contexto para responder.
			const contextSummary = this.orchestrator.getContextSummary(4000);
			const prompt = `[INTERRUPCIÓN DE SUB-AGENTE]
El sub-agente '${fromWorkerId}' te pregunta: "${question}"

Aquí tienes tu contexto principal para ayudarle:
${contextSummary}

Responde de manera concisa y directa al sub-agente. Si no sabes la respuesta, dile que tome su mejor decisión basándose en su criterio.`;

			// Asumimos que podemos llamar al LLMRouter del orquestador directamente.
			// Para mantenerlo simple, usaremos el mismo llmRouter si está expuesto.
			// Requeriremos agregar un método a AgentRuntime para "responder como orquestador".
			return await this.orchestrator.answerWorkerQuestion(prompt);
		} catch (err) {
			return `Error al consultar al orquestador: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/**
	 * Declara un "soft lock" sobre un archivo.
	 */
	lockFile(fromWorkerId: string, filePath: string): boolean {
		const currentOwner = this.fileLocks.get(filePath);
		if (currentOwner && currentOwner !== fromWorkerId) {
			return false; // Alguien más lo tiene
		}
		this.fileLocks.set(filePath, fromWorkerId);
		return true;
	}

	unlockFile(fromWorkerId: string, filePath: string): void {
		if (this.fileLocks.get(filePath) === fromWorkerId) {
			this.fileLocks.delete(filePath);
		}
	}

	getLocks(): Record<string, string> {
		return Object.fromEntries(this.fileLocks);
	}
}
