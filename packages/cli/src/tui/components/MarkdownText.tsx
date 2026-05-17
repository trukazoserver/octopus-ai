import { Box, Text } from "ink";
import React from "react";
import { colors } from "../theme.js";

type MdBlock =
	| { type: "paragraph"; content: string }
	| { type: "heading"; level: number; content: string }
	| { type: "code_block"; lang?: string; content: string }
	| { type: "list_item"; ordered?: boolean; index?: number; content: string }
	| { type: "blockquote"; content: string }
	| {
			type: "table";
			headers: string[];
			rows: string[][];
			aligns: ("left" | "center" | "right")[];
	  }
	| { type: "hr" };

type InlinePart = {
	type: "text" | "bold" | "italic" | "code" | "link" | "strike";
	content: string;
	key: string;
};

function makeUniqueKey(base: string, counts: Map<string, number>): string {
	const count = counts.get(base) ?? 0;
	counts.set(base, count + 1);
	return `${base}:${count}`;
}

function parseMarkdownBlocks(raw: string): MdBlock[] {
	const blocks: MdBlock[] = [];
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();

		if (!trimmed) {
			i++;
			continue;
		}

		if (/^-{3,}$/.test(trimmed)) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}

		const tableRowMatch = line.match(/^\|(.+)\|$/);
		if (tableRowMatch) {
			const cells = tableRowMatch[1].split("|").map((c) => c.trim());
			if (i + 1 < lines.length) {
				const nextLine = (lines[i + 1] ?? "").trim();
				const sepMatch = nextLine.match(
					/^\|?(\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*)\|?$/,
				);
				if (sepMatch) {
					const sepCells = nextLine
						.replace(/^\|/, "")
						.replace(/\|$/, "")
						.split("|")
						.map((c) => c.trim());
					const aligns = sepCells.map((c) => {
						if (c.startsWith(":") && c.endsWith(":")) return "center" as const;
						if (c.endsWith(":")) return "right" as const;
						return "left" as const;
					});
					const headers = cells;
					const rows: string[][] = [];
					let j = i + 2;
					while (j < lines.length) {
						const rowLine = (lines[j] ?? "").trim();
						const rowMatch = rowLine.match(/^\|(.+)\|$/);
						if (!rowMatch) break;
						rows.push(rowMatch[1].split("|").map((c) => c.trim()));
						j++;
					}
					blocks.push({ type: "table", headers, rows, aligns });
					i = j;
					continue;
				}
			}
		}

		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1].length,
				content: heading[2],
			});
			i++;
			continue;
		}

		if (line.startsWith("```")) {
			const lang = line.slice(3).trim() || undefined;
			const code: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				code.push(lines[i] ?? "");
				i++;
			}
			if (i < lines.length) i++;
			blocks.push({ type: "code_block", lang, content: code.join("\n") });
			continue;
		}

		const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
		if (unordered) {
			blocks.push({ type: "list_item", content: unordered[1] });
			i++;
			continue;
		}

		const ordered = line.match(/^\s*(\d+)\.\s+(.*)$/);
		if (ordered) {
			blocks.push({
				type: "list_item",
				ordered: true,
				index: Number.parseInt(ordered[1], 10),
				content: ordered[2],
			});
			i++;
			continue;
		}

		if (line.startsWith("> ")) {
			blocks.push({ type: "blockquote", content: line.slice(2) });
			i++;
			continue;
		}

		const para: string[] = [];
		while (i < lines.length) {
			const current = lines[i] ?? "";
			if (
				!current.trim() ||
				current.startsWith("```") ||
				current.startsWith("> ") ||
				/^(#{1,6})\s+/.test(current) ||
				/^\s*[-*+]\s+/.test(current) ||
				/^\s*\d+\.\s+/.test(current) ||
				/^-{3,}$/.test(current.trim()) ||
				/^\|(.+)\|$/.test(current.trim())
			) {
				break;
			}
			para.push(current.trimEnd());
			i++;
		}
		blocks.push({ type: "paragraph", content: para.join(" ") });
	}

	return blocks;
}

function parseInline(text: string): InlinePart[] {
	const parts: InlinePart[] = [];
	const re =
		/(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|~~([^~]+)~~|\[([^\]]+)\]\(([^)]+)\))/g;
	let last = 0;
	let match = re.exec(text);

	while (match) {
		if (match.index > last)
			parts.push({
				type: "text",
				content: text.slice(last, match.index),
				key: `text:${last}:${match.index}`,
			});
		if (match[2])
			parts.push({
				type: "bold",
				content: match[2],
				key: `bold:${match.index}:${match[0].length}`,
			});
		else if (match[3])
			parts.push({
				type: "code",
				content: match[3],
				key: `code:${match.index}:${match[0].length}`,
			});
		else if (match[4])
			parts.push({
				type: "italic",
				content: match[4],
				key: `italic:${match.index}:${match[0].length}`,
			});
		else if (match[5])
			parts.push({
				type: "strike",
				content: match[5],
				key: `strike:${match.index}:${match[0].length}`,
			});
		else if (match[6])
			parts.push({
				type: "link",
				content: match[6],
				key: `link:${match.index}:${match[0].length}`,
			});
		last = match.index + match[0].length;
		match = re.exec(text);
	}

	if (last < text.length)
		parts.push({
			type: "text",
			content: text.slice(last),
			key: `text:${last}`,
		});
	return parts.length
		? parts
		: [{ type: "text", content: text, key: "text:0" }];
}

function wrapText(text: string, width: number): string[] {
	const max = Math.max(10, width);
	const words = text.split(/(\s+)/);
	const lines: string[] = [];
	let line = "";

	for (const word of words) {
		if (line.length + word.length > max && line.trim()) {
			lines.push(line.trimEnd());
			line = word.trimStart();
		} else {
			line += word;
		}
	}

	if (line.trimEnd()) lines.push(line.trimEnd());
	return lines.length ? lines : [""];
}

function InlineText({ text, dim = false }: { text: string; dim?: boolean }) {
	return (
		<Text color={dim ? colors.textDim : colors.text}>
			{parseInline(text).map((part) => {
				switch (part.type) {
					case "bold":
						return (
							<Text key={part.key} bold color={colors.text}>
								{part.content}
							</Text>
						);
					case "italic":
						return (
							<Text key={part.key} italic color={colors.text}>
								{part.content}
							</Text>
						);
					case "code":
						return (
							<Text
								key={part.key}
								color={colors.coral}
							>{` ${part.content} `}</Text>
						);
					case "link":
						return (
							<Text key={part.key} underline color={colors.accentBright}>
								{part.content}
							</Text>
						);
					case "strike":
						return (
							<Text key={part.key} strikethrough color={colors.textDim}>
								{part.content}
							</Text>
						);
					default:
						return part.content;
				}
			})}
		</Text>
	);
}

function CodeBlock({
	block,
	width,
}: { block: Extract<MdBlock, { type: "code_block" }>; width: number }) {
	const inner = Math.max(16, width - 4);
	const header = block.lang ? ` ${block.lang} ` : "";
	const codeLines = block.content.split("\n");
	const lineCounts = new Map<string, number>();
	const codeLineEntries = codeLines.map((line) => ({
		line,
		key: makeUniqueKey(`code-line:${line}`, lineCounts),
	}));

	return (
		<Box flexDirection="column">
			<Text color={colors.muted}>{`┌${header.padEnd(inner, "─")}┐`}</Text>
			{codeLineEntries.map(({ line, key }) => (
				<Text key={key} color={colors.textDim}>
					<Text color={colors.muted}>│ </Text>
					{line.length > inner - 2
						? `${line.slice(0, inner - 3)}…`
						: line.padEnd(inner - 2)}
					<Text color={colors.muted}> │</Text>
				</Text>
			))}
			<Text color={colors.muted}>{`└${"─".repeat(inner)}┘`}</Text>
		</Box>
	);
}

function stripMarkdown(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/(\*\*|__)(.*?)\1/g, "$2")
		.replace(/(\*|_)(.*?)\1/g, "$2")
		.replace(/~~(.*?)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function charWidth(char: string): number {
	const codePoint = char.codePointAt(0) ?? 0;
	if (
		(codePoint >= 0x300 && codePoint <= 0x36f) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f)
	)
		return 0;
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2329 && codePoint <= 0x232a) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1faff)
	)
		return 2;
	return 1;
}

function visibleWidth(text: string): number {
	return Array.from(text).reduce((total, char) => total + charWidth(char), 0);
}

function sliceVisible(text: string, width: number): string {
	let current = 0;
	let output = "";
	for (const char of Array.from(text)) {
		const next = current + charWidth(char);
		if (next > width) break;
		output += char;
		current = next;
	}
	return output;
}

function fitVisible(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) {
		return `${text}${" ".repeat(width - visibleWidth(text))}`;
	}
	const truncated = sliceVisible(text, Math.max(0, width - 1));
	return `${truncated}…${" ".repeat(Math.max(0, width - visibleWidth(truncated) - 1))}`;
}

function alignVisible(
	text: string,
	align: "left" | "center" | "right",
	width: number,
): string {
	const fitted = fitVisible(text, width);
	const contentWidth = visibleWidth(fitted.trimEnd());
	const padding = Math.max(0, width - contentWidth);
	if (align === "right") return `${" ".repeat(padding)}${fitted.trimEnd()}`;
	if (align === "center") {
		const left = Math.floor(padding / 2);
		const right = padding - left;
		return `${" ".repeat(left)}${fitted.trimEnd()}${" ".repeat(right)}`;
	}
	return fitted;
}

function normalizedTableRows(block: Extract<MdBlock, { type: "table" }>): {
	colCount: number;
	headers: string[];
	rows: string[][];
} {
	const colCount = Math.max(
		1,
		block.headers.length,
		...block.rows.map((row) => row.length),
	);
	const normalize = (row: string[]) =>
		Array.from({ length: colCount }, (_, index) =>
			stripMarkdown(row[index] ?? ""),
		);
	return {
		colCount,
		headers: normalize(block.headers),
		rows: block.rows.map(normalize),
	};
}

function getTableColumnWidths(
	block: Extract<MdBlock, { type: "table" }>,
	maxWidth: number,
): number[] {
	const { colCount, headers, rows } = normalizedTableRows(block);
	const maxContentWidth = Math.max(colCount * 3, maxWidth - (colCount * 3 + 1));
	const widths = Array.from({ length: colCount }, (_, col) => {
		const values = [headers[col] ?? "", ...rows.map((row) => row[col] ?? "")];
		return Math.max(4, ...values.map(visibleWidth));
	});
	const minWidths = headers.map((header) =>
		Math.max(4, Math.min(12, visibleWidth(header))),
	);

	while (widths.reduce((sum, value) => sum + value, 0) > maxContentWidth) {
		let largestIndex = 0;
		for (let index = 1; index < widths.length; index++) {
			if (widths[index] > widths[largestIndex]) largestIndex = index;
		}
		if (widths[largestIndex] <= (minWidths[largestIndex] ?? 4)) break;
		widths[largestIndex] -= 1;
	}

	return widths;
}

function MdTable({
	block,
	width,
}: { block: Extract<MdBlock, { type: "table" }>; width: number }) {
	const available = Math.max(20, width - 2);
	const { headers, rows } = normalizedTableRows(block);
	const colWidths = getTableColumnWidths(block, available);
	const border = (left: string, join: string, right: string) =>
		`${left}${colWidths.map((colWidth) => "─".repeat(colWidth + 2)).join(join)}${right}`;
	const renderRow = (row: string[], color: string, bold = false) => {
		const cellCounts = new Map<string, number>();
		const cells = colWidths.map((colWidth, ci) => {
			const value = row[ci] ?? "";
			return {
				colWidth,
				value,
				align: block.aligns[ci] ?? "left",
				key: makeUniqueKey(`cell:${value}:${colWidth}`, cellCounts),
			};
		});

		return (
			<Text>
				<Text color={colors.muted}>│</Text>
				{cells.map(({ colWidth, value, align, key }) => (
					<Text key={key} color={color} bold={bold}>
						{" "}
						{alignVisible(value, align, colWidth)}{" "}
						<Text color={colors.muted}>│</Text>
					</Text>
				))}
			</Text>
		);
	};
	const rowCounts = new Map<string, number>();
	const rowEntries = rows.map((row) => ({
		row,
		key: makeUniqueKey(`row:${row.join("|")}`, rowCounts),
	}));

	return (
		<Box flexDirection="column">
			<Text color={colors.muted}>{border("┌", "┬", "┐")}</Text>
			{renderRow(headers, colors.accent, true)}
			<Text color={colors.muted}>{border("├", "┼", "┤")}</Text>
			{rowEntries.map(({ row, key }) => (
				<React.Fragment key={key}>{renderRow(row, colors.text)}</React.Fragment>
			))}
			<Text color={colors.muted}>{border("└", "┴", "┘")}</Text>
		</Box>
	);
}

export function MarkdownText({
	text,
	width,
}: { text: string; width?: number }) {
	const w = Math.max(20, width ?? 80);
	const blocks = React.useMemo(() => parseMarkdownBlocks(text), [text]);
	const blockCounts = new Map<string, number>();

	return (
		<Box flexDirection="column">
			{blocks.map((block) => {
				const blockKey = makeUniqueKey(
					`block:${block.type}:${"content" in block ? block.content : JSON.stringify(block)}`,
					blockCounts,
				);
				if (block.type === "hr") {
					return (
						<Text key={blockKey} color={colors.muted}>
							{"─".repeat(Math.max(10, w - 2))}
						</Text>
					);
				}
				if (block.type === "heading") {
					return (
						<Text
							key={blockKey}
							bold
							color={colors.accent}
						>{`${"#".repeat(block.level)} ${block.content}`}</Text>
					);
				}
				if (block.type === "code_block") {
					return <CodeBlock key={blockKey} block={block} width={w} />;
				}
				if (block.type === "table") {
					return <MdTable key={blockKey} block={block} width={w} />;
				}

				const prefix =
					block.type === "list_item"
						? block.ordered
							? `${block.index ?? 1}. `
							: "• "
						: block.type === "blockquote"
							? "│ "
							: "";
				const available = Math.max(10, w - prefix.length);
				const lines = wrapText(block.content, available);
				const lineCounts = new Map<string, number>();
				const lineEntries = lines.map((line) => ({
					line,
					key: makeUniqueKey(`line:${line}`, lineCounts),
				}));

				return (
					<Box key={blockKey} flexDirection="column">
						{lineEntries.map(({ line, key }, lineIndex) => (
							<Text key={key}>
								{prefix && lineIndex === 0 ? (
									<Text color={colors.accent}>{prefix}</Text>
								) : prefix ? (
									<Text>{" ".repeat(prefix.length)}</Text>
								) : null}
								<InlineText text={line} dim={block.type === "blockquote"} />
							</Text>
						))}
					</Box>
				);
			})}
		</Box>
	);
}
