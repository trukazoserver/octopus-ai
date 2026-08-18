import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppChannel } from "../channels/whatsapp/index.js";

describe("WhatsAppChannel", () => {
	it("rejects non-canonical credential deletion before touching the socket", async () => {
		const channel = new WhatsAppChannel(
			"whatsapp",
			join(process.cwd(), "unrelated-auth"),
		);
		const logout = vi.fn(async () => undefined);
		const end = vi.fn();
		(channel as unknown as { sock: unknown }).sock = { logout, end };

		await expect(channel.logout()).rejects.toThrow(
			"can only delete the canonical",
		);
		expect(logout).not.toHaveBeenCalled();
		expect(end).not.toHaveBeenCalled();
	});

	it("starts with a truthful disconnected status and no QR", () => {
		const channel = new WhatsAppChannel("whatsapp", "unused");
		expect(channel.getStatus()).toEqual({
			status: "disconnected",
			connected: false,
			qr: undefined,
		});
	});
});
