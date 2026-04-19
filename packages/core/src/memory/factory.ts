import type { DatabaseAdapter } from "../storage/database.js";
import { SqliteVectorStore } from "./sqlite-vss.js";
import type { VectorStore } from "./store.js";

export function createVectorStore(
	backend: string,
	db: DatabaseAdapter,
): VectorStore {
	if (backend === "sqlite-vss" || backend === "sqlite") {
		return new SqliteVectorStore(db);
	}
	throw new Error(`Unknown vector store backend: ${backend}`);
}
