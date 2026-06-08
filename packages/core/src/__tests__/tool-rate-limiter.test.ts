import { describe, expect, it } from "vitest";
import { ToolRateLimiter } from "../tools/rate-limiter.js";

describe("ToolRateLimiter", () => {
	it("serializes calls to the same media tool", async () => {
		const limiter = new ToolRateLimiter({
			enabled: true,
			mediaDefault: {
				minIntervalMs: 10,
				maxConcurrent: 1,
				queueTimeoutMs: 1000,
			},
		});
		let running = 0;
		let maxRunning = 0;
		const starts: number[] = [];

		const work = () =>
			limiter.run("veo-video-generator", true, async () => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				starts.push(Date.now());
				await new Promise((resolve) => setTimeout(resolve, 5));
				running -= 1;
				return "ok";
			});

		await Promise.all([work(), work()]);

		expect(maxRunning).toBe(1);
		expect(starts).toHaveLength(2);
		expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(10);
	});

	it("does not throttle non-media tools without an explicit rule", async () => {
		const limiter = new ToolRateLimiter({ enabled: true });
		let running = 0;
		let maxRunning = 0;

		const work = () =>
			limiter.run("read_file", false, async () => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				running -= 1;
				return "ok";
			});

		await Promise.all([work(), work()]);

		expect(maxRunning).toBe(2);
	});
});
