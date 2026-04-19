import type { DatabaseAdapter } from "../storage/database.js";

export class MemoryDecayEngine {
	constructor(
		private db: DatabaseAdapter,
		private config: { episodicRate: number; semanticRate: number },
	) {}

	async applyDecay(): Promise<void> {
		const items = await this.db.all<{
			id: string;
			type: string;
			importance: number;
			last_accessed: string;
		}>("SELECT id, type, importance, last_accessed FROM memory_items");
		const now = new Date();

		for (const item of items) {
			const lastAccessed = item.last_accessed
				? new Date(item.last_accessed)
				: new Date();
			const diffMs = now.getTime() - lastAccessed.getTime();
			const daysSince = diffMs / (1000 * 60 * 60 * 24);

			let newImportance = item.importance;

			if (item.type === "episodic") {
				newImportance -= this.config.episodicRate * daysSince;
			} else if (item.type === "semantic") {
				newImportance -= this.config.semanticRate * daysSince;
			}

			if (newImportance < 0.1) {
				await this.db.run("DELETE FROM memory_items WHERE id = ?", [item.id]);
				await this.db.run(
					"DELETE FROM memory_associations WHERE source_id = ? OR target_id = ?",
					[item.id, item.id],
				);
			} else if (newImportance !== item.importance) {
				await this.db.run(
					"UPDATE memory_items SET importance = ? WHERE id = ?",
					[newImportance, item.id],
				);
			}
		}
	}

	async compressEpisodic(olderThanDays: number): Promise<number> {
		const now = new Date();
		const cutoffDate = new Date(
			now.getTime() - olderThanDays * 24 * 60 * 60 * 1000,
		);

		const oldEpisodicItems = await this.db.all<{ id: string }>(
			`SELECT id FROM memory_items WHERE type = 'episodic' AND created_at < ?`,
			[cutoffDate.toISOString()],
		);

		let compressed = 0;
		for (const item of oldEpisodicItems) {
			await this.db.run("DELETE FROM memory_items WHERE id = ?", [item.id]);
			await this.db.run(
				"DELETE FROM memory_associations WHERE source_id = ? OR target_id = ?",
				[item.id, item.id],
			);
			compressed++;
		}

		return compressed;
	}
}
