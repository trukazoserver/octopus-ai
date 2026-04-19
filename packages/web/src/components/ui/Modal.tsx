import type React from "react";
import { useCallback, useEffect, useRef } from "react";

interface ModalProps {
	open: boolean;
	onClose: () => void;
	title?: string;
	children: React.ReactNode;
	maxWidth?: string;
}

export const Modal: React.FC<ModalProps> = ({
	open,
	onClose,
	title,
	children,
	maxWidth = "480px",
}) => {
	const dialogRef = useRef<HTMLDivElement>(null);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		},
		[onClose],
	);

	useEffect(() => {
		if (open) {
			document.addEventListener("keydown", handleKeyDown);
			document.body.style.overflow = "hidden";
		}
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = "";
		};
	}, [open, handleKeyDown]);

	if (!open) return null;

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 1050,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "16px",
				animation: "fadeInFast 0.15s ease-out",
			}}
		>
			<div
				onClick={onClose}
				style={{
					position: "absolute",
					inset: 0,
					background: "rgba(0, 0, 0, 0.7)",
					backdropFilter: "blur(4px)",
				}}
			/>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				style={{
					position: "relative",
					width: "100%",
					maxWidth,
					background: "#18181b",
					borderRadius: "16px",
					border: "1px solid #27272a",
					boxShadow: "0 25px 50px rgba(0, 0, 0, 0.5)",
					animation: "scaleIn 0.2s ease-out",
					overflow: "hidden",
				}}
			>
				{title && (
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							padding: "20px 24px",
							borderBottom: "1px solid #27272a",
						}}
					>
						<h2
							style={{
								margin: 0,
								fontSize: "1.1rem",
								fontWeight: 700,
								color: "#f4f4f5",
							}}
						>
							{title}
						</h2>
						<button
							type="button"
							onClick={onClose}
							style={{
								background: "none",
								border: "none",
								color: "#71717a",
								cursor: "pointer",
								fontSize: "1.2rem",
								padding: "4px",
								lineHeight: 1,
								transition: "color 0.15s",
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.color = "#f4f4f5";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.color = "#71717a";
							}}
						>
							✕
						</button>
					</div>
				)}
				<div style={{ padding: "24px" }}>{children}</div>
			</div>
		</div>
	);
};
