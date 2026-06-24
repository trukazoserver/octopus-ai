import type { DashboardArmSummary } from "../../hooks/useDashboard.js";

interface OctopusGraphProps {
	mainAgent: DashboardArmSummary | null;
	arms: DashboardArmSummary[];
	/** Provider/model shown at the center when mainAgent has none. */
	fallbackProvider?: string;
	fallbackModel?: string;
}

const VIEW = 640;
const CENTER = VIEW / 2;
const ARM_RADIUS = 248;
const CENTER_RADIUS = 78;
const ARM_RADIUS_PX = 50;

function modelShort(ref?: string): string {
	if (!ref) return "—";
	const slash = ref.indexOf("/");
	return slash !== -1 ? ref.slice(slash + 1) : ref;
}

function providerShort(name?: string): string {
	if (!name) return "";
	// Trim to a short token (e.g. "Z.ai / ZhipuAI (GLM)" -> "Z.ai/ZhipuAI")
	const first = name.split("(")[0].trim();
	return first.length > 16 ? first.slice(0, 14).trimEnd() + "…" : first;
}

const ROLE_LABELS: Record<string, string> = {
	planner: "Planificación",
	memory: "Memoria",
	engineer: "Ingeniería",
	creative: "Creativo",
	qa: "Calidad",
	synthesis: "Síntesis",
	research: "Investigación",
	vision: "Visión",
};

/**
 * Radial octopus visualization: Octavio at the center connected by animated
 * tentacles to his eight arm-agents. Each node shows the agent's provider and
 * configured model so the control center reflects the effective configuration.
 */
export function OctopusGraph({
	mainAgent,
	arms,
	fallbackProvider,
	fallbackModel,
}: OctopusGraphProps) {
	const centerModel = modelShort(
		mainAgent?.effectiveModel ?? fallbackModel ?? undefined,
	);
	const centerProvider =
		providerShort(mainAgent?.providerDisplayName) || providerShort(fallbackProvider);

	// Always render 8 slots (one per canonical arm key) so the layout is stable.
	const armOrder = [
		"bibi",
		"anita",
		"ari",
		"cali",
		"crabby",
		"estelita",
		"langi",
		"medi",
	];
	const byKey = new Map(arms.map((a) => [a.armKey ?? a.id, a]));
	const slots = armOrder.map((key, i) => {
		const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 8;
		const arm = byKey.get(key) ?? arms[i];
		const x = CENTER + ARM_RADIUS * Math.cos(angle);
		const y = CENTER + ARM_RADIUS * Math.sin(angle);
		return { key, arm, x, y, angle, idx: i };
	});

	return (
		<div
			className="octopus-graph"
			style={{ width: "100%", maxWidth: 640, margin: "0 auto", aspectRatio: "1 / 1" }}
		>
			<svg
				viewBox={`0 0 ${VIEW} ${VIEW}`}
				role="img"
				aria-label="Octavio y sus ocho brazos"
				style={{ width: "100%", height: "100%", display: "block" }}
			>
				<defs>
					<radialGradient id="octopus-center-grad" cx="50%" cy="45%" r="60%">
						<stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
						<stop offset="100%" stopColor="#6366f1" stopOpacity="0.05" />
					</radialGradient>
					{slots.map((s) => (
						<radialGradient
							key={`grad-${s.key}`}
							id={`octopus-arm-grad-${s.key}`}
							cx="50%"
							cy="50%"
							r="60%"
						>
							<stop offset="0%" stopColor={s.arm?.color ?? "#7c5cff"} stopOpacity="0.28" />
							<stop offset="100%" stopColor={s.arm?.color ?? "#7c5cff"} stopOpacity="0.04" />
						</radialGradient>
					))}
				</defs>

				{/* Tentacles: curved paths from center to each arm */}
				{slots.map((s) => {
					const sx = CENTER + CENTER_RADIUS * Math.cos(s.angle);
					const sy = CENTER + CENTER_RADIUS * Math.sin(s.angle);
					// Control point offset perpendicular to the radius for a curve.
					const perp = s.angle + Math.PI / 2;
					const wave = 26;
					const cx = (sx + s.x) / 2 + wave * Math.cos(perp);
					const cy = (sy + s.y) / 2 + wave * Math.sin(perp);
					return (
						<path
							key={`tentacle-${s.key}`}
							d={`M ${sx} ${sy} Q ${cx} ${cy} ${s.x} ${s.y}`}
							fill="none"
							stroke={s.arm?.color ?? "#3f3f46"}
							strokeWidth={3}
							strokeOpacity={0.55}
							strokeLinecap="round"
							className="octopus-tentacle"
						/>
					);
				})}

				{/* Center: Octavio */}
				<g>
					<circle
						cx={CENTER}
						cy={CENTER}
						r={CENTER_RADIUS + 10}
						fill="url(#octopus-center-grad)"
					/>
					<circle
						cx={CENTER}
						cy={CENTER}
						r={CENTER_RADIUS}
						fill="#0b0b10"
						stroke="#6366f1"
						strokeWidth={3}
					/>
					<text
						x={CENTER}
						y={CENTER - 20}
						textAnchor="middle"
						fill="#f4f4f5"
						fontSize={20}
						fontWeight={700}
					>
						🐙 Octavio
					</text>
					<text
						x={CENTER}
						y={CENTER + 6}
						textAnchor="middle"
						fill="#a1a1aa"
						fontSize={12}
					>
						{centerProvider || "Orquestador"}
					</text>
					<text
						x={CENTER}
						y={CENTER + 26}
						textAnchor="middle"
						fill="#818cf8"
						fontSize={13}
						fontWeight={600}
					>
						{centerModel}
					</text>
				</g>

				{/* Arms */}
				{slots.map((s) => {
					const color = s.arm?.color ?? "#7c5cff";
					const name = s.arm?.name ?? s.key;
					const role =
						s.arm && ROLE_LABELS[s.arm.role]
							? ROLE_LABELS[s.arm.role]
							: s.arm?.role ?? "";
					return (
						<g
							key={`arm-${s.key}`}
							transform={`translate(${s.x}, ${s.y})`}
							className="octopus-arm-node"
						>
							<circle
								r={ARM_RADIUS_PX + 6}
								fill={`url(#octopus-arm-grad-${s.key})`}
							/>
							<circle
								r={ARM_RADIUS_PX}
								fill="#0b0b10"
								stroke={color}
								strokeWidth={2.5}
							/>
							<text y={-16} textAnchor="middle" fill={color} fontSize={13} fontWeight={700}>
								{name.slice(0, 10)}
							</text>
							<text y={2} textAnchor="middle" fill="#a1a1aa" fontSize={10}>
								{modelShort(s.arm?.effectiveModel)}
							</text>
							<text y={18} textAnchor="middle" fill="#71717a" fontSize={9}>
								{role}
							</text>
							<title>
								{name} — {s.arm?.providerDisplayName ?? ""} ·{" "}
								{s.arm?.effectiveModel ?? "—"}
								{s.arm?.reasoningEffort && s.arm.reasoningEffort !== "none"
									? ` (razonamiento: ${s.arm.reasoningEffort})`
									: ""}
							</title>
						</g>
					);
				})}
			</svg>
		</div>
	);
}
