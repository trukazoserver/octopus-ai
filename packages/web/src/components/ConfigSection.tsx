import React from "react";

export const ConfigSection: React.FC<{
	title: string;
	icon: React.ReactNode;
	description?: string;
	defaultOpen?: boolean;
	category?: string;
	activeCategory?: string;
	children: React.ReactNode;
}> = ({
	title,
	icon,
	description,
	defaultOpen = false,
	category,
	activeCategory,
	children,
}) => {
	// Category filtering: when both are provided and differ, hide the section so
	// the sidebar can show one category at a time.
	if (category && activeCategory && category !== activeCategory) return null;

	const [open, setOpen] = React.useState(defaultOpen);
	return (
		<div
			data-category={category}
			style={{
				marginBottom: "18px",
				borderRadius: "18px",
				background: "linear-gradient(180deg, #18181b 0%, #101013 100%)",
				border: "1px solid #27272a",
				overflow: "hidden",
				boxShadow:
					"0 18px 50px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
			}}
		>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				style={{
					width: "100%",
					padding: "16px 18px",
					display: "flex",
					alignItems: "center",
					gap: "12px",
					background: open
						? "linear-gradient(180deg, #1d1d20 0%, #161618 100%)"
						: "linear-gradient(180deg, #18181b 0%, #121214 100%)",
					border: "none",
					color: "#f4f4f5",
					cursor: "pointer",
					fontSize: "0.96rem",
					fontWeight: 700,
					textAlign: "left",
					borderBottom: open ? "1px solid #27272a" : "none",
					transition: "background 0.2s",
				}}
			>
				<span
					style={{
						fontSize: "1.08rem",
						width: "30px",
						height: "30px",
						borderRadius: "12px",
						background: "#18181b",
						border: "1px solid #3f3f46",
						boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "#d4d4d8",
					}}
				>
					{icon}
				</span>
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
				<div style={{ padding: "20px", background: "#0b0b0e" }}>
					{description && (
						<p
							style={{
								margin: "0 0 16px",
								color: "#a1a1aa",
								fontSize: "0.85rem",
								lineHeight: "1.5",
							}}
						>
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
			flexWrap: "wrap",
			gap: "12px",
			padding: "10px 0",
		}}
	>
		<div>
			<div style={{ fontSize: "0.95rem", color: "#f4f4f5", fontWeight: 700 }}>
				{label}
			</div>
			{description && (
				<div
					style={{
						fontSize: "0.8rem",
						color: "#a1a1aa",
						marginTop: "5px",
						lineHeight: 1.45,
					}}
				>
					{description}
				</div>
			)}
		</div>
		<button
			type="button"
			aria-pressed={value}
			onClick={() => onChange(!value)}
			style={{
				width: "44px",
				height: "24px",
				borderRadius: "12px",
				cursor: "pointer",
				background: value ? "#6366f1" : "#27272a",
				border: `1px solid ${value ? "rgba(99,102,241,.5)" : "#3f3f46"}`,
				boxShadow: value ? "0 0 14px rgba(99,102,241,.35)" : "none",
				position: "relative",
				transition: "background 0.2s ease, box-shadow 0.2s ease",
				padding: 0,
			}}
		>
			<div
				style={{
					width: "20px",
					height: "20px",
					borderRadius: "50%",
					background: value ? "#fff" : "#71717a",
					position: "absolute",
					top: "2px",
					left: value ? "22px" : "2px",
					transition: "left 0.2s cubic-bezier(0.4, 0.0, 0.2, 1)",
					boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
				}}
			/>
		</button>
	</div>
);

export const Field: React.FC<{
	label: string;
	value: string | number;
	onChange: (v: string) => void;
	type?: string;
	placeholder?: string;
	description?: string;
}> = ({ label, value, onChange, type = "text", placeholder, description }) => {
	const fieldId = React.useId();
	return (
		<div style={{ marginBottom: "16px" }}>
			<label
				htmlFor={fieldId}
				style={{
					display: "block",
					fontSize: "0.85rem",
					color: "#d4d4d8",
					marginBottom: "6px",
					fontWeight: 700,
				}}
			>
				{label}
			</label>
			{description && (
				<div
					style={{
						fontSize: "0.78rem",
						color: "#a1a1aa",
						marginBottom: "9px",
						lineHeight: 1.45,
					}}
				>
					{description}
				</div>
			)}
			<input
				id={fieldId}
				name={fieldId}
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				autoComplete="off"
				style={{
					width: "100%",
					padding: "12px 14px",
					borderRadius: "12px",
					border: "1px solid #3f3f46",
					background: "#09090b",
					color: "#f4f4f5",
					fontSize: "0.95rem",
					outline: "none",
					fontFamily:
						type === "password"
							? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
							: "inherit",
					transition: "border-color 0.2s",
					boxSizing: "border-box",
				}}
				onFocus={(e) => {
					e.target.style.borderColor = "#6366f1";
					e.target.style.boxShadow = "0 0 0 3px rgba(99, 102, 241, 0.16)";
				}}
				onBlur={(e) => {
					e.target.style.borderColor = "#3f3f46";
					e.target.style.boxShadow = "none";
				}}
			/>
		</div>
	);
};

export const Select: React.FC<{
	label: string;
	value: string;
	options: string[];
	onChange: (v: string) => void;
	description?: string;
	optionLabels?: Record<string, string>;
}> = ({ label, value, options, onChange, description, optionLabels }) => {
	const selectId = React.useId();
	return (
		<div style={{ marginBottom: "16px" }}>
			<label
				htmlFor={selectId}
				style={{
					display: "block",
					fontSize: "0.85rem",
					color: "#d4d4d8",
					marginBottom: "6px",
					fontWeight: 700,
				}}
			>
				{label}
			</label>
			{description && (
				<div
					style={{
						fontSize: "0.78rem",
						color: "#a1a1aa",
						marginBottom: "9px",
						lineHeight: 1.45,
					}}
				>
					{description}
				</div>
			)}
			<select
				id={selectId}
				name={selectId}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				style={{
					width: "100%",
					padding: "12px 14px",
					borderRadius: "12px",
					border: "1px solid #3f3f46",
					backgroundColor: "#09090b",
					color: "#f4f4f5",
					fontSize: "0.95rem",
					outline: "none",
					cursor: "pointer",
					appearance: "none",
					backgroundImage:
						"url(\"data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e\")",
					backgroundRepeat: "no-repeat",
					backgroundPosition: "right 12px center",
					backgroundSize: "16px",
					boxSizing: "border-box",
				}}
				onFocus={(e) => {
					e.target.style.borderColor = "#6366f1";
					e.target.style.boxShadow = "0 0 0 3px rgba(99, 102, 241, 0.16)";
				}}
				onBlur={(e) => {
					e.target.style.borderColor = "#3f3f46";
					e.target.style.boxShadow = "none";
				}}
			>
				{options.map((opt) => (
					<option key={opt} value={opt}>
						{optionLabels?.[opt] ?? opt}
					</option>
				))}
			</select>
		</div>
	);
};

export const SaveButton: React.FC<{
	onClick: () => void;
	saving?: boolean;
	label?: string;
}> = ({ onClick, saving, label = "Guardar" }) => (
	<button
		type="button"
		onClick={onClick}
		disabled={saving}
		style={{
			padding: "11px 22px",
			borderRadius: "12px",
			border: "1px solid #27272a",
			background: saving ? "#18181b" : "#f4f4f5",
			color: saving ? "#a1a1aa" : "#09090b",
			cursor: saving ? "not-allowed" : "pointer",
			fontWeight: 600,
			fontSize: "0.95rem",
			transition: "all 0.2s",
			boxShadow: saving ? "none" : "0 10px 24px rgba(0,0,0,.22)",
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
			borderRadius: "999px",
			fontSize: "0.75rem",
			fontWeight: 500,
			background: ok ? "rgba(16, 185, 129, 0.11)" : "#18181b",
			color: ok ? "#10b981" : "#a1a1aa",
			border: `1px solid ${ok ? "rgba(16, 185, 129, 0.25)" : "#27272a"}`,
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
