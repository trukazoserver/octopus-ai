import type React from "react";

interface StatusBadgeProps {
	status: "ok" | "error" | "warning" | "idle";
	label: string;
}

const COLORS = {
	ok: { bg: "rgba(0,230,118,0.15)", color: "#00e676", dot: "#00e676" },
	error: { bg: "rgba(255,23,68,0.15)", color: "#ff1744", dot: "#ff1744" },
	warning: { bg: "rgba(255,171,0,0.15)", color: "#ffab00", dot: "#ffab00" },
	idle: { bg: "rgba(255,255,255,0.05)", color: "#555", dot: "#555" },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label }) => {
	const c = COLORS[status] ?? COLORS.idle;
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: "5px",
				padding: "3px 10px",
				borderRadius: "10px",
				background: c.bg,
				fontSize: "0.75rem",
				color: c.color,
			}}
		>
			<span
				style={{
					width: "6px",
					height: "6px",
					borderRadius: "50%",
					background: c.dot,
					flexShrink: 0,
				}}
			/>
			{label}
		</span>
	);
};
