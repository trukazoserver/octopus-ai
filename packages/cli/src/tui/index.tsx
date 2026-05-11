import { render } from "ink";
import React from "react";
import type { ConsoleSession } from "../runtime/console-session.js";
import { OctopusApp } from "./OctopusApp.js";

export async function runOctopusTui(session: ConsoleSession): Promise<void> {
	const instance = render(<OctopusApp session={session} />);
	await instance.waitUntilExit();
}
