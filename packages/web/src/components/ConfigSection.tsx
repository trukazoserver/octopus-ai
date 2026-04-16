import React from "react";

export const ConfigSection: React.FC<{
	title: string;
	icon: string;
	description?: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
}> = ({ title, icon, description, defaultOpen = false, children }) => {
	const [open, setOpen] = React.useState(defaultOpen);
	return (
		<div
			style={{
				marginBottom: "16px",
				borderRadius: "12px",
				background: "#18181b",
				border: "1px solid #27272a",
				overflow: "hidden",
				boxShadow: "0 4px 6px rgba(0, 0, 0, 0.2)",
			}}
		>
			<button
				onClick={() => setOpen(!open)}
				style={{
					width: "100%",
					padding: "16px 20px",
					display: "flex",
					alignItems: "center",
					gap: "12px",
					background: open ? "rgba(99, 102, 241, 0.05)" : "transparent",
					border: "none",
					color: "#f4f4f5",
					cursor: "pointer",
					fontSize: "1rem",
					fontWeight: 600,
					textAlign: "left",
					borderBottom: open ? "1px solid #27272a" : "none",
					transition: "background 0.2s",
				}}
				onMouseOver={(e) => {
					if (!open) e.currentTarget.style.background = "#27272a";
				}}
				onMouseOut={(e) => {
					if (!open) e.currentTarget.style.background = "transparent";
				}}
			>
				<span style={{ fontSize: "1.2rem" }}>{icon}</span>
				<span style={{ flex: 1, letterSpacing: "-0.01em" }}>{title}</span>
				<span
					style={{
						transform: open ? "rotate(90deg)" : "rotate(0deg)",
						transition: "transform 0.2s ease-in-out",
						color: "#71717a",
						fontSize: "1.2rem",
					}}
				>
					›
				</span>
			</button>
			{open && (
				<div style={{ padding: "20px" }}>
					{description && (
						<p style={{ margin: "0 0 16px", color: "#a1a1aa", fontSize: "0.85rem", lineHeight: "1.5" }}>
							{description}
						</p>
					)}
					{children}
				</div>
			)}
		</div>
	);
};

export const Toggle: React.FC<{
	label: string;
	value: boolean;
	onChange: (v: boolean) => void;
	description?: string;
}> = ({ label, value, onChange, description }) => (
	<div
		style={{
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			padding: "10px 0",
		}}
	>
		<div>
			<div style={{ fontSize: "0.95rem", color: "#f4f4f5", fontWeight: 500 }}>{label}</div>
			{description && (
				<div style={{ fontSize: "0.8rem", color: "#71717a", marginTop: "4px" }}>{description}</div>
			)}
		</div>
		<div
			onClick={() => onChange(!value)}
			style={{
				width: "44px",
				height: "24px",
				borderRadius: "12px",
				cursor: "pointer",
				background: value ? "#6366f1" : "#3f3f46",
				position: "relative",
				transition: "background 0.2s ease",
			}}
		>
			<div
				style={{
					width: "20px",
					height: "20px",
					borderRadius: "50%",
					background: "#fff",
					position: "absolute",
					top: "2px",
					left: value ? "22px" : "2px",
					transition: "left 0.2s cubic-bezier(0.4, 0.0, 0.2, 1)",
					boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
				}}
			/>
		</div>
	</div>
);

export const Field: React.FC<{
	label: string;
	value: string | number;
	onChange: (v: string) => void;
	type?: string;
	placeholder?: string;
	description?: string;
}> = ({ label, value, onChange, type = "text", placeholder, description }) => (
	<div style={{ marginBottom: "16px" }}>
		<label
			style={{
				display: "block",
				fontSize: "0.85rem",
				color: "#a1a1aa",
				marginBottom: "6px",
				fontWeight: 500,
			}}
		>
			{label}
		</label>
		{description && (
			<div style={{ fontSize: "0.75rem", color: "#71717a", marginBottom: "8px" }}>
				{description}
			</div>
		)}
		<input
			type={type}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			style={{
				width: "100%",
				padding: "10px 14px",
				borderRadius: "8px",
				border: "1px solid #3f3f46",
				background: "#09090b",
				color: "#f4f4f5",
				fontSize: "0.95rem",
				outline: "none",
				fontFamily: type === "password" ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" : "inherit",
				transition: "border-color 0.2s",
				boxSizing: "border-box",
			}}
			onFocus={(e) => e.target.style.borderColor = "#6366f1"}
			onBlur={(e) => e.target.style.borderColor = "#3f3f46"}
		/>
	</div>
);

export const Select: React.FC<{
	label: string;
	value: string;
	options: string[];
	onChange: (v: string) => void;
	description?: string;
}> = ({ label, value, options, onChange, description }) => (
	<div style={{ marginBottom: "16px" }}>
		<label
			style={{
				display: "block",
				fontSize: "0.85rem",
				color: "#a1a1aa",
				marginBottom: "6px",
				fontWeight: 500,
			}}
		>
			{label}
		</label>
		{description && (
			<div style={{ fontSize: "0.75rem", color: "#71717a", marginBottom: "8px" }}>
				{description}
			</div>
		)}
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			style={{
				width: "100%",
				padding: "10px 14px",
				borderRadius: "8px",
				border: "1px solid #3f3f46",
				background: "#09090b",
				color: "#f4f4f5",
				fontSize: "0.95rem",
				outline: "none",
				cursor: "pointer",
				appearance: "none",
				backgroundImage: "url(\"data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e\")",
				backgroundRepeat: "no-repeat",
				backgroundPosition: "right 12px center",
				backgroundSize: "16px",
				boxSizing: "border-box",
			}}
			onFocus={(e) => e.target.style.borderColor = "#6366f1"}
			onBlur={(e) => e.target.style.borderColor = "#3f3f46"}
		>
			{options.map((opt) => (
				<option key={opt} value={opt}>
					{opt}
				</option>
			))}
		</select>
	</div>
);

export const SaveButton: React.FC<{
	onClick: () => void;
	saving?: boolean;
	label?: string;
}> = ({ onClick, saving, label = "Guardar" }) => (
	<button
		onClick={onClick}
		disabled={saving}
		style={{
			padding: "10px 24px",
			borderRadius: "8px",
			border: "none",
			background: saving ? "#3f3f46" : "#6366f1",
			color: saving ? "#a1a1aa" : "#fff",
			cursor: saving ? "not-allowed" : "pointer",
			fontWeight: 600,
			fontSize: "0.95rem",
			transition: "all 0.2s",
			boxShadow: saving ? "none" : "0 2px 4px rgba(99, 102, 241, 0.2)",
		}}
		onMouseOver={(e) => {
			if (!saving) e.currentTarget.style.background = "#4f46e5";
		}}
		onMouseOut={(e) => {
			if (!saving) e.currentTarget.style.background = "#6366f1";
		}}
	>
		{saving ? "Guardando..." : label}
	</button>
);

export const StatusBadge: React.FC<{ ok: boolean; text: string }> = ({
	ok,
	text,
}) => (
	<span
		style={{
			display: "inline-flex",
			alignItems: "center",
			gap: "6px",
			padding: "4px 10px",
			borderRadius: "12px",
			fontSize: "0.75rem",
			fontWeight: 500,
			background: ok ? "rgba(16, 185, 129, 0.1)" : "rgba(255, 255, 255, 0.05)",
			color: ok ? "#10b981" : "#a1a1aa",
			border: `1px solid ${ok ? "rgba(16, 185, 129, 0.2)" : "rgba(255, 255, 255, 0.1)"}`,
		}}
	>
		<span
			style={{
				width: "6px",
				height: "6px",
				borderRadius: "50%",
				background: ok ? "#10b981" : "#71717a",
				boxShadow: ok ? "0 0 8px rgba(16, 185, 129, 0.5)" : "none",
			}}
		/>
		{text}
	</span>
);
