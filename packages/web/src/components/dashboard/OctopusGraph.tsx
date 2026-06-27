import { OCTOPUS_ARM_PROFILES } from "@octopus-ai/core/agent/arm-profiles";
import type { DashboardArmSummary } from "../../hooks/useDashboard.js";
import { publicAsset } from "../../utils/assets.js";

interface OctopusGraphProps {
	mainAgent: DashboardArmSummary | null;
	arms: DashboardArmSummary[];
	/** Provider/model shown for the center node tooltip when mainAgent has none. */
	fallbackProvider?: string;
	fallbackModel?: string;
}

const VIEW = 660;
const CENTER = VIEW / 2;
const ARM_DISTANCE = 232; // center → arm token center
const CENTER_HALF = 74; // Octavio token half-size
const CENTER_RX = 22; // Octavio token corner radius
const ARM_HALF = 48; // arm token half-size
const ARM_RX = 16; // arm token corner radius

const OCTAVIO_SRC = publicAsset("mascotas/Pulpo_octavio.png");

/** armKey → canonical profile (avatar/color/name). Single source of truth. */
const ARM_PROFILE_BY_KEY = new Map(
	OCTOPUS_ARM_PROFILES.map((profile) => [profile.key, profile]),
);

const ARM_ORDER = [
	"bibi",
	"anita",
	"ari",
	"cali",
	"crabby",
	"estelita",
	"langi",
	"medi",
] as const;

function modelShort(ref?: string): string {
	if (!ref) return "—";
	const slash = ref.indexOf("/");
	return slash !== -1 ? ref.slice(slash + 1) : ref;
}

/**
 * Radial octopus constellation: Octavio at the center connected by animated
 * tentacles to his eight arm-agents. Each node is the agent's real mascot
 * image (not a flat circle), framed in a rounded token with its brand color.
 * Provider/model details live in the side legend (see Dashboard ArmLegend).
 */
export function OctopusGraph({
	mainAgent,
	arms,
	fallbackProvider,
	fallbackModel,
}: OctopusGraphProps) {
	const byKey = new Map(arms.map((a) => [a.armKey ?? a.id, a]));
	const slots = ARM_ORDER.map((key, i) => {
		const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 8;
		const arm = byKey.get(key) ?? arms[i];
		const profile = ARM_PROFILE_BY_KEY.get(key);
		const x = CENTER + ARM_DISTANCE * Math.cos(angle);
		const y = CENTER + ARM_DISTANCE * Math.sin(angle);
		const color = arm?.color ?? profile?.color ?? "#7c5cff";
		const name = arm?.name ?? profile?.name ?? key;
		const avatar = publicAsset(profile?.avatar ?? "mascotas/Pulpo_octavio.png");
		return { key, arm, x, y, angle, color, name, avatar, idx: i };
	});

	return (
		<div className="octopus-graph cc-constellation">
			<svg
				viewBox={`0 0 ${VIEW} ${VIEW}`}
				role="img"
				aria-label="Octavio y sus ocho brazos"
				className="cc-constellation-svg"
			>
				<defs>
					<clipPath id="cc-clip-center">
						<rect
							x={CENTER - CENTER_HALF}
							y={CENTER - CENTER_HALF}
							width={CENTER_HALF * 2}
							height={CENTER_HALF * 2}
							rx={CENTER_RX}
						/>
					</clipPath>
					{slots.map((s) => (
						<clipPath key={`clip-${s.key}`} id={`cc-clip-arm-${s.key}`}>
							<rect
								x={s.x - ARM_HALF}
								y={s.y - ARM_HALF}
								width={ARM_HALF * 2}
								height={ARM_HALF * 2}
								rx={ARM_RX}
							/>
						</clipPath>
					))}
				</defs>

				{/* Tentacles: curved "arms" linking Octavio to each agent */}
				{slots.map((s) => {
					const sx = CENTER + (CENTER_HALF + 6) * Math.cos(s.angle);
					const sy = CENTER + (CENTER_HALF + 6) * Math.sin(s.angle);
					const ex = s.x - (ARM_HALF + 6) * Math.cos(s.angle);
					const ey = s.y - (ARM_HALF + 6) * Math.sin(s.angle);
					const perp = s.angle + Math.PI / 2;
					const wave = 22;
					const cpx = (sx + ex) / 2 + wave * Math.cos(perp);
					const cpy = (sy + ey) / 2 + wave * Math.sin(perp);
					return (
						<path
							key={`tentacle-${s.key}`}
							d={`M ${sx} ${sy} Q ${cpx} ${cpy} ${ex} ${ey}`}
							fill="none"
							stroke={s.color}
							strokeWidth={3}
							strokeOpacity={0.5}
							strokeLinecap="round"
							className="octopus-tentacle"
							style={{ animationDelay: `${s.idx * 0.16}s` }}
						/>
					);
				})}

				{/* Center: Octavio (the hub) */}
				<g className="octopus-center-node">
					<rect
						x={CENTER - CENTER_HALF - 7}
						y={CENTER - CENTER_HALF - 7}
						width={(CENTER_HALF + 7) * 2}
						height={(CENTER_HALF + 7) * 2}
						rx={CENTER_RX + 7}
						fill="#6366f1"
						opacity={0.14}
					/>
					<rect
						x={CENTER - CENTER_HALF}
						y={CENTER - CENTER_HALF}
						width={CENTER_HALF * 2}
						height={CENTER_HALF * 2}
						rx={CENTER_RX}
						fill="#0b0b12"
					/>
					<image
						href={OCTAVIO_SRC}
						x={CENTER - CENTER_HALF}
						y={CENTER - CENTER_HALF}
						width={CENTER_HALF * 2}
						height={CENTER_HALF * 2}
						clipPath="url(#cc-clip-center)"
						preserveAspectRatio="xMidYMid meet"
					/>
					<rect
						x={CENTER - CENTER_HALF}
						y={CENTER - CENTER_HALF}
						width={CENTER_HALF * 2}
						height={CENTER_HALF * 2}
						rx={CENTER_RX}
						fill="none"
						stroke="#6366f1"
						strokeWidth={2.5}
					/>
					<title>
						Octavio — {mainAgent?.providerDisplayName ?? fallbackProvider ?? ""}
						· {modelShort(mainAgent?.effectiveModel ?? fallbackModel)}
					</title>
				</g>

				{/* Arms: each agent's real mascot */}
				{slots.map((s) => (
					<g
						key={`arm-${s.key}`}
						className="octopus-arm-node"
						style={{ animationDelay: `${s.idx * 0.18}s` }}
					>
						<rect
							x={s.x - ARM_HALF - 6}
							y={s.y - ARM_HALF - 6}
							width={(ARM_HALF + 6) * 2}
							height={(ARM_HALF + 6) * 2}
							rx={ARM_RX + 6}
							fill={s.color}
							opacity={0.13}
						/>
						<rect
							x={s.x - ARM_HALF}
							y={s.y - ARM_HALF}
							width={ARM_HALF * 2}
							height={ARM_HALF * 2}
							rx={ARM_RX}
							fill="#0b0b12"
						/>
						<image
							href={s.avatar}
							x={s.x - ARM_HALF}
							y={s.y - ARM_HALF}
							width={ARM_HALF * 2}
							height={ARM_HALF * 2}
							clipPath={`url(#cc-clip-arm-${s.key})`}
							preserveAspectRatio="xMidYMid meet"
						/>
						<rect
							x={s.x - ARM_HALF}
							y={s.y - ARM_HALF}
							width={ARM_HALF * 2}
							height={ARM_HALF * 2}
							rx={ARM_RX}
							fill="none"
							stroke={s.color}
							strokeWidth={2.5}
						/>
						<text
							x={s.x}
							y={s.y + ARM_HALF + 16}
							textAnchor="middle"
							fill={s.color}
							fontSize={14}
							fontWeight={700}
							stroke="#000"
							strokeOpacity={0.55}
							strokeWidth={3}
							paintOrder="stroke"
						>
							{s.name}
						</text>
						<title>
							{s.name} — {s.arm?.providerDisplayName ?? "Proveedor —"} ·{" "}
							{modelShort(s.arm?.effectiveModel)}
							{s.arm?.reasoningEffort && s.arm.reasoningEffort !== "none"
								? ` (razonamiento: ${s.arm.reasoningEffort})`
								: ""}
						</title>
					</g>
				))}
			</svg>
		</div>
	);
}
