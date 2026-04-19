import type React from "react";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../hooks/useApi.js";

interface MemoryStats {
	enabled: boolean;
	shortTerm: { maxTokens?: number; [key: string]: unknown };
	longTerm: {
		maxItems?: number;
		importanceThreshold?: number;
		[key: string]: unknown;
	};
	consolidation: { [key: string]: unknown };
	retrieval: {
		maxResults?: number;
		minRelevance?: number;
		[key: string]: unknown;
	};
}

interface SearchResult {
	query: string;
	results: SearchResultItem[];
}

interface SearchResultItem {
	type?: string;
	timestamp?: string;
	content?: string;
	[key: string]: unknown;
}

export const MemoryPage: React.FC = () => {
	const [stats, setStats] = useState<MemoryStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
	const [searching, setSearching] = useState(false);
	const [consolidating, setConsolidating] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	useEffect(() => {
		apiGet<MemoryStats>("/api/memory/stats")
			.then((s) => {
				setStats(s);
				setLoading(false);
			})
			.catch((e) => {
				setMsg(e.message);
				setLoading(false);
			});
	}, []);

	const handleSearch = async () => {
		if (!searchQuery.trim()) return;
		setSearching(true);
		try {
			const result = await apiGet<SearchResult>(
				`/api/memory/search?q=${encodeURIComponent(searchQuery)}`,
			);
			setSearchResults(result.results ?? []);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		} finally {
			setSearching(false);
		}
	};

	const handleConsolidate = async () => {
		setConsolidating(true);
		setMsg(null);
		try {
			await apiPost("/api/memory/consolidate");
			setMsg("✓ Consolidación completada");
		} catch (e) {
			setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setConsolidating(false);
		}
	};

	if (loading)
		return (
			<div style={{ padding: 40, color: "#666" }}>Cargando memoria...</div>
		);

	return (
		<div
			className="page-shell"
			style={{
				padding: "20px",
				maxWidth: 1220,
				margin: "0 auto",
				overflowY: "auto",
				height: "100%",
				width: "100%",
			}}
		>
			<h2 style={{ margin: "0 0 20px", fontSize: "1.3rem" }}>🧠 Memoria</h2>
			{msg && (
				<div
					style={{
						padding: "10px 16px",
						borderRadius: 8,
						marginBottom: 12,
						background: msg.startsWith("✓")
							? "rgba(0,230,118,0.1)"
							: "rgba(255,23,68,0.1)",
						color: msg.startsWith("✓") ? "#00e676" : "#ff1744",
						fontSize: "0.85rem",
					}}
				>
					{msg}
				</div>
			)}

			{/* Stats */}
			<div
				className="stats-grid"
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
					gap: 10,
					marginBottom: 20,
				}}
			>
				<StatCard
					icon="⚡"
					title="Habilitada"
					value={stats?.enabled ? "Sí" : "No"}
					color={stats?.enabled ? "#00e676" : "#ff1744"}
				/>
				<StatCard
					icon="📏"
					title="STM Max Tokens"
					value={stats?.shortTerm?.maxTokens ?? "—"}
				/>
				<StatCard
					icon="🗃️"
					title="LTM Max Items"
					value={stats?.longTerm?.maxItems?.toLocaleString() ?? "—"}
				/>
				<StatCard
					icon="🎯"
					title="Umbral Importancia"
					value={stats?.longTerm?.importanceThreshold ?? "—"}
				/>
				<StatCard
					icon="🔍"
					title="Resultados Max"
					value={stats?.retrieval?.maxResults ?? "—"}
				/>
				<StatCard
					icon="📊"
					title="Relevancia Min"
					value={stats?.retrieval?.minRelevance ?? "—"}
				/>
			</div>

			{/* Consolidate */}
			<div className="inline-actions" style={{ marginBottom: 20 }}>
				<button
					type="button"
					onClick={handleConsolidate}
					disabled={consolidating}
					style={{
						padding: "10px 20px",
						borderRadius: 8,
						border: "none",
						background: consolidating ? "#333" : "#533483",
						color: consolidating ? "#666" : "#fff",
						cursor: consolidating ? "not-allowed" : "pointer",
						fontWeight: 600,
					}}
				>
					{consolidating ? "Consolidando..." : "🔄 Consolidar ahora"}
				</button>
				<span style={{ fontSize: "0.78rem", color: "#666" }}>
					Transfiere recuerdos a corto plazo → largo plazo
				</span>
			</div>

			{/* Search */}
			<div
				style={{
					background: "#16213e",
					borderRadius: 8,
					border: "1px solid #0f3460",
					padding: 16,
					marginBottom: 20,
				}}
			>
				<h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
					🔍 Buscar en la Memoria
				</h3>
				<div className="input-row" style={{ display: "flex", gap: 8 }}>
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && handleSearch()}
						placeholder="Buscar recuerdos..."
						style={{
							flex: 1,
							padding: "10px 14px",
							borderRadius: 8,
							border: "1px solid #0f3460",
							background: "#1a1a2e",
							color: "#e0e0e0",
							fontSize: "0.9rem",
							outline: "none",
						}}
					/>
					<button
						type="button"
						onClick={handleSearch}
						disabled={searching}
						style={{
							padding: "10px 20px",
							borderRadius: 8,
							border: "none",
							background: "#533483",
							color: "#fff",
							cursor: "pointer",
							fontWeight: 600,
						}}
					>
						{searching ? "..." : "Buscar"}
					</button>
				</div>
				{searchResults.length > 0 && (
					<div style={{ marginTop: 12 }}>
						{searchResults.map((r, i) => (
							<div
								key={`result-${i}-${String(r.content ?? r.type ?? i).slice(0, 20)}`}
								style={{
									padding: 10,
									borderRadius: 6,
									background: "#1a1a2e",
									marginBottom: 6,
									borderLeft: "3px solid #533483",
								}}
							>
								<div
									style={{ fontSize: "0.8rem", color: "#888", marginBottom: 2 }}
								>
									{r.type ?? "memory"} ·{" "}
									{r.timestamp ? new Date(r.timestamp).toLocaleString() : ""}
								</div>
								<div style={{ fontSize: "0.9rem", color: "#e0e0e0" }}>
									{r.content ?? JSON.stringify(r)}
								</div>
							</div>
						))}
					</div>
				)}
				{searchResults.length === 0 && searchQuery && !searching && (
					<div style={{ marginTop: 12, color: "#666", fontSize: "0.85rem" }}>
						Sin resultados
					</div>
				)}
			</div>
		</div>
	);
};

const StatCard: React.FC<{
	icon: string;
	title: string;
	value: string | number;
	color?: string;
}> = ({ icon, title, value, color = "#e0e0e0" }) => (
	<div
		style={{
			padding: 14,
			borderRadius: 8,
			background: "#16213e",
			border: "1px solid #0f3460",
			textAlign: "center",
		}}
	>
		<div style={{ fontSize: "1.4rem", marginBottom: 4 }}>{icon}</div>
		<div style={{ fontSize: "0.75rem", color: "#666", marginBottom: 4 }}>
			{title}
		</div>
		<div style={{ fontSize: "1.1rem", fontWeight: 600, color }}>{value}</div>
	</div>
);
