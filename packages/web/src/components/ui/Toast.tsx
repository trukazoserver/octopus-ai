import type React from "react";
import { useCallback, useEffect, useState } from "react";

type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
	id: string;
	type: ToastType;
	message: string;
}

const TOAST_STYLES: Record<
	ToastType,
	{ bg: string; border: string; color: string; icon: string }
> = {
	success: {
		bg: "rgba(16, 185, 129, 0.1)",
		border: "rgba(16, 185, 129, 0.3)",
		color: "#10b981",
		icon: "✓",
	},
	error: {
		bg: "rgba(239, 68, 68, 0.1)",
		border: "rgba(239, 68, 68, 0.3)",
		color: "#ef4444",
		icon: "✕",
	},
	info: {
		bg: "rgba(59, 130, 246, 0.1)",
		border: "rgba(59, 130, 246, 0.3)",
		color: "#3b82f6",
		icon: "ℹ",
	},
	warning: {
		bg: "rgba(245, 158, 11, 0.1)",
		border: "rgba(245, 158, 11, 0.3)",
		color: "#f59e0b",
		icon: "⚠",
	},
};

let toastListeners: Array<(toast: Toast) => void> = [];

export function showToast(type: ToastType, message: string) {
	const toast: Toast = {
		id: Math.random().toString(36).slice(2),
		type,
		message,
	};
	toastListeners.forEach((fn) => fn(toast));
}

export const ToastContainer: React.FC = () => {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const addToast = useCallback((toast: Toast) => {
		setToasts((prev) => [...prev, toast]);
		setTimeout(() => {
			setToasts((prev) => prev.filter((t) => t.id !== toast.id));
		}, 4000);
	}, []);

	useEffect(() => {
		toastListeners.push(addToast);
		return () => {
			toastListeners = toastListeners.filter((fn) => fn !== addToast);
		};
	}, [addToast]);

	return (
		<div
			style={{
				position: "fixed",
				bottom: "24px",
				right: "24px",
				zIndex: 1070,
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				pointerEvents: "none",
			}}
		>
			{toasts.map((toast) => {
				const s = TOAST_STYLES[toast.type];
				return (
					<div
						key={toast.id}
						style={{
							display: "flex",
							alignItems: "center",
							gap: "10px",
							padding: "12px 20px",
							borderRadius: "12px",
							background: s.bg,
							border: `1px solid ${s.border}`,
							color: s.color,
							fontSize: "0.875rem",
							fontWeight: 500,
							boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
							animation: "slideUp 0.3s ease-out",
							pointerEvents: "auto",
							backdropFilter: "blur(12px)",
						}}
					>
						<span style={{ fontWeight: 700, fontSize: "1rem" }}>{s.icon}</span>
						{toast.message}
					</div>
				);
			})}
		</div>
	);
};
