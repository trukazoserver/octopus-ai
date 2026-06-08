import React from "react";

export const ConfigSection: React.FC<{
	title: string;
	icon: React.ReactNode;
	description?: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
}> = ({ title, icon, description, defaultOpen = false, children }) => {
	const [open, setOpen] = React.useState(defaultOpen);
	return (
		<div
			style={{
				marginBottom: "18px",
				borderRadius: "22px",
				background: "linear-gradient(180deg, #111318 0%, #090a0d 100%)",
				border: "1px solid #2a303a",
				overflow: "hidden",
				boxShadow:
					"0 22px 60px rgba(0, 0, 0, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.045)",
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
						? "linear-gradient(180deg, #151821 0%, #101218 100%)"
						: "linear-gradient(180deg, #101218 0%, #0b0d11 100%)",
					border: "none",
					color: "#f4f4f5",
					cursor: "pointer",
					fontSize: "0.96rem",
					fontWeight: 800,
					textAlign: "left",
					borderBottom: open ? "1px solid #2a303a" : "none",
					transition: "background 0.2s",
				}}
			>
				<span
					style={{
						fontSize: "1.08rem",
						width: "30px",
						height: "30px",
						borderRadius: "12px",
						background: "#1a1d25",
						border: "1px solid #343a46",
						boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
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
				<div style={{ padding: "20px", background: "#08090c" }}>
					{description && (
						<p
							style={{
								margin: "0 0 16px",
								color: "#b4b8c3",
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
						color: "#9ca3af",
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
				background: value ? "#2f2f2f" : "#171717",
				border: `1px solid ${value ? "#4a4a4a" : "#2a2a2a"}`,
				position: "relative",
				transition: "background 0.2s ease",
				padding: 0,
			}}
		>
			<div
				style={{
					width: "20px",
					height: "20px",
					borderRadius: "50%",
					background: value ? "#f4f4f5" : "#737373",
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
					color: "#a1a1aa",
					marginBottom: "6px",
					fontWeight: 700,
				}}
			>
				{label}
			</label>
			{description && (
				<div
					style={{
						fontSize: "0.76rem",
						color: "#9ca3af",
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
					border: "1px solid #343a46",
					background: "#05070a",
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
					e.target.style.borderColor = "#818cf8";
					e.target.style.boxShadow = "0 0 0 3px rgba(129, 140, 248, 0.16)";
				}}
				onBlur={(e) => {
					e.target.style.borderColor = "#343a46";
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
					color: "#a1a1aa",
					marginBottom: "6px",
					fontWeight: 700,
				}}
			>
				{label}
			</label>
			{description && (
				<div
					style={{
						fontSize: "0.76rem",
						color: "#9ca3af",
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
					border: "1px solid #343a46",
					backgroundColor: "#05070a",
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
					e.target.style.borderColor = "#818cf8";
					e.target.style.boxShadow = "0 0 0 3px rgba(129, 140, 248, 0.16)";
				}}
				onBlur={(e) => {
					e.target.style.borderColor = "#343a46";
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
			border: "1px solid #2a2a2a",
			background: saving ? "#121212" : "#f4f4f5",
			color: saving ? "#a1a1aa" : "#050505",
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
			background: ok ? "rgba(16, 185, 129, 0.11)" : "#111",
			color: ok ? "#10b981" : "#a1a1aa",
			border: `1px solid ${ok ? "rgba(16, 185, 129, 0.25)" : "#242424"}`,
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
