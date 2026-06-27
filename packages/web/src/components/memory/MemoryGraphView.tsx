import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ============================================================
   MemoryGraphView — Obsidian-style force-directed graph
   Canvas renderer. No decorative effects.
   ============================================================ */

export interface GraphViewNode {
	id: string;
	label: string;
	type: string;
	source: string;
	weight: number;
	content: string;
	keywords: string[];
}
export interface GraphViewEdge {
	source: string;
	target: string;
	weight: number;
}

interface AugNode extends GraphViewNode {
	degree: number;
	centrality: number;
	cluster: string;
	r: number;
}
interface AugEdge {
	a: string;
	b: string;
	weight: number;
}

interface SimNode {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	fx: number | null;
	fy: number | null;
}

const CLUSTER_COLORS: Record<string, string> = {
	memory: "#7c93fb",
	learning: "#e3a85f",
	profile: "#74c79a",
	daily: "#d98ba8",
	shortTerm: "#86b6d6",
};
const FALLBACK_CLUSTER = "#9aa0aa";
const BG = "#08080a";
const EDGE_BASE = "rgba(180,180,180,0.14)";
const EDGE_LIT = "rgba(200,210,235,0.55)";
const EDGE_DIM = "rgba(120,120,130,0.05)";
const LABEL_COLOR = "#d6d6da";
const ACCENT = "#e3a85f";

const SOURCE_LABELS: Record<string, string> = {
	memory: "Largo plazo",
	learning: "Aprendizaje",
	profile: "Usuario",
	daily: "Diaria",
	shortTerm: "Corto plazo",
};

function clusterColor(source: string): string {
	return CLUSTER_COLORS[source] ?? FALLBACK_CLUSTER;
}

/* ---------- graph metrics + edge filtering (anti-hairball) ---------- */
function buildGraph(
	nodes: GraphViewNode[],
	edges: GraphViewEdge[],
	maxPerNode: number,
	minWeight: number,
): { nodes: AugNode[]; edges: AugEdge[] } {
	// dedupe + weight edges (weight = shared strength)
	const seen = new Set<string>();
	const weighted: AugEdge[] = [];
	for (const e of edges) {
		if (e.weight < minWeight) continue;
		const key =
			e.source < e.target
				? `${e.source}|${e.target}`
				: `${e.target}|${e.source}`;
		if (seen.has(key)) continue;
		seen.add(key);
		weighted.push({ a: e.source, b: e.target, weight: e.weight });
	}
	// limit per node: keep strongest maxPerNode
	const perNode = new Map<string, AugEdge[]>();
	for (const e of weighted) {
		if (!perNode.has(e.a)) perNode.set(e.a, []);
		if (!perNode.has(e.b)) perNode.set(e.b, []);
		const listA = perNode.get(e.a);
		const listB = perNode.get(e.b);
		if (listA) listA.push(e);
		if (listB) listB.push(e);
	}
	const keep = new Set<AugEdge>();
	for (const list of perNode.values()) {
		const top = list.sort((x, y) => y.weight - x.weight).slice(0, maxPerNode);
		for (const e of top) keep.add(e);
	}
	const finalEdges = weighted.filter((e) => keep.has(e));

	const degree = new Map<string, number>();
	for (const e of finalEdges) {
		degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
		degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
	}
	const maxDeg = Math.max(1, ...Array.from(degree.values()));

	const aug: AugNode[] = nodes.map((n) => {
		const d = degree.get(n.id) ?? 0;
		return {
			...n,
			degree: d,
			centrality: d / maxDeg,
			cluster: n.source,
			r: Math.max(3, Math.min(16, 3 + d * 1.9)),
		};
	});
	return { nodes: aug, edges: finalEdges };
}

/* ---------- force-directed simulation (persistent, d3-like) ---------- */
function createSimulation(
	ids: string[],
	links: Array<{ a: string; b: string }>,
	width: number,
	height: number,
): { nodes: Map<string, SimNode>; step: (alpha: number) => void } {
	const cx = width / 2;
	const cy = height / 2;
	const N = Math.max(ids.length, 1);
	const k = Math.sqrt((width * height) / N) * 0.55;
	// Seed on a loose grid so nodes don't overlap initially (prevents force explosion on large graphs).
	const nodes = new Map<string, SimNode>();
	const cols = Math.max(1, Math.round(Math.sqrt(N * (width / height))));
	const rows = Math.max(1, Math.ceil(N / cols));
	const cellW = (width - 40) / cols;
	const cellH = (height - 40) / rows;
	let i = 0;
	for (const id of ids) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		nodes.set(id, {
			id,
			x: 20 + col * cellW + cellW * 0.5 + ((i * 37) % 7) - 3,
			y: 20 + row * cellH + cellH * 0.5 + ((i * 53) % 7) - 3,
			vx: 0,
			vy: 0,
			fx: null,
			fy: null,
		});
		i += 1;
	}
	const pairs = links
		.map((l) => ({ a: nodes.get(l.a), b: nodes.get(l.b) }))
		.filter((l): l is { a: SimNode; b: SimNode } => !!l.a && !!l.b);

	const arr = Array.from(nodes.values());

	const step = (alpha: number) => {
		// repulsion (O(n^2))
		for (let i = 0; i < arr.length; i++) {
			const ni = arr[i];
			for (let j = i + 1; j < arr.length; j++) {
				const nj = arr[j];
				let dx = ni.x - nj.x;
				let dy = ni.y - nj.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 0.02) {
					dx = (Math.random() - 0.5) * 0.4;
					dy = (Math.random() - 0.5) * 0.4;
					d2 = dx * dx + dy * dy + 0.02;
				}
				const d = Math.sqrt(d2);
				const force = ((k * k) / d2) * 0.6 * alpha;
				const fx = (dx / d) * force;
				const fy = (dy / d) * force;
				ni.vx += fx;
				ni.vy += fy;
				nj.vx -= fx;
				nj.vy -= fy;
			}
		}
		// link attraction (spring toward ideal distance)
		const ideal = k * 1.15;
		for (const p of pairs) {
			const dx = p.b.x - p.a.x;
			const dy = p.b.y - p.a.y;
			let d = Math.sqrt(dx * dx + dy * dy);
			if (d < 0.01) d = 0.01;
			const force = ((d - ideal) / d) * 0.08 * alpha;
			const fx = dx * force;
			const fy = dy * force;
			p.a.vx += fx;
			p.a.vy += fy;
			p.b.vx -= fx;
			p.b.vy -= fy;
		}
		// gravity to center + integrate (with velocity clamp to prevent divergence)
		const vmax = k * 3;
		for (const n of arr) {
			n.vx += (cx - n.x) * 0.012 * alpha;
			n.vy += (cy - n.y) * 0.012 * alpha;
			n.vx *= 0.82;
			n.vy *= 0.82;
			if (n.vx > vmax) n.vx = vmax;
			else if (n.vx < -vmax) n.vx = -vmax;
			if (n.vy > vmax) n.vy = vmax;
			else if (n.vy < -vmax) n.vy = -vmax;
			if (n.fx != null) {
				n.x = n.fx;
				n.vx = 0;
			} else {
				n.x += n.vx;
			}
			if (n.fy != null) {
				n.y = n.fy;
				n.vy = 0;
			} else {
				n.y += n.vy;
			}
		}
	};
	return { nodes, step };
}

function graphSignature(
	nodes: Array<{ id: string }>,
	edges: Array<{ a: string; b: string; weight: number }>,
): string {
	const ns = nodes
		.map((n) => n.id)
		.sort()
		.join(",");
	const es = edges
		.map((e) => `${e.a}-${e.b}:${e.weight}`)
		.sort()
		.join("|");
	return `${ns}##${es}`;
}

interface MemoryGraphViewProps {
	nodes: GraphViewNode[];
	edges: GraphViewEdge[];
	selectedNodeId: string | null;
	onSelectNode: (id: string | null) => void;
	onOpenNode?: (node: GraphViewNode) => void;
	height?: number;
	compact?: boolean;
}

export const MemoryGraphView: React.FC<MemoryGraphViewProps> = ({
	nodes,
	edges,
	selectedNodeId,
	onSelectNode,
	onOpenNode,
	height = 660,
	compact = false,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const simRef = useRef<{
		nodes: Map<string, SimNode>;
		step: (a: number) => void;
	} | null>(null);
	const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
	const dragRef = useRef<{
		mode: "pan" | "node" | null;
		id: string | null;
		startX: number;
		startY: number;
		moved: boolean;
	} | null>(null);

	const [maxPerNode, setMaxPerNode] = useState(5);
	const [minWeight, setMinWeight] = useState(1);
	const [typeFilter, setTypeFilter] = useState<string>("all");
	const [focusDepth, setFocusDepth] = useState(1);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [hoverScreen, setHoverScreen] = useState<{ x: number; y: number }>({
		x: 0,
		y: 0,
	});
	const [size, setSize] = useState({ w: 800, h: height });
	const [computing, setComputing] = useState(false);

	// Build the augmented graph (filtered)
	const aug = useMemo(
		() => buildGraph(nodes, edges, maxPerNode, minWeight),
		[nodes, edges, maxPerNode, minWeight],
	);
	// Apply type filter
	const visible = useMemo(() => {
		const ids = new Set(
			aug.nodes
				.filter((n) => typeFilter === "all" || n.cluster === typeFilter)
				.map((n) => n.id),
		);
		const vnodes = aug.nodes.filter((n) => ids.has(n.id));
		const vedges = aug.edges.filter((e) => ids.has(e.a) && ids.has(e.b));
		return { nodes: vnodes, edges: vedges };
	}, [aug, typeFilter]);

	const byId = useMemo(() => {
		const m = new Map<string, AugNode>();
		for (const n of visible.nodes) m.set(n.id, n);
		return m;
	}, [visible]);

	// adjacency for focus/hover
	const adjacency = useMemo(() => {
		const adj = new Map<string, Set<string>>();
		for (const e of visible.edges) {
			if (!adj.has(e.a)) adj.set(e.a, new Set());
			if (!adj.has(e.b)) adj.set(e.b, new Set());
			const sa = adj.get(e.a);
			const sb = adj.get(e.b);
			if (sa) sa.add(e.b);
			if (sb) sb.add(e.a);
		}
		return adj;
	}, [visible]);

	// reachable set within focusDepth from focus node
	const focusSet = useMemo(() => {
		const focusId = hoveredId ?? selectedNodeId;
		if (!focusId) return null;
		const set = new Set<string>([focusId]);
		let frontier = [focusId];
		for (let d = 0; d < focusDepth; d++) {
			const next: string[] = [];
			for (const id of frontier) {
				const neigh = adjacency.get(id);
				if (neigh)
					for (const n of neigh)
						if (!set.has(n)) {
							set.add(n);
							next.push(n);
						}
			}
			frontier = next;
		}
		return set;
	}, [hoveredId, selectedNodeId, focusDepth, adjacency]);

	// init / settle simulation when graph changes (cached positions)
	const sig = graphSignature(visible.nodes, visible.edges);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-init only when the graph signature or canvas size changes
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const w = Math.max(rect.width, 320);
		const h = Math.max(rect.height, height);
		setSize({ w, h });

		const cached = loadPositions(sig);
		const sim = createSimulation(
			visible.nodes.map((n) => n.id),
			visible.edges,
			w,
			h,
		);
		if (cached) {
			for (const [id, p] of cached) {
				const sn = sim.nodes.get(id);
				if (sn) {
					sn.x = p.x;
					sn.y = p.y;
				}
			}
		}
		simRef.current = sim;
		const settleIters = cached ? 40 : visible.nodes.length > 300 ? 160 : 300;
		const saveCurrent = () => {
			if (!cached)
				savePositions(
					sig,
					Array.from(sim.nodes.entries()).map(([id, n]) => ({
						id,
						x: n.x,
						y: n.y,
					})),
				);
		};
		// Small / cached graphs: settle synchronously (fast).
		if (cached || visible.nodes.length <= 250) {
			for (let t = 0; t < settleIters; t++) {
				sim.step(cached ? 0.25 : (1 - t / settleIters) ** 1.7 + 0.02);
			}
			saveCurrent();
			draw();
			return;
		}
		// Large graphs: settle in time-sliced batches so the UI stays responsive.
		setComputing(true);
		let step = 0;
		let cancelled = false;
		const runBatch = () => {
			if (cancelled) return;
			const until = performance.now() + 16;
			while (step < settleIters && performance.now() < until) {
				sim.step((1 - step / settleIters) ** 1.7 + 0.02);
				step += 1;
			}
			draw();
			if (step < settleIters) {
				setTimeout(runBatch, 0);
			} else {
				saveCurrent();
				setComputing(false);
			}
		};
		runBatch();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sig, size.w, size.h]);

	const draw = useCallback(() => {
		const canvas = canvasRef.current;
		const sim = simRef.current;
		if (!canvas || !sim) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const { w, h } = size;
		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr;
			canvas.height = h * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = BG;
		ctx.fillRect(0, 0, w, h);

		const { scale, tx, ty } = viewRef.current;
		const toScreen = (x: number, y: number) => [x * scale + tx, y * scale + ty];

		const inFocus = (id: string) => !focusSet || focusSet.has(id);

		// edges
		ctx.lineCap = "round";
		for (const e of visible.edges) {
			const a = sim.nodes.get(e.a);
			const b = sim.nodes.get(e.b);
			if (!a || !b) continue;
			const [ax, ay] = toScreen(a.x, a.y);
			const [bx, by] = toScreen(b.x, b.y);
			const lit = !!focusSet?.has(e.a) && !!focusSet?.has(e.b);
			const dim = !!focusSet && !lit;
			ctx.strokeStyle = lit ? EDGE_LIT : dim ? EDGE_DIM : EDGE_BASE;
			ctx.lineWidth = lit ? 0.9 + Math.min(e.weight, 4) * 0.25 : 0.5;
			ctx.beginPath();
			ctx.moveTo(ax, ay);
			ctx.lineTo(bx, by);
			ctx.stroke();
		}

		// nodes
		const showAllLabels = scale > 1.35;
		const topCentral = new Set(
			[...visible.nodes]
				.sort((x, y) => y.degree - x.degree)
				.slice(0, 8)
				.map((n) => n.id),
		);
		for (const n of visible.nodes) {
			const sn = sim.nodes.get(n.id);
			if (!sn) continue;
			const [x, y] = toScreen(sn.x, sn.y);
			const selected = selectedNodeId === n.id;
			const hovered = hoveredId === n.id;
			const lit = inFocus(n.id);
			const baseR = n.r;
			const r = selected || hovered ? baseR + 2 : baseR;
			const col = clusterColor(n.cluster);
			ctx.globalAlpha = lit ? 1 : 0.12;
			ctx.beginPath();
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.fillStyle = col;
			ctx.fill();
			if (selected) {
				ctx.lineWidth = 1.6;
				ctx.strokeStyle = "#fff";
				ctx.stroke();
			} else if (hovered) {
				ctx.lineWidth = 1.2;
				ctx.strokeStyle = "rgba(255,255,255,0.55)";
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
			// labels: selected, hovered, high-centrality (when zoomed), top-central
			if (selected || hovered || (showAllLabels && topCentral.has(n.id))) {
				ctx.font = "11px Inter, system-ui, sans-serif";
				ctx.fillStyle = LABEL_COLOR;
				ctx.globalAlpha = selected || hovered ? 1 : 0.8;
				ctx.textAlign = "center";
				ctx.fillText(truncate(n.label, 26), x, y - r - 5);
				ctx.globalAlpha = 1;
			}
		}
	}, [visible, focusSet, selectedNodeId, hoveredId, size]);

	useEffect(() => {
		draw();
	}, [draw]);

	/* ---------- coordinate helpers ---------- */
	const toGraph = (clientX: number, clientY: number) => {
		const canvas = canvasRef.current;
		if (!canvas) return { x: 0, y: 0, sx: 0, sy: 0 };
		const rect = canvas.getBoundingClientRect();
		const sx = clientX - rect.left;
		const sy = clientY - rect.top;
		const { scale, tx, ty } = viewRef.current;
		return { x: (sx - tx) / scale, y: (sy - ty) / scale, sx, sy };
	};
	const hitTest = (gx: number, gy: number): string | null => {
		const sim = simRef.current;
		if (!sim) return null;
		const { scale } = viewRef.current;
		let best: string | null = null;
		let bestD = Number.POSITIVE_INFINITY;
		for (const n of visible.nodes) {
			const sn = sim.nodes.get(n.id);
			if (!sn) continue;
			const dx = sn.x - gx;
			const dy = sn.y - gy;
			const d = dx * dx + dy * dy;
			const tol = (n.r + 4) / scale;
			if (d < tol * tol && d < bestD) {
				bestD = d;
				best = n.id;
			}
		}
		return best;
	};

	/* ---------- interactions ---------- */
	// Native non-passive wheel listener so preventDefault works (no console warnings, no page scroll).
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const handler = (e: WheelEvent) => {
			e.preventDefault();
			const rect = canvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			const v = viewRef.current;
			const ns = Math.max(0.35, Math.min(3, v.scale * factor));
			v.tx = sx - ((sx - v.tx) * ns) / v.scale;
			v.ty = sy - ((sy - v.ty) * ns) / v.scale;
			v.scale = ns;
			draw();
		};
		canvas.addEventListener("wheel", handler, { passive: false });
		return () => canvas.removeEventListener("wheel", handler);
	}, [draw]);
	const onPointerDown = (e: React.PointerEvent) => {
		const { x, y } = toGraph(e.clientX, e.clientY);
		const hit = hitTest(x, y);
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		if (hit) {
			const sim = simRef.current;
			const sn = sim?.nodes.get(hit);
			if (sn) {
				sn.fx = x;
				sn.fy = y;
			}
			dragRef.current = {
				mode: "node",
				id: hit,
				startX: e.clientX,
				startY: e.clientY,
				moved: false,
			};
		} else {
			dragRef.current = {
				mode: "pan",
				id: null,
				startX: e.clientX,
				startY: e.clientY,
				moved: false,
			};
		}
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const d = dragRef.current;
		if (d) {
			const dx = e.clientX - d.startX;
			const dy = e.clientY - d.startY;
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
			if (d.mode === "pan") {
				viewRef.current.tx += dx;
				viewRef.current.ty += dy;
				d.startX = e.clientX;
				d.startY = e.clientY;
				draw();
			} else if (d.mode === "node" && d.id) {
				const { x, y } = toGraph(e.clientX, e.clientY);
				const sim = simRef.current;
				const sn = sim?.nodes.get(d.id);
				if (sn) {
					sn.fx = x;
					sn.fy = y;
				}
				for (let t = 0; t < 8; t++) sim?.step(0.3);
				draw();
			}
			return;
		}
		// hover
		const { x, y, sx, sy } = toGraph(e.clientX, e.clientY);
		const hit = hitTest(x, y);
		setHoveredId((prev) => (prev === hit ? prev : hit));
		if (hit) setHoverScreen({ x: sx, y: sy });
	};
	const onPointerUp = (e: React.PointerEvent) => {
		const d = dragRef.current;
		if (d) {
			(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
			if (d.mode === "node" && d.id) {
				const sim = simRef.current;
				const sn = sim?.nodes.get(d.id);
				if (sn) {
					sn.fx = null;
					sn.fy = null;
				}
				if (!d.moved) onSelectNode(d.id === selectedNodeId ? null : d.id);
				savePositions(
					sig,
					Array.from(sim?.nodes.entries() ?? []).map(([id, n]) => ({
						id,
						x: n.x,
						y: n.y,
					})),
				);
			} else if (d.mode === "pan" && !d.moved) {
				onSelectNode(null);
			}
		}
		dragRef.current = null;
	};
	const onDoubleClick = (e: React.MouseEvent) => {
		const { x, y } = toGraph(e.clientX, e.clientY);
		const hit = hitTest(x, y);
		if (hit && onOpenNode) {
			const n = byId.get(hit);
			if (n) onOpenNode(n as GraphViewNode);
		}
	};

	const recenter = () => {
		viewRef.current = { scale: 1, tx: 0, ty: 0 };
		draw();
	};
	const showAll = () => {
		setTypeFilter("all");
		setMinWeight(1);
		setMaxPerNode(5);
		onSelectNode(null);
		recenter();
	};
	const clusterOnly = () => {
		const id = selectedNodeId ?? hoveredId;
		const node = id ? byId.get(id) : null;
		if (node) setTypeFilter(node.cluster);
	};

	// tooltip data
	const tipNode = hoveredId ? byId.get(hoveredId) : null;

	// detail panel data (Obsidian-like side panel)
	const selAug = selectedNodeId ? (byId.get(selectedNodeId) ?? null) : null;
	const selNeighbors = selAug
		? Array.from(adjacency.get(selAug.id) ?? [])
				.map((id) => byId.get(id))
				.filter((n): n is AugNode => !!n)
		: [];

	const sources = useMemo(() => {
		const set = new Set<string>();
		for (const n of aug.nodes) set.add(n.cluster);
		return Array.from(set);
	}, [aug]);

	return (
		<div
			ref={containerRef}
			className="memgraph-shell"
			style={{
				position: "relative",
				height,
				borderRadius: 14,
				overflow: "hidden",
			}}
		>
			<canvas
				ref={canvasRef}
				style={{
					display: "block",
					width: "100%",
					height: "100%",
					cursor: dragRef.current?.mode === "node" ? "grabbing" : "default",
					touchAction: "none",
				}}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={() => {
					setHoveredId(null);
				}}
				onDoubleClick={onDoubleClick}
			/>

			{/* Controls */}
			<div className="memgraph-controls">
				<div className="memgraph-chips">
					<button
						type="button"
						className={`memgraph-chip${typeFilter === "all" ? " is-active" : ""}`}
						onClick={() => setTypeFilter("all")}
					>
						Todas
					</button>
					{sources.map((s) => (
						<button
							key={s}
							type="button"
							className={`memgraph-chip${typeFilter === s ? " is-active" : ""}`}
							onClick={() => setTypeFilter(s)}
							style={{ "--chip": clusterColor(s) } as React.CSSProperties}
						>
							<span
								className="memgraph-dot"
								style={{ background: clusterColor(s) }}
							/>
							{SOURCE_LABELS[s] ?? s}
						</button>
					))}
				</div>
				{!compact && (
					<div className="memgraph-sliders">
						<label className="memgraph-slider">
							<span>Profundidad</span>
							<input
								type="range"
								min={1}
								max={3}
								step={1}
								value={focusDepth}
								onChange={(e) => setFocusDepth(Number(e.target.value))}
							/>
							<span className="memgraph-slider-val">{focusDepth}</span>
						</label>
						<label className="memgraph-slider">
							<span>Peso mín.</span>
							<input
								type="range"
								min={1}
								max={5}
								step={1}
								value={minWeight}
								onChange={(e) => setMinWeight(Number(e.target.value))}
							/>
							<span className="memgraph-slider-val">{minWeight}</span>
						</label>
					</div>
				)}
				{!compact && (
					<div className="memgraph-btns">
						<button type="button" className="memgraph-btn" onClick={recenter}>
							⟲ Recentrar
						</button>
						<button type="button" className="memgraph-btn" onClick={showAll}>
							⤢ Mostrar todo
						</button>
						<button
							type="button"
							className="memgraph-btn"
							onClick={clusterOnly}
							disabled={!selectedNodeId && !hoveredId}
						>
							◎ Solo clúster
						</button>
					</div>
				)}
			</div>

			{/* Legend / status */}
			<div className="memgraph-status">
				{visible.nodes.length} nodos · {visible.edges.length} enlaces
				{selectedNodeId ? " · foco activo" : ""}
			</div>

			{computing ? (
				<div className="memgraph-computing">
					<span className="memgraph-spinner" />
					Generando layout…
				</div>
			) : null}

			{/* Detail panel (Obsidian-like side note) */}
			{!compact && selAug ? (
				<GraphDetailPanel
					node={selAug}
					neighbors={selNeighbors}
					onClose={() => onSelectNode(null)}
					onOpen={() => onOpenNode?.(selAug as GraphViewNode)}
					onSelectNeighbor={(id) => onSelectNode(id)}
				/>
			) : null}

			{/* Tooltip */}
			{tipNode ? (
				<NodeTooltip
					node={tipNode}
					degree={tipNode.degree}
					screen={hoverScreen}
					bounds={size}
				/>
			) : null}
		</div>
	);
};

const NodeTooltip: React.FC<{
	node: AugNode;
	degree: number;
	screen: { x: number; y: number };
	bounds: { w: number; h: number };
}> = ({ node, degree, screen, bounds }) => {
	const W = 210;
	const H = 132;
	let left = screen.x + 14;
	let top = screen.y + 14;
	if (left + W > bounds.w) left = screen.x - W - 14;
	if (top + H > bounds.h) top = screen.y - H - 14;
	left = Math.max(8, left);
	top = Math.max(8, top);
	return (
		<div
			className="memgraph-tip"
			style={
				{
					left,
					top,
					"--tip": clusterColor(node.cluster),
				} as React.CSSProperties
			}
		>
			<div className="memgraph-tip-name">{node.label}</div>
			<div className="memgraph-tip-row">
				<span>Tipo</span>
				<b>{SOURCE_LABELS[node.cluster] ?? node.cluster}</b>
			</div>
			<div className="memgraph-tip-row">
				<span>Categoría</span>
				<b>{node.type}</b>
			</div>
			<div className="memgraph-tip-row">
				<span>Conexiones</span>
				<b>{degree}</b>
			</div>
			<div className="memgraph-tip-row">
				<span>Importancia</span>
				<b>{Math.round((node.weight ?? 0) * 100)}%</b>
			</div>
		</div>
	);
};

const GraphDetailPanel: React.FC<{
	node: AugNode;
	neighbors: AugNode[];
	onClose: () => void;
	onOpen: () => void;
	onSelectNeighbor: (id: string) => void;
}> = ({ node, neighbors, onClose, onOpen, onSelectNeighbor }) => {
	const col = clusterColor(node.cluster);
	return (
		<aside
			className="memgraph-panel"
			style={{ "--panel-c": col } as React.CSSProperties}
		>
			<div className="memgraph-panel-head">
				<div className="memgraph-panel-titlewrap">
					<span className="memgraph-panel-dot" style={{ background: col }} />
					<div>
						<div className="memgraph-panel-title">{node.label}</div>
						<div className="memgraph-panel-sub">
							{SOURCE_LABELS[node.cluster] ?? node.cluster} · {node.type}
						</div>
					</div>
				</div>
				<button
					type="button"
					className="memgraph-panel-close"
					onClick={onClose}
					aria-label="Cerrar"
				>
					✕
				</button>
			</div>
			<div className="memgraph-panel-stats">
				<span>
					<b>{node.degree}</b> conexiones
				</span>
				<span>
					<b>{Math.round((node.weight ?? 0) * 100)}%</b> importancia
				</span>
				<span>
					<b>{Math.round(node.centrality * 100)}%</b> centralidad
				</span>
			</div>
			{node.content ? (
				<div className="memgraph-panel-section">
					<div className="memgraph-panel-label">Contenido</div>
					<div className="memgraph-panel-content">{node.content}</div>
				</div>
			) : null}
			{node.keywords?.length ? (
				<div className="memgraph-panel-section">
					<div className="memgraph-panel-label">Conceptos</div>
					<div className="memgraph-panel-keywords">
						{node.keywords.slice(0, 16).map((k) => (
							<span key={k} className="memgraph-panel-kw">
								{k}
							</span>
						))}
					</div>
				</div>
			) : null}
			{neighbors.length ? (
				<div className="memgraph-panel-section">
					<div className="memgraph-panel-label">
						Conectado con ({neighbors.length})
					</div>
					<div className="memgraph-panel-neighbors">
						{neighbors.map((nb) => (
							<button
								key={nb.id}
								type="button"
								className="memgraph-panel-neighbor"
								onClick={() => onSelectNeighbor(nb.id)}
							>
								<span
									className="memgraph-dot"
									style={{ background: clusterColor(nb.cluster) }}
								/>
								<span>{nb.label}</span>
							</button>
						))}
					</div>
				</div>
			) : null}
			{onOpen ? (
				<button type="button" className="memgraph-panel-open" onClick={onOpen}>
					Abrir memoria →
				</button>
			) : null}
		</aside>
	);
};

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ---------- position persistence (stable layout across opens) ---------- */
const POS_STORE_PREFIX = "octopus:graphpos2:";
function loadPositions(
	sig: string,
): Map<string, { x: number; y: number }> | null {
	try {
		const raw = localStorage.getItem(POS_STORE_PREFIX + sig.slice(0, 64));
		if (!raw) return null;
		const arr = JSON.parse(raw) as Array<{ id: string; x: number; y: number }>;
		if (!Array.isArray(arr)) return null;
		return new Map(arr.map((p) => [p.id, { x: p.x, y: p.y }]));
	} catch {
		return null;
	}
}
function savePositions(
	sig: string,
	arr: Array<{ id: string; x: number; y: number }>,
): void {
	try {
		localStorage.setItem(
			POS_STORE_PREFIX + sig.slice(0, 64),
			JSON.stringify(arr),
		);
	} catch {
		/* storage full / unavailable */
	}
}
