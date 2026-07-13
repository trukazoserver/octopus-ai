import cron from "node-cron";

export class Scheduler {
	private tasks: Map<string, cron.ScheduledTask> = new Map();
	private expressions: Map<string, string> = new Map();
	private running = new Set<string>();

	schedule(name: string, expression: string, task: () => Promise<void>): void {
		if (this.tasks.has(name)) {
			throw new Error(`Task with name ${name} already exists.`);
		}

		const scheduledTask = cron.schedule(expression, async () => {
			if (this.running.has(name)) return;
			this.running.add(name);
			try {
				await task();
			} catch (error) {
				console.error(`Error executing scheduled task '${name}':`, error);
			} finally {
				this.running.delete(name);
			}
		});

		this.tasks.set(name, scheduledTask);
		this.expressions.set(name, expression);
	}

	cancel(name: string): void {
		const task = this.tasks.get(name);
		if (task) {
			task.stop();
			this.tasks.delete(name);
			this.expressions.delete(name);
			this.running.delete(name);
		}
	}

	list(): Array<{ name: string; expression: string }> {
		return Array.from(this.expressions.entries()).map(([name, expression]) => ({
			name,
			expression,
		}));
	}

	stopAll(): void {
		for (const name of Array.from(this.tasks.keys())) this.cancel(name);
	}
}
