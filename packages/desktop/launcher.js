// Electron launcher that removes ELECTRON_RUN_AS_NODE from the environment.
// VS Code and other Electron-based editors set this variable, which prevents
// child Electron processes from starting as browser apps.
"use strict";
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require("child_process");
const path = require("path");

// Get electron binary path (npm electron package returns the binary path)
let electronBinary;
try {
	electronBinary = require("electron");
} catch {
	console.error("Error: electron package not found. Run 'pnpm install' first.");
	process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
	args.push(".");
}

const child = spawn(electronBinary, args, {
	stdio: "inherit",
	windowsHide: false,
	env: process.env,
});

child.on("close", (code, signal) => {
	if (code === null) {
		console.error(`${electronBinary} exited with signal`, signal);
		process.exit(1);
	}
	process.exit(code);
});

const handleSignal = (signal) => {
	process.on(signal, () => {
		if (!child.killed) {
			child.kill(signal);
		}
	});
};
handleSignal("SIGINT");
handleSignal("SIGTERM");
