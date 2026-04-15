import cron from "node-cron";

export class Scheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private expressions: Map<string, string> = new Map();

  schedule(name: string, expression: string, task: () => Promise<void>): void {
    if (this.tasks.has(name)) {
      throw new Error(`Task with name ${name} already exists.`);
    }

    const scheduledTask = cron.schedule(expression, async () => {
      try {
        await task();
      } catch (error) {
        console.error(`Error executing scheduled task '${name}':`, error);
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
    }
  }

  list(): Array<{ name: string; expression: string }> {
    return Array.from(this.expressions.entries()).map(([name, expression]) => ({
      name,
      expression,
    }));
  }
}
