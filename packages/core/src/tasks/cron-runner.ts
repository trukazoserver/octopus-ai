import type { AutomationManager, Automation } from "./automation-manager.js";
import { Scheduler } from "./cron.js";

type ActionExecutor = (actionType: string, actionConfig: any, automation: Automation) => Promise<void>;

export class AutomationRunner {
	private scheduler: Scheduler;

	constructor(
		private manager: AutomationManager,
		private executor: ActionExecutor
	) {
		this.scheduler = new Scheduler();
	}

	async initialize(): Promise<void> {
		const automations = await this.manager.getEnabledAutomations();
		for (const automation of automations) {
			this.scheduleAutomation(automation);
		}
	}

	scheduleAutomation(automation: Automation): void {
		if (automation.trigger_type !== "cron") return;
		
		let triggerConfig: any;
		try {
			triggerConfig = JSON.parse(automation.trigger_config);
		} catch {
			console.error(`Invalid trigger config for automation ${automation.id}`);
			return;
		}

		if (!triggerConfig.expression) return;
		
		const taskId = `automation-${automation.id}`;
		
		try {
			this.scheduler.schedule(taskId, triggerConfig.expression, async () => {
				console.log(`[AutomationRunner] Triggering automation ${automation.name} (${automation.id})`);
				await this.manager.recordRun(automation.id);
				
				let actionConfig: any;
				try {
					actionConfig = JSON.parse(automation.action_config);
				} catch {
					actionConfig = {};
				}
				
				await this.executor(automation.action_type, actionConfig, automation);
			});
			console.log(`[AutomationRunner] Scheduled cron ${taskId} with expression ${triggerConfig.expression}`);
		} catch (err) {
			console.error(`[AutomationRunner] Failed to schedule ${taskId}:`, err);
		}
	}

	cancelAutomation(id: string): void {
		const taskId = `automation-${id}`;
		this.scheduler.cancel(taskId);
	}
	
	async syncAutomation(id: string): Promise<void> {
		this.cancelAutomation(id);
		const automation = await this.manager.getAutomation(id);
		if (automation && automation.enabled) {
			this.scheduleAutomation(automation);
		}
	}
}
