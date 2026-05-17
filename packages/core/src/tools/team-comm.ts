import type { TeamBlackboard } from "../team/blackboard.js";
import type { ToolDefinition } from "./index.js";

/**
 * Crea las herramientas de colaboración del equipo.
 * Requiere la instancia global del TeamBlackboard y el ID del worker actual.
 */
export function createTeamCommTools(
	blackboard: TeamBlackboard,
	workerId: string,
): ToolDefinition[] {
	return [
		{
			name: "broadcast_message",
			description:
				"Envia un mensaje importante, advertencia o hallazgo a todos los demás agentes activos en el equipo. Úsalo si descubres algo que afectará el trabajo de los demás (ej. cambiaste una firma de función, actualizaste dependencias o encontraste un bug compartido).",
			parameters: {
				message: {
					type: "string",
					description: "El mensaje a enviar al equipo. Sé claro y conciso.",
					required: true,
				},
			},
			handler: async (args: Record<string, unknown>) => {
				const message = String(args.message);
				blackboard.broadcast(workerId, message);
				return {
					success: true,
					output: `Mensaje enviado a todos los agentes activos: "${message}"`,
				};
			},
		},
		{
			name: "ask_orchestrator",
			description:
				"Pide ayuda o clarificación al orquestador principal (el 'Manager'). Úsalo si los requisitos son ambiguos, te enfrentas a una decisión arquitectónica clave, o no sabes cómo proceder.",
			parameters: {
				question: {
					type: "string",
					description: "La pregunta o duda específica para el orquestador.",
					required: true,
				},
			},
			handler: async (args: Record<string, unknown>) => {
				const question = String(args.question);
				const answer = await blackboard.askOrchestrator(workerId, question);
				return {
					success: true,
					output: `El orquestador respondió:\n\n${answer}`,
				};
			},
		},
		{
			name: "report_file_lock",
			description:
				"Informa al equipo que vas a editar un archivo crítico para evitar colisiones. Si el archivo ya está siendo editado por otro agente, recibirás una advertencia.",
			parameters: {
				filePath: {
					type: "string",
					description:
						"La ruta absoluta o relativa del archivo que planeas editar fuertemente.",
					required: true,
				},
			},
			handler: async (args: Record<string, unknown>) => {
				const filePath = String(args.filePath);
				const successLock = blackboard.lockFile(workerId, filePath);
				if (!successLock) {
					return {
						success: false,
						output: `ADVERTENCIA: Otro agente ya está editando el archivo '${filePath}'. Procede con extrema precaución para no causar conflictos, o coordínate mediante 'broadcast_message'.`,
					};
				}
				// Avisamos al equipo silenciosamente
				blackboard.broadcast(
					workerId,
					`Voy a realizar cambios en el archivo: ${filePath}`,
				);
				return {
					success: true,
					output: `Bloqueo virtual registrado para '${filePath}'. El equipo ha sido notificado. No olvides desbloquearlo o simplemente terminar tu tarea cuando acabes.`,
				};
			},
		},
	];
}
