import type { ToolDefinition } from "./registry.js";

export type WorkerSpawner = (task: string, role: string) => Promise<string>;

export function createTeamTools(spawnWorker: WorkerSpawner): ToolDefinition[] {
	return [
		{
			name: "delegate_task",
			description:
				"Assigns a lengthy, research-heavy, or complex isolated sub-task to a specialized worker agent. This runs the task independently from your current context and returns the final synthesized result back to you, preventing your memory from overflowing.",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
			parameters: {
				role: {
					type: "string",
					description: "The specific persona/role for the worker (e.g. 'Expert Web Researcher', 'Python Code Reviewer').",
					required: true,
				},
				task: {
					type: "string",
					description: "The highly detailed prompt or goal that the worker needs to accomplish. Provide all necessary context.",
					required: true,
				},
			},
			handler: async (args) => {
				const role = String(args.role);
				const task = String(args.task);

				try {
					const result = await spawnWorker(task, role);
					return {
						success: true,
						output: `Worker '${role}' completed the task. Result:\n${result}`,
					};
				} catch (err: unknown) {
					return {
						success: false,
						output: "",
						error: `Failed to execute worker: ${(err as Error).message}`,
					};
				}
			},
		},
	];
}
