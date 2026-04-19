import type { SkillImprover } from "./improver.js";
import type { SkillRegistry } from "./registry.js";

export class SkillImprovementCron {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private registry: SkillRegistry,
		private improver: SkillImprover,
		private intervalMs: number,
	) {}

	start(): void {
		if (this.timer) {
			this.stop();
		}
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				console.error("SkillImprovementCron error:", err),
			);
		}, this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async tick(): Promise<void> {
		const skillsNeedingImprovement =
			await this.registry.findSkillsNeedingImprovement();

		for (const skill of skillsNeedingImprovement) {
			const history = await this.registry.getUsageHistory(skill.id, 100);

			const improvedSkill = await this.improver.improveSkill(skill, history);

			await this.registry.save(improvedSkill);
		}
	}
}
