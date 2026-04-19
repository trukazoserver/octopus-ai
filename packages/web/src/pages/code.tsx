import type React from "react";
import { useCallback, useState } from "react";
import { apiPost } from "../hooks/useApi.js";

const LANGUAGES = ["javascript", "typescript", "python", "bash"];

export const CodePage: React.FC = () => {
	const [code, setCode] = useState("");
	const [language, setLanguage] = useState("javascript");
	const [output, setOutput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [executing, setExecuting] = useState(false);
	const [executionTime, setExecutionTime] = useState<number | null>(null);

	const [toolName, setToolName] = useState("");
	const [toolDescription, setToolDescription] = useState("");
	const [toolCode, setToolCode] = useState("");
	const [creating, setCreating] = useState(false);
	const [toolMessage, setToolMessage] = useState<string | null>(null);

	const [activeSection, setActiveSection] = useState<"execute" | "create">(
		"execute",
	);

	const handleExecute = useCallback(async () => {
		if (!code.trim()) return;
		setExecuting(true);
		setError(null);
		setOutput("");
		setExecutionTime(null);
		try {
			const result = await apiPost("/api/code/execute", {
				code,
				language,
				timeout: 30000,
			});
			const stdout = typeof result.stdout === "string" ? result.stdout : "";
			const stderr = typeof result.stderr === "string" ? result.stderr : "";
			const execTime =
				typeof result.executionTime === "number" ? result.executionTime : null;
			const success = result.success === true;
			setOutput(stdout);
			if (stderr) {
				setOutput((prev) => `${prev}\n[stderr]\n${stderr}`);
			}
			setExecutionTime(execTime);
			if (!success) {
				setError("Execution completed with errors");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Execution failed");
		} finally {
			setExecuting(false);
		}
	}, [code, language]);

	const handleCreateTool = useCallback(async () => {
		if (!toolName.trim() || !toolDescription.trim() || !toolCode.trim()) return;
		setCreating(true);
		setToolMessage(null);
		try {
			const result = await apiPost("/api/code/create-tool", {
				name: toolName,
				description: toolDescription,
				code: toolCode,
				language: "javascript",
			});
			if (result.success) {
				setToolMessage(`Tool '${toolName}' created successfully!`);
				setToolName("");
				setToolDescription("");
				setToolCode("");
			} else {
				setToolMessage(`Error: ${result.error ?? "Unknown error"}`);
			}
		} catch (err) {
			setToolMessage(
				err instanceof Error ? err.message : "Failed to create tool",
			);
		} finally {
			setCreating(false);
		}
	}, [toolName, toolDescription, toolCode]);

	const section = {
		padding: "20px",
		backgroundColor: "#18181b",
		borderRadius: "10px",
		border: "1px solid #27272a",
		marginBottom: "20px",
	};

	const textareaStyle = {
		width: "100%",
		minHeight: "200px",
		padding: "12px",
		borderRadius: "8px",
		border: "1px solid #27272a",
		backgroundColor: "#0f1117",
		color: "#e4e4e7",
		fontFamily: '"JetBrains Mono", "Fira Code", monospace',
		fontSize: "13px",
		lineHeight: "1.5",
		resize: "vertical" as const,
		outline: "none",
		boxSizing: "border-box" as const,
	};

	return (
		<div
			className="page-shell page-shell--xl"
			style={{ padding: "24px", overflowY: "auto", height: "100%" }}
		>
			<div
				className="page-header"
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "24px",
				}}
			>
				<div>
					<h2
						style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: 700 }}
					>
						Code & Tools
					</h2>
					<p style={{ color: "#71717a", margin: 0, fontSize: "13px" }}>
						Execute code, create tools, and extend Octopus AI's capabilities
					</p>
				</div>
				<div className="toolbar-wrap" style={{ display: "flex", gap: "8px" }}>
					<button
						type="button"
						onClick={() => setActiveSection("execute")}
						style={{
							padding: "8px 16px",
							borderRadius: "8px",
							border: "none",
							cursor: "pointer",
							fontSize: "13px",
							backgroundColor:
								activeSection === "execute" ? "#3b82f6" : "#27272a",
							color: activeSection === "execute" ? "#fff" : "#a1a1aa",
						}}
					>
						Execute Code
					</button>
					<button
						type="button"
						onClick={() => setActiveSection("create")}
						style={{
							padding: "8px 16px",
							borderRadius: "8px",
							border: "none",
							cursor: "pointer",
							fontSize: "13px",
							backgroundColor:
								activeSection === "create" ? "#3b82f6" : "#27272a",
							color: activeSection === "create" ? "#fff" : "#a1a1aa",
						}}
					>
						Create Tool
					</button>
				</div>
			</div>

			{activeSection === "execute" && (
				<div style={section}>
					<h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>
						Execute Code
					</h3>
					<div
						className="toolbar-wrap"
						style={{
							display: "flex",
							gap: "8px",
							marginBottom: "12px",
							alignItems: "center",
						}}
					>
						<span style={{ fontSize: "13px", color: "#71717a" }}>
							Language:
						</span>
						{LANGUAGES.map((lang) => (
							<button
								key={lang}
								type="button"
								onClick={() => setLanguage(lang)}
								style={{
									padding: "4px 12px",
									borderRadius: "6px",
									border: "1px solid #27272a",
									backgroundColor:
										language === lang ? "#3b82f6" : "transparent",
									color: language === lang ? "#fff" : "#71717a",
									cursor: "pointer",
									fontSize: "12px",
								}}
							>
								{lang}
							</button>
						))}
					</div>
					<textarea
						value={code}
						onChange={(e) => setCode(e.target.value)}
						placeholder={`// Write your ${language} code here...\nconsole.log("Hello from Octopus AI!");`}
						style={textareaStyle}
					/>
					<div
						className="inline-actions"
						style={{
							marginTop: "12px",
							display: "flex",
							gap: "8px",
							alignItems: "center",
						}}
					>
						<button
							type="button"
							onClick={handleExecute}
							disabled={executing || !code.trim()}
							style={{
								padding: "10px 24px",
								borderRadius: "8px",
								border: "none",
								backgroundColor: executing ? "#3f3f46" : "#22c55e",
								color: "#fff",
								cursor: executing ? "not-allowed" : "pointer",
								fontSize: "14px",
								fontWeight: 600,
							}}
						>
							{executing ? "Running..." : "Run Code"}
						</button>
						{executionTime !== null && (
							<span style={{ fontSize: "12px", color: "#71717a" }}>
								Executed in {executionTime}ms
							</span>
						)}
					</div>

					{error && (
						<div
							style={{
								marginTop: "12px",
								padding: "12px",
								backgroundColor: "#450a0a",
								borderRadius: "8px",
								color: "#fca5a5",
								fontSize: "13px",
							}}
						>
							{error}
						</div>
					)}

					{output && (
						<div style={{ marginTop: "12px" }}>
							<div
								style={{
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Output:
							</div>
							<pre
								style={{
									padding: "12px",
									backgroundColor: "#0f1117",
									borderRadius: "8px",
									border: "1px solid #27272a",
									color: "#a1a1aa",
									fontSize: "13px",
									overflow: "auto",
									maxHeight: "300px",
									whiteSpace: "pre-wrap",
								}}
							>
								{output}
							</pre>
						</div>
					)}
				</div>
			)}

			{activeSection === "create" && (
				<div style={section}>
					<h3 style={{ margin: "0 0 12px 0", fontSize: "16px" }}>
						Create a New Tool
					</h3>
					<p
						style={{ color: "#71717a", fontSize: "13px", marginBottom: "16px" }}
					>
						Create a reusable tool that Octopus AI can use. The code must export
						a default async function.
					</p>

					<div
						className="responsive-grid-2"
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
							gap: "12px",
							marginBottom: "12px",
						}}
					>
						<div>
							<label
								htmlFor="tool-name"
								style={{
									display: "block",
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Tool Name
							</label>
							<input
								id="tool-name"
								type="text"
								value={toolName}
								onChange={(e) => setToolName(e.target.value)}
								placeholder="my-custom-tool"
								style={{
									width: "100%",
									padding: "8px 12px",
									borderRadius: "8px",
									border: "1px solid #27272a",
									backgroundColor: "#0f1117",
									color: "#e4e4e7",
									fontSize: "13px",
									outline: "none",
									boxSizing: "border-box",
								}}
							/>
						</div>
						<div>
							<label
								htmlFor="tool-description"
								style={{
									display: "block",
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								Description
							</label>
							<input
								id="tool-description"
								type="text"
								value={toolDescription}
								onChange={(e) => setToolDescription(e.target.value)}
								placeholder="What this tool does..."
								style={{
									width: "100%",
									padding: "8px 12px",
									borderRadius: "8px",
									border: "1px solid #27272a",
									backgroundColor: "#0f1117",
									color: "#e4e4e7",
									fontSize: "13px",
									outline: "none",
									boxSizing: "border-box",
								}}
							/>
						</div>
					</div>

					<label
						htmlFor="tool-code"
						style={{
							display: "block",
							fontSize: "12px",
							color: "#71717a",
							marginBottom: "4px",
						}}
					>
						Tool Code (must export default async function)
					</label>
					<textarea
						id="tool-code"
						value={toolCode}
						onChange={(e) => setToolCode(e.target.value)}
						placeholder={`export default async function(params) {\n  // Your tool logic here\n  return {\n    success: true,\n    output: "Result: " + JSON.stringify(params)\n  };\n}`}
						style={textareaStyle}
					/>

					<div
						className="inline-actions"
						style={{
							marginTop: "12px",
							display: "flex",
							gap: "8px",
							alignItems: "center",
						}}
					>
						<button
							type="button"
							onClick={handleCreateTool}
							disabled={creating || !toolName.trim() || !toolCode.trim()}
							style={{
								padding: "10px 24px",
								borderRadius: "8px",
								border: "none",
								backgroundColor: creating ? "#3f3f46" : "#7c3aed",
								color: "#fff",
								cursor: creating ? "not-allowed" : "pointer",
								fontSize: "14px",
								fontWeight: 600,
							}}
						>
							{creating ? "Creating..." : "Create Tool"}
						</button>
					</div>

					{toolMessage && (
						<div
							style={{
								marginTop: "12px",
								padding: "12px",
								borderRadius: "8px",
								backgroundColor: toolMessage.includes("Error")
									? "#450a0a"
									: "#052e16",
								color: toolMessage.includes("Error") ? "#fca5a5" : "#86efac",
								fontSize: "13px",
							}}
						>
							{toolMessage}
						</div>
					)}
				</div>
			)}
		</div>
	);
};
