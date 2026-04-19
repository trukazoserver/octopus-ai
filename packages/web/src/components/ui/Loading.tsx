import type React from "react";

interface LoadingProps {
	size?: "sm" | "md" | "lg";
	text?: string;
}

const SIZES = { sm: "24px", md: "40px", lg: "64px" };

export const Loading: React.FC<LoadingProps> = ({ size = "md", text }) => (
	<div
		style={{
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
			gap: "16px",
			padding: "48px 20px",
		}}
	>
		<div
			style={{
				width: SIZES[size],
				height: SIZES[size],
				borderRadius: "50%",
				border: "3px solid #27272a",
				borderTopColor: "#6366f1",
				animation: "spin 0.8s linear infinite",
			}}
		/>
		{text && (
			<div style={{ fontSize: "0.85rem", color: "#71717a", fontWeight: 500 }}>
				{text}
			</div>
		)}
	</div>
);
