import type React from "react";

export type AppIconName =
	| "activity"
	| "agent"
	| "automation"
	| "brain"
	| "chat"
	| "check"
	| "chevronDown"
	| "chevronRight"
	| "code"
	| "database"
	| "edit"
	| "file"
	| "folder"
	| "globe"
	| "home"
	| "key"
	| "lock"
	| "menu"
	| "message"
	| "music"
	| "octopus"
	| "panel"
	| "play"
	| "plug"
	| "server"
	| "settings"
	| "spark"
	| "tools"
	| "trash"
	| "user"
	| "video"
	| "warning";

interface AppIconProps {
	name: AppIconName;
	size?: number;
	strokeWidth?: number;
	className?: string;
}

const paths: Record<AppIconName, React.ReactNode> = {
	activity: <path d="M4 12h3l2-6 4 12 2-6h5" />,
	agent: (
		<>
			<rect x="6" y="8" width="12" height="10" rx="3" />
			<path d="M9 8V6a3 3 0 0 1 6 0v2" />
			<path d="M9.5 13h.01M14.5 13h.01" />
			<path d="M10 17h4" />
		</>
	),
	automation: (
		<>
			<path d="M13 2 5 14h6l-1 8 9-13h-6l0-7z" />
		</>
	),
	brain: (
		<>
			<path d="M9 5a3 3 0 0 0-3 3v1a4 4 0 0 0 0 8v1a3 3 0 0 0 5 2" />
			<path d="M15 5a3 3 0 0 1 3 3v1a4 4 0 0 1 0 8v1a3 3 0 0 1-5 2" />
			<path d="M12 4v18" />
			<path d="M8 12h3M13 12h3M8 16h2M14 16h2" />
		</>
	),
	chat: (
		<>
			<path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
			<path d="M8 10h8M8 14h5" />
		</>
	),
	check: <path d="m5 12 4 4L19 6" />,
	chevronDown: <path d="m6 9 6 6 6-6" />,
	chevronRight: <path d="m9 6 6 6-6 6" />,
	code: <path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" />,
	database: (
		<>
			<ellipse cx="12" cy="5" rx="7" ry="3" />
			<path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
			<path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
		</>
	),
	edit: (
		<>
			<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" />
			<path d="m13.5 6.5 4 4" />
		</>
	),
	file: (
		<>
			<path d="M7 3h7l4 4v14H7z" />
			<path d="M14 3v5h5M9 13h6M9 17h4" />
		</>
	),
	folder: (
		<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
		</>
	),
	home: <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" />,
	key: (
		<path d="M15 7a4 4 0 1 1-2.8 6.8L5 21H3v-2l7.2-7.2A4 4 0 0 1 15 7zM18 6l1-1" />
	),
	lock: (
		<>
			<rect x="5" y="10" width="14" height="10" rx="2" />
			<path d="M8 10V7a4 4 0 0 1 8 0v3" />
		</>
	),
	menu: <path d="M4 7h16M4 12h16M4 17h16" />,
	message: <path d="M4 5h16v11H8l-4 4z" />,
	music: (
		<>
			<path d="M9 18V5l10-2v13" />
			<circle cx="6" cy="18" r="3" />
			<circle cx="16" cy="16" r="3" />
		</>
	),
	octopus: (
		<>
			<path d="M8 11a4 4 0 0 1 8 0v5H8z" />
			<path d="M8 16c-2 0-3 1-3 3M10 16c-1 0-2 1-2 3M14 16c1 0 2 1 2 3M16 16c2 0 3 1 3 3" />
			<path d="M10 12h.01M14 12h.01" />
		</>
	),
	panel: <path d="M4 5h16v14H4zM9 5v14" />,
	play: <path d="M8 5v14l11-7z" />,
	plug: (
		<>
			<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z" />
			<path d="M12 16v5" />
		</>
	),
	server: (
		<>
			<rect x="4" y="4" width="16" height="6" rx="2" />
			<rect x="4" y="14" width="16" height="6" rx="2" />
			<path d="M8 7h.01M8 17h.01" />
		</>
	),
	settings: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 3a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 3h5l.3-3a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z" />
		</>
	),
	spark: (
		<path d="M12 2v6M12 16v6M4.9 4.9l4.2 4.2M14.9 14.9l4.2 4.2M2 12h6M16 12h6M4.9 19.1l4.2-4.2M14.9 9.1l4.2-4.2" />
	),
	tools: (
		<path d="M14.7 6.3a4 4 0 0 0-5 5L4 17v3h3l5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-2.8-.7-.7-2.8z" />
	),
	trash: (
		<>
			<path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14" />
			<path d="M9 7V4h6v3" />
		</>
	),
	user: (
		<>
			<circle cx="12" cy="8" r="4" />
			<path d="M4 21a8 8 0 0 1 16 0" />
		</>
	),
	video: (
		<>
			<rect x="4" y="6" width="12" height="12" rx="2" />
			<path d="m16 10 4-2v8l-4-2" />
		</>
	),
	warning: <path d="M12 3 2 21h20zM12 9v5M12 17h.01" />,
};

export const AppIcon: React.FC<AppIconProps> = ({
	name,
	size = 18,
	strokeWidth = 1.8,
	className,
}) => (
	<svg
		className={className}
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={strokeWidth}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		{paths[name]}
	</svg>
);
