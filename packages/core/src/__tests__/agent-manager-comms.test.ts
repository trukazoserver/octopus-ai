import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../agent/manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

describe("AgentManager communication and spawn", () => {
	let db: DatabaseAdapter;
	let manager: AgentManager;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		manager = new AgentManager(db);
	});

	afterEach(async () => {
		await db.close();
	});

	it("persists direct messages and filters inbox by target agent", async () => {
		const from = await manager.createAgent({ name: "From" });
		const to = await manager.createAgent({ name: "To" });
		const other = await manager.createAgent({ name: "Other" });

		const message = await manager.sendMessage({
			fromAgentId: from.id,
			toAgentId: to.id,
			content: "handoff",
		});

		expect(message.content).toBe("handoff");
		expect(await manager.listInbox({ agentId: to.id })).toHaveLength(1);
		expect(await manager.listInbox({ agentId: other.id })).toHaveLength(0);
	});

	it("includes broadcasts only when requested", async () => {
		const from = await manager.createAgent({ name: "From" });
		const to = await manager.createAgent({ name: "To" });
		await manager.sendMessage({ fromAgentId: from.id, content: "all hands" });

		expect(await manager.listInbox({ agentId: to.id })).toHaveLength(0);
		expect(
			await manager.listInbox({ agentId: to.id, includeBroadcasts: true }),
		).toHaveLength(1);
	});

	it("marks only direct target messages as read", async () => {
		const from = await manager.createAgent({ name: "From" });
		const to = await manager.createAgent({ name: "To" });
		const other = await manager.createAgent({ name: "Other" });
		const message = await manager.sendMessage({
			fromAgentId: from.id,
			toAgentId: to.id,
			content: "read me",
		});

		expect(await manager.markMessagesRead(other.id, [message.id])).toBe(0);
		expect(await manager.markMessagesRead(to.id, [message.id])).toBe(1);
		expect(
			await manager.listInbox({ agentId: to.id, unreadOnly: true }),
		).toHaveLength(0);
	});

	it("enforces parent spawn depth", async () => {
		const parent = await manager.createAgent({
			name: "Parent",
			canSpawnSubagents: true,
			maxSpawnDepth: 1,
		});

		const child = await manager.spawnSubagent({
			parentAgentId: parent.id,
			name: "Child",
			role: "researcher",
		});

		expect(child.parent_id).toBe(parent.id);
		await expect(
			manager.spawnSubagent({
				parentAgentId: child.id,
				name: "Grandchild",
				role: "researcher",
			}),
		).rejects.toThrow(/spawn|depth/i);
	});
});
