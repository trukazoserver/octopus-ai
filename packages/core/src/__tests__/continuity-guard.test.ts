import { describe, expect, it } from "vitest";
import { ContinuityGuard } from "../agent/continuity-guard.js";

describe("ContinuityGuard stall detection", () => {
	it("forces a retry when the turn promises an action (ES) but emits no tool call", () => {
		const guard = new ContinuityGuard({ maxStallForcings: 3 });
		const decision = guard.shouldForceActOnStall(
			"Encontré el problema. No incluye veo-3.1-generate-001. Lo agrego ahora:",
			"stop",
		);
		expect(decision.force).toBe(true);
		expect(decision.repeated).toBe(false);
		expect(decision.exhausted).toBe(false);
		expect(decision.reason).toBe("promised-action-no-toolcall");
	});

	it("forces a retry on English action promises", () => {
		const guard = new ContinuityGuard();
		expect(
			guard.shouldForceActOnStall("Let me edit the config file now.", "stop")
				.force,
		).toBe(true);
		expect(
			guard.shouldForceActOnStall("I'll add the missing entry.", "stop").force,
		).toBe(true);
	});

	it("detects repeated text as a stall", () => {
		const guard = new ContinuityGuard({ maxStallForcings: 3 });
		const first = guard.shouldForceActOnStall("Lo agrego ahora:", "stop");
		expect(first.force).toBe(true);
		guard.recordStall("Lo agrego ahora:");

		// Whitespace/case differences collapse to the same signature.
		const second = guard.shouldForceActOnStall("lo   agrego   ahora:", "stop");
		expect(second.force).toBe(true);
		expect(second.repeated).toBe(true);
		expect(second.reason).toBe("repeated-text-no-action");
	});

	it("does not force on a neutral final response with no action promise", () => {
		const guard = new ContinuityGuard();
		const decision = guard.shouldForceActOnStall(
			"Listo, ya terminé el análisis del problema.",
			"stop",
		);
		expect(decision.force).toBe(false);
		expect(decision.reason).toBe("no-signal");
	});

	it("does not treat a descriptive 'ahora:' heading as an action promise", () => {
		const guard = new ContinuityGuard();
		const decision = guard.shouldForceActOnStall(
			"Así luce el diseño completo ahora:",
			"stop",
		);
		expect(decision.force).toBe(false);
		expect(decision.reason).toBe("no-signal");
	});

	it("forces a retry when completed artifact work is claimed without a tool call", () => {
		const guard = new ContinuityGuard();
		const decision = guard.shouldForceActOnStall(
			"He generado una imagen de los novios, reemplacé la ilustración y añadí el banner al HTML.",
			"stop",
		);
		expect(decision.force).toBe(true);
		expect(decision.reason).toBe("claimed-action-no-toolcall");
	});

	it("detects web-search activity text that ends without a tool call", () => {
		const guard = new ContinuityGuard();
		const decision = guard.shouldForceActOnStall(
			"Para empezar, voy a buscar música instrumental. Actividad actual: Iniciando búsqueda de música instrumental en la web.",
			"stop",
		);
		expect(decision.force).toBe(true);
		expect(decision.reason).toBe("promised-action-no-toolcall");
	});

	it("accepts a completed artifact claim after verified tool progress", () => {
		const guard = new ContinuityGuard();
		const decision = guard.shouldForceActOnStall(
			"Listo, edité el archivo correctamente.",
			"stop",
			true,
		);
		expect(decision.force).toBe(false);
	});

	it("does not confuse completed analysis with an external artifact change", () => {
		const guard = new ContinuityGuard();
		const decision = guard.shouldForceActOnStall(
			"Ya terminé el análisis del problema y estas son mis conclusiones.",
			"stop",
		);
		expect(decision.force).toBe(false);
	});

	it("leaves length-truncated responses to the length-continuation path", () => {
		const guard = new ContinuityGuard();
		const decision = guard.shouldForceActOnStall(
			"Lo agrego ahora: (respuesta truncada)",
			"length",
		);
		expect(decision.force).toBe(false);
		expect(decision.reason).toBe("length-handled-elsewhere");
	});

	it("reports exhausted once the retry budget is spent", () => {
		const guard = new ContinuityGuard({ maxStallForcings: 2 });
		// First force + record
		expect(guard.shouldForceActOnStall("Lo agrego ahora:", "stop").force).toBe(
			true,
		);
		guard.recordStall("Lo agrego ahora:");
		// Second force + record (1 < 2)
		expect(guard.shouldForceActOnStall("Lo agrego ahora:", "stop").force).toBe(
			true,
		);
		guard.recordStall("Lo agrego ahora:");
		// Third attempt: budget spent (2 >= 2)
		const decision = guard.shouldForceActOnStall("Lo agrego ahora:", "stop");
		expect(decision.force).toBe(false);
		expect(decision.exhausted).toBe(true);
	});

	it("clearStall resets the retry budget and signatures", () => {
		const guard = new ContinuityGuard({ maxStallForcings: 1 });
		expect(guard.shouldForceActOnStall("Lo agrego ahora:", "stop").force).toBe(
			true,
		);
		guard.recordStall("Lo agrego ahora:");
		expect(guard.stallForceCount).toBe(1);
		// Budget spent
		expect(
			guard.shouldForceActOnStall("Lo agrego ahora:", "stop").exhausted,
		).toBe(true);

		guard.clearStall();
		expect(guard.stallForceCount).toBe(0);
		// Fresh budget: a promise forces again, and the old signature is forgotten.
		const decision = guard.shouldForceActOnStall("Lo agrego ahora:", "stop");
		expect(decision.force).toBe(true);
		expect(decision.repeated).toBe(false);
	});

	it("disables stall detection when stallDetection is false", () => {
		const guard = new ContinuityGuard({ stallDetection: false });
		const decision = guard.shouldForceActOnStall("Lo agrego ahora:", "stop");
		expect(decision.force).toBe(false);
		expect(decision.reason).toBe("disabled");
	});

	it("reset() clears stall state for a new task", () => {
		const guard = new ContinuityGuard({ maxStallForcings: 1 });
		guard.recordStall("Lo agrego ahora:");
		expect(guard.stallForceCount).toBe(1);

		guard.reset("nueva tarea");
		expect(guard.stallForceCount).toBe(0);
		// After reset a repeated text is not flagged as repeated.
		const decision = guard.shouldForceActOnStall("Lo agrego ahora:", "stop");
		expect(decision.force).toBe(true);
		expect(decision.repeated).toBe(false);
	});

	it("buildForceActPrompt is imperative and mentions the final-attempt caveat on repeats", () => {
		const guard = new ContinuityGuard();
		const once = guard.buildForceActPrompt(
			"promised-action-no-toolcall",
			false,
		);
		expect(once).toContain("EXECUTE NOW");
		expect(once).not.toContain("final forced attempt");

		const again = guard.buildForceActPrompt("repeated-text-no-action", true);
		expect(again).toContain("final forced attempt");
	});

	it("corrects unverified completed-work claims in the forced prompt", () => {
		const guard = new ContinuityGuard();
		const prompt = guard.buildForceActPrompt(
			"claimed-action-no-toolcall",
			false,
			{ content: "He generado la imagen y actualizado el HTML", attempt: 1 },
		);
		expect(prompt).toContain("claimed");
		expect(prompt).toContain("unverified");
		expect(prompt).toContain("must not be presented as completed");
	});

	it("injects a write_file scaffold when the stalled content signals edit intent", () => {
		const guard = new ContinuityGuard();
		const prompt = guard.buildForceActPrompt(
			"promised-action-no-toolcall",
			false,
			{
				content: "Voy a agregar veo-3.1-generate-001 al index.mjs",
				attempt: 1,
			},
		);
		expect(prompt).toContain("write_file");
		expect(prompt).toContain('"path"');
		expect(prompt).toContain("`content`");
	});

	it("keeps the generic nudge when the stalled content shows no edit intent", () => {
		const guard = new ContinuityGuard();
		const prompt = guard.buildForceActPrompt(
			"promised-action-no-toolcall",
			false,
			{ content: "Lo envío ahora", attempt: 1 },
		);
		expect(prompt).toContain("EXECUTE NOW");
		expect(prompt).not.toContain("write_file");
	});

	it("escalates to a no-prose, tool-call-only demand on attempt >= 2", () => {
		const guard = new ContinuityGuard();
		const prompt = guard.buildForceActPrompt("repeated-text-no-action", true, {
			content: "Lo agrego ahora:",
			attempt: 2,
		});
		expect(prompt).toContain("attempt #2");
		expect(prompt).toContain("ONLY the tool call");
	});
});
