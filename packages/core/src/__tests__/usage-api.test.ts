import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../ai/usage-store.js";
import { getDefaults } from "../config/defaults.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";
import { TransportServer } from "../transport/server.js";

describe("usage API", () => {
	let db: DatabaseAdapter | undefined;
	let server: TransportServer | undefined;

	afterEach(async () => {
		await server?.stop();
		await db?.close();
		server = undefined;
		db = undefined;
	});

	it("returns multimedia aggregates, series, and downloadable exports", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const usageStore = new UsageStore(db);
		await usageStore.recordMedia({
			id: "video:api-job",
			mediaType: "video",
			provider: "vertex",
			model: "veo-api-test",
			status: "succeeded",
			jobId: "api-job",
			requestedOutputs: 1,
			outputCount: 1,
			requestedDurationSeconds: 8,
			generatedDurationSeconds: 8,
		});
		await db.run(
			`INSERT INTO ai_usage_events
				(event_id, provider, model, total_tokens, estimated_cost, cost_source)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			["llm:api-call", "openai", "test-model", 12, 0, "unknown"],
		);
		server = new TransportServer({ port: 0, host: "127.0.0.1" });
		server.setSystemContext({ config: getDefaults(), usageStore });
		await server.start();
		const holder = server as unknown as { httpServer: Server | null };
		const address = holder.httpServer?.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const usageResponse = await fetch(`${baseUrl}/api/usage`);
		expect(usageResponse.status).toBe(200);
		const usage = (await usageResponse.json()) as Record<string, unknown>;
		expect(usage.multimedia).toMatchObject({
			requests: 1,
			outputs: 1,
			generatedDurationSeconds: 8,
			unknownCostEvents: 1,
		});
		expect(usage.series).toEqual([
			expect.objectContaining({ mediaRequests: 1, mediaOutputs: 1 }),
		]);

		const csvResponse = await fetch(
			`${baseUrl}/api/usage/export?format=csv`,
		);
		expect(csvResponse.status).toBe(200);
		expect(csvResponse.headers.get("content-type")).toContain("text/csv");
		expect(csvResponse.headers.get("content-disposition")).toContain(
			"octopus-usage-",
		);
		expect(await csvResponse.text()).toContain("video:api-job");

		const jsonResponse = await fetch(
			`${baseUrl}/api/usage/export?format=json`,
		);
		const exported = (await jsonResponse.json()) as { events: unknown[] };
		expect(exported.events).toHaveLength(2);

		const limitedResponse = await fetch(
			`${baseUrl}/api/usage/export?format=json&limit=1`,
		);
		const limited = (await limitedResponse.json()) as {
			events: unknown[];
			truncated: boolean;
		};
		expect(limited.events).toHaveLength(1);
		expect(limited.truncated).toBe(true);
		expect(
			(await fetch(`${baseUrl}/api/usage/export?limit=abc`)).status,
		).toBe(400);
		expect(
			(await fetch(`${baseUrl}/api/usage?mediaType=audio`)).status,
		).toBe(400);
		expect(
			(await fetch(`${baseUrl}/api/usage?from=not-a-date`)).status,
		).toBe(400);
		const today = new Date().toISOString().slice(0, 10);
		const sameDay = await fetch(
			`${baseUrl}/api/usage?from=${today}&to=${today}`,
		);
		expect((await sameDay.json()) as Record<string, unknown>).toMatchObject({
			multimedia: { requests: 1 },
		});
		expect(
			(
				await fetch(
					`${baseUrl}/api/usage?from=2026-08-02&to=2026-08-01`,
				)
			).status,
		).toBe(400);
		const capped = (await (
			await fetch(
				`${baseUrl}/api/usage?from=2020-01-01&to=${today}`,
			)
		).json()) as { seriesCapped: boolean };
		expect(capped.seriesCapped).toBe(true);
	});
});
