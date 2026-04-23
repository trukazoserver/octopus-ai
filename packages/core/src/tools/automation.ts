import type { ToolDefinition } from "./registry.js";
import type { AutomationManager } from "../tasks/automation-manager.js";

export function createAutomationTools(manager: AutomationManager): ToolDefinition[] {
	return [
		{
			name: "schedule_task",
			description: "Schedules a recurring task or cron job for the assistant to perform autonomously. Use cron expression format '* * * * *'. Example: '0 8 * * *' for every day at 8 AM.",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
			parameters: {
				name: { type: "string", description: "A simple name for the task.", required: true },
				description: { type: "string", description: "Detailed description of what the task does." },
				cronExpression: { type: "string", description: "The node-cron expression (e.g. '0 * * * *' for every hour).", required: true },
				prompt: { type: "string", description: "The exact prompt the agent will execute when this trigger fires.", required: true },
			},
			handler: async (args) => {
				const cronExpression = String(args.cronExpression);
				const prompt = String(args.prompt);
				const name = String(args.name);
				const description = args.description ? String(args.description) : undefined;

				const automation = await manager.createAutomation({
					name,
					description,
					triggerType: "cron",
					triggerConfig: { expression: cronExpression },
					actionType: "agent_prompt",
					actionConfig: { prompt },
				});

				return {
					success: true,
					output: `Scheduled automation '${name}' successfully with ID: ${automation.id}. It will run on cron '${cronExpression}'.`,
				};
			},
		},
		{
			name: "list_tasks",
			description: "Lists all currently scheduled automated tasks (crons).",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`,
			parameters: {},
			handler: async () => {
				const automations = await manager.listAutomations();
				if (automations.length === 0)
					return { success: true, output: "No scheduled tasks found." };

				const list = automations
					.map((a) => {
						let expr = "";
						let prompt = "";
						try {
							expr = JSON.parse(a.trigger_config).expression;
						} catch {}
						try {
							prompt = JSON.parse(a.action_config).prompt;
						} catch {}
						return `- [${a.enabled ? "ACTIVE" : "PAUSED"}] ID: ${a.id} | Name: ${a.name} | Cron: ${expr} | Action: ${prompt}`;
					})
					.join("\n");

				return {
					success: true,
					output: `Scheduled Tasks:\n${list}`,
				};
			},
		},
	];
}
