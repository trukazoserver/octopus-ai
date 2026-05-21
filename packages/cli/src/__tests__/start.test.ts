import { describe, expect, it } from "vitest";
import type { OctopusSystem } from "../bootstrap.js";
import { buildTransportSystemContext } from "../commands/start.js";

describe("start command transport context", () => {
	it("includes advanced memory services in TransportServer context", () => {
		const system = {
			config: { marker: "config" },
			db: { marker: "db" },
			router: { marker: "router" },
			ltm: { marker: "ltm" },
			memoryOrchestrator: { marker: "memoryOrchestrator" },
			contextAssembler: { marker: "contextAssembler" },
			memoryConsolidator: { marker: "memoryConsolidator" },
			skillRegistry: { marker: "skillRegistry" },
			pluginRegistry: { marker: "pluginRegistry" },
			codeExecutor: { marker: "codeExecutor" },
			chatManager: { marker: "chatManager" },
			agentManager: { marker: "agentManager" },
			taskManager: { marker: "taskManager" },
			automationManager: { marker: "automationManager" },
			envVarManager: { marker: "envVarManager" },
			mcpManager: { marker: "mcpManager" },
			refreshBrowserTools: async () => true,
			reloadDynamicTool: async () => true,
			embedFn: async () => [1],
			userProfileManager: { marker: "userProfileManager" },
			learningEngine: { marker: "learningEngine" },
			agentRuntime: { marker: "agentRuntime" },
			toolRegistry: { marker: "toolRegistry" },
			dailyMemory: { marker: "dailyMemory" },
		} as unknown as OctopusSystem;
		const chatExecutionManager = { marker: "chatExecutionManager" };

		const context = buildTransportSystemContext(
			system,
			chatExecutionManager as never,
		);

		expect(context).toEqual(
			expect.objectContaining({
				config: system.config,
				db: system.db,
				router: system.router,
				ltm: system.ltm,
				memoryOrchestrator: system.memoryOrchestrator,
				contextAssembler: system.contextAssembler,
				memoryConsolidator: system.memoryConsolidator,
				embedFn: system.embedFn,
				chatExecutionManager,
				agentRuntime: system.agentRuntime,
				toolRegistry: system.toolRegistry,
			}),
		);
	});
});
