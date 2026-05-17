import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { colors } from "../theme.js";

type ActivityBarProps = {
	status: string;
	toolName?: string;
	detail?: string;
	done?: boolean;
	error?: boolean;
	busy?: boolean;
};

type ActivityConfig = {
	icon: string;
	label: string;
	color: string;
	spinner?: string[];
};

const SPINNER_BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_DOTS = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const SPINNER_ARROWS = ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"];
const SPINNER_PULSE = ["◌", "○", "◉", "●", "◉", "○"];
const SPINNER_GEAR = ["◐", "◓", "◑", "◒"];
const SPINNER_BLOCKS = [
	"▏",
	"▎",
	"▍",
	"▌",
	"▋",
	"▊",
	"▉",
	"▊",
	"▋",
	"▌",
	"▍",
	"▎",
];
const SPINNER_DIAMOND = ["◇", "◈", "◆", "◈"];
const SPINNER_CIRCLE = ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"];
const SPINNER_WAVE = ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"];
const SPINNER_CODE = ["░", "▒", "▓", "█", "▓", "▒"];
const SPINNER_MEMORY = ["⬡", "⬢", "⬣", "⬢"];
const SPINNER_LOAD = ["◴", "◵", "◵", "◶", "◷", "◷", "◶", "◷"];

function getActivityConfig(status: string): ActivityConfig {
	switch (status) {
		case "thinking":
			return {
				icon: "✦",
				label: "Thinking",
				color: colors.accentBright,
				spinner: SPINNER_BRAILLE,
			};
		case "responding":
			return {
				icon: ">",
				label: "Writing response",
				color: colors.text,
				spinner: SPINNER_BLOCKS,
			};
		case "tool":
			return {
				icon: "⚙",
				label: "Using tool",
				color: "#60a5fa",
				spinner: SPINNER_GEAR,
			};
		case "code":
			return {
				icon: "$",
				label: "Executing code",
				color: "#a78bfa",
				spinner: SPINNER_CODE,
			};
		case "tool_done":
			return { icon: "✓", label: "Tool completed", color: colors.good };
		case "tool_error":
			return { icon: "✗", label: "Tool error", color: colors.error };
		case "tool_skipped":
			return { icon: "○", label: "Tool skipped", color: colors.warn };
		case "memory":
			return {
				icon: "◈",
				label: "Consolidating memory",
				color: "#34d399",
				spinner: SPINNER_MEMORY,
			};
		case "embedding":
			return {
				icon: "◉",
				label: "Generating embeddings",
				color: "#818cf8",
				spinner: SPINNER_LOAD,
			};
		case "retrieving":
			return {
				icon: "?",
				label: "Searching memory",
				color: "#38bdf8",
				spinner: SPINNER_DOTS,
			};
		case "planning":
			return {
				icon: "◈",
				label: "Planning actions",
				color: colors.accent,
				spinner: SPINNER_DIAMOND,
			};
		case "closing":
			return { icon: "−", label: "Closing session", color: colors.muted };
		case "browsing":
			return {
				icon: "◈",
				label: "Browsing web",
				color: "#60a5fa",
				spinner: SPINNER_ARROWS,
			};
		case "searching":
			return {
				icon: "?",
				label: "Searching",
				color: "#38bdf8",
				spinner: SPINNER_DOTS,
			};
		case "reading":
			return {
				icon: "READ",
				label: "Reading",
				color: "#60a5fa",
				spinner: SPINNER_WAVE,
			};
		case "writing":
			return {
				icon: "WRITE",
				label: "Writing file",
				color: "#34d399",
				spinner: SPINNER_BLOCKS,
			};
		default:
			return {
				icon: "•",
				label: status,
				color: colors.muted,
				spinner: SPINNER_CIRCLE,
			};
	}
}

function useSpinnerFrame(
	spinnerFrames: string[] | undefined,
	active: boolean,
): string {
	const [frame, setFrame] = useState(0);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		if (!active || !spinnerFrames || spinnerFrames.length === 0) return;

		intervalRef.current = setInterval(() => {
			setFrame((prev) => (prev + 1) % spinnerFrames.length);
		}, 80);

		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [active, spinnerFrames]);

	if (!active || !spinnerFrames || spinnerFrames.length === 0) {
		return "";
	}

	return spinnerFrames[frame % spinnerFrames.length];
}

export const ActivityBar = React.memo(function ActivityBar({
	status,
	toolName,
	detail,
	done,
	error,
	busy = false,
}: ActivityBarProps) {
	const config = getActivityConfig(status);
	const spinnerFrame = useSpinnerFrame(config.spinner, busy && !done);

	if (done) {
		const doneColor = error ? colors.error : colors.good;
		const doneIcon = error ? "✗" : "✓";
		const label = error ? "failed" : "done";
		return (
			<Box gap={1}>
				<Text color={doneColor} bold>
					{doneIcon}
				</Text>
				<Text color={doneColor}>{label}</Text>
				{toolName && <Text color={colors.textDim}>{toolName}</Text>}
			</Box>
		);
	}

	const displayIcon = spinnerFrame || config.icon;

	return (
		<Box gap={1}>
			<Text color={config.color} bold>
				{displayIcon}
			</Text>
			<Text color={config.color}>{config.label}</Text>
			{toolName && <Text color={colors.accent}>{toolName}</Text>}
			{detail && <Text color={colors.textDim}>{detail}</Text>}
		</Box>
	);
});
