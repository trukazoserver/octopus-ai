import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";

export class KnowledgeGraph {
	constructor(
		private db: DatabaseAdapter,
		private embeddingDimensions = 1024,
	) {}

	async addNode(
		id: string,
		label: string,
		type: string,
		properties: Record<string, unknown>,
	): Promise<void> {
		const propsJson = JSON.stringify(properties);
		const dummyEmbedding = new Float32Array(this.embeddingDimensions);
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
		await this.ensureAssociationTable();
		const edgeId = nanoid();
		await this.db.run(
			"DELETE FROM memory_associations WHERE source_id = ? AND target_id = ?",
			[fromId, toId],
		);
		await this.db.run(
			`INSERT INTO memory_associations (id, source_id, target_id, relation, strength)
       VALUES (?, ?, ?, ?, ?)`,
			[edgeId, fromId, toId, relation, weight],
		);
	}

	async getNeighbors(
		nodeId: string,
		minWeight = 0,
		maxDepth = 1,
	): Promise<
		Array<{ id: string; relation: string; weight: number; path: string[] }>
	> {
		await this.ensureAssociationTable();
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
				relation: string;
				strength: number;
			}>(
				"SELECT source_id, target_id, relation, strength FROM memory_associations WHERE source_id = ? AND strength >= ?",
				[current.id, minWeight],
			);

			for (const edge of edges) {
				if (!visited.has(edge.target_id)) {
					visited.add(edge.target_id);
					const nextPath = [...current.path, edge.target_id];
					results.push({
						id: edge.target_id,
						relation: edge.relation || "associated",
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
		await this.ensureAssociationTable();
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

	private async ensureAssociationTable(): Promise<void> {
		const columns = await this.db.all<{ name: string }>(
			"PRAGMA table_info(memory_associations)",
		);
		const hasTable = columns.length > 0;
		const hasId = columns.some((column) => column.name === "id");
		const hasLegacyColumns =
			columns.some((column) => column.name === "from_id") &&
			columns.some((column) => column.name === "to_id");
		const strengthSelect = columns.some((column) => column.name === "strength")
			? "strength"
			: "1 as strength";
		const createdAtSelect = columns.some(
			(column) => column.name === "created_at",
		)
			? "created_at"
			: "NULL as created_at";
		let legacyRows: Array<{
			from_id: string;
			to_id: string;
			strength?: number;
			created_at?: string;
		}> = [];

		if (hasTable && !hasId && hasLegacyColumns) {
			legacyRows = await this.db.all(
				`SELECT from_id, to_id, ${strengthSelect}, ${createdAtSelect} FROM memory_associations`,
			);
			await this.db.run("DROP TABLE memory_associations");
		} else if (hasTable && !hasId) {
			await this.db.run("DROP TABLE memory_associations");
		}

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS memory_associations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'associated',
        strength REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
		);

		const currentColumns = await this.db.all<{ name: string }>(
			"PRAGMA table_info(memory_associations)",
		);
		if (!currentColumns.find((column) => column.name === "relation")) {
			await this.db.run(
				"ALTER TABLE memory_associations ADD COLUMN relation TEXT NOT NULL DEFAULT 'associated'",
			);
		}

		for (const row of legacyRows) {
			await this.db.run(
				`INSERT INTO memory_associations (id, source_id, target_id, relation, strength, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
				[
					nanoid(),
					row.from_id,
					row.to_id,
					"associated",
					row.strength ?? 1,
					row.created_at ?? new Date().toISOString(),
				],
			);
		}
	}
}
