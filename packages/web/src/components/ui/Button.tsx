import type React from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	icon?: string;
	loading?: boolean;
	fullWidth?: boolean;
}

const VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
	primary: {
		background: "#6366f1",
		color: "#fff",
		border: "none",
		boxShadow: "0 2px 4px rgba(99, 102, 241, 0.2)",
	},
	secondary: {
		background: "#27272a",
		color: "#f4f4f5",
		border: "1px solid #3f3f46",
	},
	ghost: {
		background: "transparent",
		color: "#a1a1aa",
		border: "1px solid transparent",
	},
	danger: {
		background: "rgba(239, 68, 68, 0.15)",
		color: "#ef4444",
		border: "1px solid rgba(239, 68, 68, 0.3)",
	},
};

const SIZE_STYLES: Record<ButtonSize, React.CSSProperties> = {
	sm: {
		padding: "6px 12px",
		fontSize: "0.8rem",
		borderRadius: "8px",
		gap: "6px",
	},
	md: {
		padding: "10px 16px",
		fontSize: "0.875rem",
		borderRadius: "10px",
		gap: "8px",
	},
	lg: {
		padding: "14px 24px",
		fontSize: "1rem",
		borderRadius: "12px",
		gap: "10px",
	},
};

export const Button: React.FC<ButtonProps> = ({
	variant = "primary",
	size = "md",
	icon,
	loading,
	fullWidth,
	children,
	disabled,
	style,
	...props
}) => {
	const baseStyle: React.CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		fontWeight: 600,
		cursor: disabled || loading ? "not-allowed" : "pointer",
		transition: "all 150ms ease",
		fontFamily: "inherit",
		opacity: disabled || loading ? 0.5 : 1,
		width: fullWidth ? "100%" : undefined,
		...VARIANT_STYLES[variant],
		...SIZE_STYLES[size],
		...style,
	};

	return (
		<button
			type="button"
			disabled={disabled || loading}
			style={baseStyle}
			{...props}
		>
			{loading ? (
				<span
					style={{
						display: "inline-block",
						animation: "spin 1s linear infinite",
						fontSize: "0.9em",
					}}
				>
					⟳
				</span>
			) : icon ? (
				<span aria-hidden="true">{icon}</span>
			) : null}
			{children}
		</button>
	);
};
