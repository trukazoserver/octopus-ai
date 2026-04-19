import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";

export class KnowledgeGraph {
	constructor(private db: DatabaseAdapter) {}

	async addNode(
		id: string,
		label: string,
		type: string,
		properties: Record<string, unknown>,
	): Promise<void> {
		const propsJson = JSON.stringify(properties);
		const dummyEmbedding = new Float32Array(1536);
		const embeddingBlob = Buffer.from(dummyEmbedding.buffer);

		await this.db.run(
			`INSERT INTO memory_items (id, content, type, embedding, importance, access_count, last_accessed, created_at, associations, source, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, metadata=excluded.metadata`,
			[
				id,
				label,
				type,
				embeddingBlob,
				1.0,
				1,
				new Date().toISOString(),
				new Date().toISOString(),
				"[]",
				"{}",
				propsJson,
			],
		);
	}

	async addEdge(
		fromId: string,
		toId: string,
		relation: string,
		weight: number,
	): Promise<void> {
		const edgeId = nanoid();
		await this.db.run(
			"DELETE FROM memory_associations WHERE source_id = ? AND target_id = ?",
			[fromId, toId],
		);
		await this.db.run(
			`INSERT INTO memory_associations (id, source_id, target_id, strength)
       VALUES (?, ?, ?, ?)`,
			[edgeId, fromId, toId, weight],
		);
	}

	async getNeighbors(
		nodeId: string,
		minWeight = 0,
		maxDepth = 1,
	): Promise<
		Array<{ id: string; relation: string; weight: number; path: string[] }>
	> {
		const results: Array<{
			id: string;
			relation: string;
			weight: number;
			path: string[];
		}> = [];
		const visited = new Set<string>();

		type QueueItem = { id: string; depth: number; path: string[] };
		const queue: QueueItem[] = [{ id: nodeId, depth: 0, path: [nodeId] }];
		visited.add(nodeId);

		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) continue;
			if (current.depth >= maxDepth) continue;

			const edges = await this.db.all<{
				source_id: string;
				target_id: string;
				strength: number;
			}>(
				"SELECT source_id, target_id, strength FROM memory_associations WHERE source_id = ? AND strength >= ?",
				[current.id, minWeight],
			);

			for (const edge of edges) {
				if (!visited.has(edge.target_id)) {
					visited.add(edge.target_id);
					const nextPath = [...current.path, edge.target_id];
					results.push({
						id: edge.target_id,
						relation: "associated",
						weight: edge.strength,
						path: nextPath,
					});
					queue.push({
						id: edge.target_id,
						depth: current.depth + 1,
						path: nextPath,
					});
				}
			}
		}

		return results;
	}

	async pruneEdges(threshold: number): Promise<number> {
		const row = await this.db.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM memory_associations WHERE strength < ?",
			[threshold],
		);
		const count = row?.count ?? 0;
		await this.db.run("DELETE FROM memory_associations WHERE strength < ?", [
			threshold,
		]);
		return count;
	}
}
