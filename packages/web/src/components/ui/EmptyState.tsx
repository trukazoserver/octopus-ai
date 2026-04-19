import type React from "react";

interface EmptyStateProps {
	icon: string;
	title: string;
	description?: string;
	action?: { label: string; onClick: () => void };
}

export const EmptyState: React.FC<EmptyStateProps> = ({
	icon,
	title,
	description,
	action,
}) => (
	<div
		className="animate-fade-in"
		style={{
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
			padding: "60px 20px",
			textAlign: "center",
		}}
	>
		<div
			style={{
				fontSize: "56px",
				marginBottom: "16px",
				animation: "float 3s ease-in-out infinite",
			}}
		>
			{icon}
		</div>
		<div
			style={{
				fontSize: "1.1rem",
				fontWeight: 700,
				color: "#71717a",
				marginBottom: "8px",
			}}
		>
			{title}
		</div>
		{description && (
			<div
				style={{
					fontSize: "0.85rem",
					color: "#52525b",
					maxWidth: "360px",
					lineHeight: 1.6,
				}}
			>
				{description}
			</div>
		)}
		{action && (
			<button
				type="button"
				onClick={action.onClick}
				style={{
					marginTop: "20px",
					padding: "10px 24px",
					borderRadius: "10px",
					border: "none",
					background: "#6366f1",
					color: "#fff",
					fontSize: "0.9rem",
					fontWeight: 600,
					cursor: "pointer",
					fontFamily: "inherit",
					transition: "background 0.15s",
					boxShadow: "0 2px 8px rgba(99, 102, 241, 0.3)",
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.background = "#4f46e5";
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.background = "#6366f1";
				}}
			>
				{action.label}
			</button>
		)}
	</div>
);
