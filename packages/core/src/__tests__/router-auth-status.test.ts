import { describe, expect, it } from "vitest";
import { LLMRouter } from "../ai/router.js";

function makeRouter(): LLMRouter {
	return new LLMRouter({ providers: {} });
}

describe("LLMRouter auth-status surfacing", () => {
	it("starts empty", () => {
		expect(makeRouter().getAuthStatus()).toEqual({});
	});

	it("marks a provider as requiring re-login", () => {
		const router = makeRouter();
		router.markAuthStatus("openai", {
			requiresRelogin: true,
			reason: "refresh token revoked",
		});
		const status = router.getAuthStatus();
		expect(status.openai?.requiresRelogin).toBe(true);
		expect(status.openai?.reason).toBe("refresh token revoked");
		expect(typeof status.openai?.at).toBe("number");
	});

	it("clears a provider's auth-status", () => {
		const router = makeRouter();
		router.markAuthStatus("openai", { requiresRelogin: true });
		expect(router.getAuthStatus().openai?.requiresRelogin).toBe(true);
		router.clearAuthStatus("openai");
		expect(router.getAuthStatus()).toEqual({});
	});

	it("keeps other providers independent", () => {
		const router = makeRouter();
		router.markAuthStatus("openai", { requiresRelogin: true });
		router.markAuthStatus("zhipu", { requiresRelogin: false });
		const status = router.getAuthStatus();
		expect(status.openai?.requiresRelogin).toBe(true);
		expect(status.zhipu?.requiresRelogin).toBe(false);
	});
});
