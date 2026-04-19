import type React from "react";
import { useCallback, useState } from "react";
import { apiGet, apiPost } from "../hooks/useApi.js";

export const Memory: React.FC = () => {
	const [stats, setStats] = useState<Record<string, unknown> | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<
		Array<Record<string, unknown>>
	>([]);
	const [loading, setLoading] = useState(false);
	const [consolidating, setConsolidating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadStats = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await apiGet<Record<string, unknown>>("/api/memory/stats");
			setStats(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load stats");
		} finally {
			setLoading(false);
		}
	}, []);

	const handleSearch = useCallback(async () => {
		if (!searchQuery.trim()) return;
		setLoading(true);
		setError(null);
		try {
			const data = await apiGet<{ results: Array<Record<string, unknown>> }>(
				`/api/memory/search?q=${encodeURIComponent(searchQuery)}`,
			);
			setSearchResults(data.results ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Search failed");
		} finally {
			setLoading(false);
		}
	}, [searchQuery]);

	const handleConsolidate = useCallback(async () => {
		setConsolidating(true);
		setError(null);
		try {
			await apiPost("/api/memory/consolidate");
			await loadStats();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Consolidation failed");
		} finally {
			setConsolidating(false);
		}
	}, [loadStats]);

	return (
		<div
			style={{
				padding: "24px",
				height: "100%",
				backgroundColor: "#0f1117",
				color: "#e4e4e7",
				fontFamily: "Inter, system-ui, sans-serif",
				overflowY: "auto",
			}}
		>
			<h2 style={{ margin: "0 0 8px 0", fontSize: "20px" }}>Memory Explorer</h2>
			<p style={{ color: "#71717a", marginBottom: "24px", fontSize: "14px" }}>
				View and manage Octopus AI's short-term and long-term memory.
			</p>

			{error && (
				<div
					style={{
						padding: "12px",
						backgroundColor: "#450a0a",
						borderRadius: "8px",
						marginBottom: "16px",
						color: "#fca5a5",
					}}
				>
					{error}
				</div>
			)}

			<div style={{ display: "flex", gap: "12px", marginBottom: "24px" }}>
				<button
					type="button"
					onClick={loadStats}
					disabled={loading}
					style={{
						padding: "8px 16px",
						borderRadius: "8px",
						backgroundColor: "#3b82f6",
						color: "#fff",
						border: "none",
						cursor: "pointer",
						fontSize: "13px",
					}}
				>
					{loading ? "Loading..." : "Load Stats"}
				</button>
				<button
					type="button"
					onClick={handleConsolidate}
					disabled={consolidating}
					style={{
						padding: "8px 16px",
						borderRadius: "8px",
						backgroundColor: "#7c3aed",
						color: "#fff",
						border: "none",
						cursor: "pointer",
						fontSize: "13px",
					}}
				>
					{consolidating ? "Consolidating..." : "Consolidate Memory"}
				</button>
			</div>

			{stats && (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
						gap: "12px",
						marginBottom: "24px",
					}}
				>
					{Object.entries(stats).map(([key, value]) => (
						<div
							key={key}
							style={{
								padding: "16px",
								backgroundColor: "#18181b",
								borderRadius: "8px",
								border: "1px solid #27272a",
							}}
						>
							<div
								style={{
									fontSize: "12px",
									color: "#71717a",
									marginBottom: "4px",
								}}
							>
								{key}
							</div>
							<div style={{ fontSize: "14px", fontWeight: 600 }}>
								{typeof value === "object"
									? JSON.stringify(value)
									: String(value)}
							</div>
						</div>
					))}
				</div>
			)}

			<div
				style={{
					backgroundColor: "#18181b",
					borderRadius: "8px",
					border: "1px solid #27272a",
					padding: "20px",
				}}
			>
				<h3 style={{ margin: "0 0 16px 0", fontSize: "16px" }}>
					Search Memory
				</h3>
				<div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && handleSearch()}
						placeholder="Search memories..."
						style={{
							flex: 1,
							padding: "8px 12px",
							borderRadius: "8px",
							border: "1px solid #27272a",
							backgroundColor: "#0f1117",
							color: "#e4e4e7",
							fontSize: "13px",
							outline: "none",
						}}
					/>
					<button
						type="button"
						onClick={handleSearch}
						style={{
							padding: "8px 16px",
							borderRadius: "8px",
							backgroundColor: "#3b82f6",
							color: "#fff",
							border: "none",
							cursor: "pointer",
							fontSize: "13px",
						}}
					>
						Search
					</button>
				</div>

				{searchResults.length > 0 ? (
					<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
						{searchResults.map((result, i) => (
							<div
								key={`result-${String(result.id ?? i)}`}
								style={{
									padding: "12px",
									backgroundColor: "#0f1117",
									borderRadius: "6px",
									border: "1px solid #27272a",
									fontSize: "13px",
									whiteSpace: "pre-wrap",
								}}
							>
								{JSON.stringify(result, null, 2)}
							</div>
						))}
					</div>
				) : (
					<p style={{ color: "#52525b", fontSize: "13px" }}>
						No results yet. Try searching for something.
					</p>
				)}
			</div>
		</div>
	);
};
