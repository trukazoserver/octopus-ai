import { describe, expect, it } from "vitest";
import { assertSafeObjectTree } from "../config/object-safety.js";
import {
	asBackgroundDeliveryContext,
	createDeliveryContext,
} from "../delivery/context.js";
import { buildDockerArgs } from "../tools/sandbox.js";

describe("frictionless security and delivery context", () => {
	it("rejects prototype pollution keys without modifying Object.prototype", () => {
		expect(() =>
			assertSafeObjectTree(
				JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
			),
		).toThrow("Unsafe object key");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("passes arbitrary shell syntax as one Docker argument", () => {
		const command =
			"printf '%s' \"$(touch /tmp/inside-container)\" | sed s/x/y/";
		const args = buildDockerArgs({
			command,
			image: "node:20-slim",
			memoryLimit: "512m",
			mounts: [
				{ host: "C:/work space", container: "/workspace", readonly: true },
			],
		});
		expect(args.slice(-4)).toEqual(["node:20-slim", "sh", "-c", command]);
		expect(args).toContain("C:/work space:/workspace:ro");
		expect(() =>
			buildDockerArgs({
				command: "echo ok",
				image: "--privileged",
				memoryLimit: "1g",
			}),
		).toThrow("Invalid Docker image");
	});

	it("keeps verified owner capabilities while adapting delivery by channel", () => {
		const web = createDeliveryContext({
			channel: "web",
			ownerVerified: true,
			principalId: "owner",
		});
		const telegram = createDeliveryContext({
			channel: "telegram",
			ownerVerified: true,
			principalId: "owner",
		});
		expect(web.trustProfile).toBe("remote_owner");
		expect(web.capabilities.files).toBe(true);
		expect(telegram.capabilities.maxTextChars).toBe(4096);
		expect(telegram.capabilities.localPathsAccessible).toBe(false);
		expect(asBackgroundDeliveryContext(telegram)?.trustProfile).toBe(
			"background_agent",
		);
	});
});
