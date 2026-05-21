/**
 * WorkingMemory — Estado explícito de "qué estoy haciendo ahora".
 *
 * Inspirado en Devin's scratchpad y OpenHands' event log.
 * Se inyecta al system prompt para que el agente nunca pierda
 * el hilo de su tarea actual.
 */

export interface WorkingState {
	/** Goal principal del usuario en esta conversación */
	currentGoal: string;
	/** Sub-objetivos identificados */
	subGoals: string[];
	/** Pasos ya completados */
	completedSteps: string[];
	/** Pasos pendientes */
	pendingSteps: string[];
	/** Errores encontrados y sus resoluciones */
	errors: Array<{ step: string; error: string; resolution?: string }>;
	/** Datos clave mencionados (URLs, paths, API keys, etc.) */
	keyData: Record<string, string>;
	/** Herramientas usadas en esta sesión */
	toolsUsed: string[];
	/** Timestamp de la última actualización */
	lastUpdated: Date;
}

export class WorkingMemory {
	private state: WorkingState;

	constructor() {
		this.state = this.createEmpty();
	}

	/**
	 * Actualizar el goal principal.
	 */
	setGoal(goal: string): void {
		this.state.currentGoal = goal;
		this.state.lastUpdated = new Date();
	}

	/**
	 * Agregar un sub-objetivo.
	 */
	addSubGoal(subGoal: string): void {
		if (!this.state.subGoals.includes(subGoal)) {
			this.state.subGoals.push(subGoal);
			this.state.lastUpdated = new Date();
		}
	}

	/**
	 * Marcar un paso como completado.
	 */
	completeStep(step: string): void {
		this.state.completedSteps.push(step);
		this.state.pendingSteps = this.state.pendingSteps.filter((s) => s !== step);
		this.state.lastUpdated = new Date();
	}

	/**
	 * Agregar un paso pendiente.
	 */
	addPendingStep(step: string): void {
		if (!this.state.pendingSteps.includes(step)) {
			this.state.pendingSteps.push(step);
			this.state.lastUpdated = new Date();
		}
	}

	/**
	 * Registrar un error.
	 */
	addError(step: string, error: string): void {
		this.state.errors.push({ step, error });
		this.state.lastUpdated = new Date();
	}

	/**
	 * Registrar la resolución de un error.
	 */
	resolveError(step: string, resolution: string): void {
		const err = this.state.errors.find((e) => e.step === step && !e.resolution);
		if (err) {
			err.resolution = resolution;
			this.state.lastUpdated = new Date();
		}
	}

	/**
	 * Almacenar un dato clave (URL, path, API key, etc.)
	 */
	setKeyData(key: string, value: string): void {
		this.state.keyData[key] = value;
		this.state.lastUpdated = new Date();
	}

	/**
	 * Registrar uso de herramienta.
	 */
	trackTool(toolName: string): void {
		if (!this.state.toolsUsed.includes(toolName)) {
			this.state.toolsUsed.push(toolName);
			this.state.lastUpdated = new Date();
		}
	}

	/**
	 * Actualizar automáticamente desde un mensaje del usuario.
	 * Extrae goals, paths, URLs y datos clave con heurísticas.
	 */
	updateFromUserMessage(content: string): void {
		// Auto-detect goal si no hay uno
		if (!this.state.currentGoal && content.length > 10) {
			this.state.currentGoal = content.slice(0, 200);
		}

		// Extraer URLs
		const urls = content.match(/https?:\/\/[^\s)]+/g);
		if (urls) {
			for (const url of urls.slice(0, 3)) {
				try {
					const domain = new URL(url).hostname.replace("www.", "");
					this.state.keyData[`url:${domain}`] = url;
				} catch {
					// Ignore malformed URL-like text captured by the broad regex.
				}
			}
		}

		// Extraer file paths
		const paths = content.match(
			/[A-Za-z]:[\\\/][\w\-\.\\\/]+|\/[\w\-\.\/]{5,}/g,
		);
		if (paths) {
			for (const p of paths.slice(0, 3)) {
				const name = p.split(/[\\\/]/).pop() || p;
				this.state.keyData[`path:${name}`] = p;
			}
		}

		this.state.lastUpdated = new Date();
	}

	/**
	 * Actualizar desde un resultado de herramienta.
	 */
	updateFromToolResult(
		toolName: string,
		success: boolean,
		errorMsg?: string,
	): void {
		this.trackTool(toolName);
		if (!success && errorMsg) {
			this.addError(toolName, errorMsg.slice(0, 200));
		}
		if (success) {
			const unresolved = this.state.errors.filter(
				(e) => e.step === toolName && !e.resolution,
			);
			for (const err of unresolved) {
				err.resolution =
					"Auto-resolved: subsequent execution succeeded (likely via automatic retry)";
			}
			this.state.lastUpdated = new Date();
		}
	}

	/**
	 * Generar contexto para inyectar al system prompt.
	 * Compacto pero informativo.
	 */
	toContextString(): string {
		const parts: string[] = [];

		if (this.state.currentGoal) {
			parts.push(`**Current Goal**: ${this.state.currentGoal}`);
		}

		if (this.state.completedSteps.length > 0) {
			const recent = this.state.completedSteps.slice(-5);
			parts.push(
				`**Completed** (${this.state.completedSteps.length}): ${recent.join(" → ")}`,
			);
		}

		if (this.state.pendingSteps.length > 0) {
			parts.push(`**Pending**: ${this.state.pendingSteps.join(", ")}`);
		}

		const unresolvedErrors = this.state.errors.filter((e) => !e.resolution);
		if (unresolvedErrors.length > 0) {
			parts.push(
				`**Active Errors**: ${unresolvedErrors.map((e) => `${e.step}: ${e.error}`).join("; ")}`,
			);
		}

		const keyEntries = Object.entries(this.state.keyData);
		if (keyEntries.length > 0) {
			parts.push(
				`**Key Data**: ${keyEntries
					.slice(0, 8)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ")}`,
			);
		}

		if (this.state.toolsUsed.length > 0) {
			parts.push(`**Tools Used**: ${this.state.toolsUsed.join(", ")}`);
		}

		if (parts.length === 0) return "";

		return `## Working Memory\n${parts.join("\n")}`;
	}

	/**
	 * Check if there's meaningful state to inject.
	 */
	hasContent(): boolean {
		return (
			!!this.state.currentGoal ||
			this.state.subGoals.length > 0 ||
			this.state.completedSteps.length > 0 ||
			this.state.pendingSteps.length > 0 ||
			this.state.errors.length > 0 ||
			Object.keys(this.state.keyData).length > 0 ||
			this.state.toolsUsed.length > 0
		);
	}

	/**
	 * Reset para nueva conversación.
	 */
	reset(): void {
		this.state = this.createEmpty();
	}

	getState(): Readonly<WorkingState> {
		return this.state;
	}

	private createEmpty(): WorkingState {
		return {
			currentGoal: "",
			subGoals: [],
			completedSteps: [],
			pendingSteps: [],
			errors: [],
			keyData: {},
			toolsUsed: [],
			lastUpdated: new Date(),
		};
	}
}
