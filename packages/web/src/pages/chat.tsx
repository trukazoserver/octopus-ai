import DOMPurify from "dompurify";
import { marked } from "marked";
import type React from "react";
import {
	Suspense,
	lazy,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { showToast } from "../components/ui/Toast.js";
import {
	API_BASE,
	apiDelete,
	apiGet,
	apiPatch,
	apiPost,
	apiPut,
	apiPutJson,
} from "../hooks/useApi.js";
import { publicAsset } from "../utils/assets.js";
import {
	fileCategory,
	fileIconSvg,
	fileTypeBadge,
	formatFileSize,
} from "../utils/file-category.js";

/** Accepted attachment types in the chat composer (images + documents/code/archives). */
const ACCEPTED_ATTACHMENT_TYPES =
	"image/*,audio/*,video/*," +
	".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.html,.htm,.log,.ini,.toml," +
	".doc,.docx,.rtf,.odt,.odp,.ppt,.pptx,.xls,.xlsx,.ods,.zip,.rar,.7z,.tar,.gz," +
	".js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.rs,.go,.java,.c,.cc,.cpp,.h,.hpp,.cs,.php,.rb," +
	".pl,.sh,.bash,.zsh,.lua,.swift,.kt,.scala,.r,.vue,.svelte,.css,.scss,.less,.sql";

function resolveWebSocketUrl(): string {
	const url = new URL(API_BASE);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

const WS_URL = resolveWebSocketUrl();
const LOGO_SRC = publicAsset("mascotas/Pulpo_octavio.png");
const ACTIVE_CONVERSATION_STORAGE_KEY = "octopus-active-conversation";
const INITIAL_VISIBLE_MESSAGES = 20;
const MESSAGE_PAGE_SIZE = 20;
const USER_MESSAGE_PREVIEW_WORDS = 180;
const USER_MESSAGE_PREVIEW_CHARS = 1800;
const SELECTED_WORKFLOW_STORAGE_KEY = "octopus-selected-workflow-run";
const RESPONSE_ACTIVITY_GRACE_MS = 1200;

const MediaLibraryPage = lazy(() =>
	import("./media-library.js").then(({ MediaLibraryPage }) => ({
		default: MediaLibraryPage,
	})),
);

interface MediaPreviewModalProps {
	src: string;
	onClose: () => void;
}

const MediaPreviewModal: React.FC<MediaPreviewModalProps> = ({
	src,
	onClose,
}) => {
	const dialogRef = useRef<HTMLDialogElement | null>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		try {
			if (!dialog.open) dialog.showModal();
		} catch {
			dialog.setAttribute("open", "");
		}

		dialog.focus();

		return () => {
			document.body.style.overflow = previousOverflow;
			if (dialog.open) dialog.close();
		};
	}, []);

	return createPortal(
		<dialog
			ref={dialogRef}
			className="media-preview-overlay"
			aria-modal="true"
			aria-label="Vista previa de imagen"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
		>
			<div className="media-preview-content">
				<div className="media-preview-frame">
					<img src={src} alt="Preview" />
				</div>
				<button
					type="button"
					className="media-preview-close"
					aria-label="Cerrar vista previa"
					onClick={onClose}
				>
					×
				</button>
			</div>
		</dialog>,
		document.body,
	);
};

interface StatusData {
	provider?: string;
	providerDisplayName?: string;
	model?: string;
	agent?: {
		id: string;
		name: string;
		model: string;
		provider?: string;
		providerDisplayName?: string;
		reasoningEffort?: string;
	};
	fallback?: string;
	thinking?: string;
	maxTokens?: number;
	channels?: string[];
	memoryEnabled?: boolean;
	skillsEnabled?: boolean;
}

interface ModelCapabilities {
	provider: string;
	providerDisplayName: string;
	model: string;
	supportsReasoning: boolean;
	allowedReasoningEfforts: string[];
	defaultReasoningEffort: string;
}

interface ModelGroup {
	providerKey: string;
	providerName: string;
	models: Array<{ value: string; label: string }>;
}

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const REASONING_LABELS: Record<ReasoningEffort, string> = {
	none: "Sin razonamiento",
	low: "Bajo",
	medium: "Medio",
	high: "Alto",
	xhigh: "Máximo",
};

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	local?: boolean;
}

interface ChatMessageWire {
	id?: string;
	role: string;
	content: string;
	timestamp?: string;
	metadata?: string | null;
	[key: string]: unknown;
}

interface WsPayload {
	kind?: string;
	content?: string;
	fullContent?: string;
	response?: string;
	text?: string;
	chunk?: string;
	error?: string;
	message?: string;
	conversationId?: string;
	agentStatus?: string;
	toolName?: string;
	uiIconB64?: string;
	activityDetail?: string | null;
	executionId?: string;
	assistantMessageId?: string | null;
	execution?: ChatExecution;
	assistantMessage?: ChatMessageWire | null;
	workflowRunId?: string;
	done?: boolean;
	cancelled?: boolean;
	status?: ChatExecutionStatus;
	completionReason?: ChatCompletionReason;
	pendingAction?: ChatPendingAction;
}

interface WsMessage {
	id: string;
	type: string;
	channel: string;
	payload: WsPayload;
	timestamp: number;
}

type AgentActivityStatus =
	| "thinking"
	| "working"
	| "orchestrating"
	| "worker_start"
	| "worker_progress"
	| "worker_done"
	| "worker_error"
	| "tool"
	| "code"
	| "responding"
	| "tool_done"
	| "tool_error"
	| "tool_skipped";

type AgentStatus = "idle" | AgentActivityStatus;

interface AgentActivity {
	id: string;
	status: AgentActivityStatus;
	label: string;
	detail: string;
	toolName?: string | null;
	iconSvg?: string | null;
	timestamp: number;
}

type MultiAgentWorkerStatus = "queued" | "running" | "done" | "error";

interface MultiAgentStep {
	id: string;
	label: string;
	detail: string;
	rawDetail?: string | null;
	timestamp: number;
	status: AgentActivityStatus;
	toolName?: string | null;
}

interface MultiAgentWorkerState {
	id: string;
	taskId?: string;
	role?: string;
	description: string;
	status: MultiAgentWorkerStatus;
	progress: number;
	current: string;
	steps: MultiAgentStep[];
	agentId?: string;
	agentName?: string;
	armKey?: string;
	agentAvatar?: string;
	agentColor?: string;
}

interface MultiAgentPlanState {
	count: number;
	executionPlan?: string;
	reasoning?: string;
}

const AGENT_ACTIVITY_STATUSES = new Set<string>([
	"thinking",
	"working",
	"orchestrating",
	"worker_start",
	"worker_progress",
	"worker_done",
	"worker_error",
	"tool",
	"code",
	"responding",
	"tool_done",
	"tool_error",
	"tool_skipped",
]);

interface Conversation {
	id: string;
	title?: string | null;
	messages?: ChatMessageWire[];
	created_at?: string;
	updated_at?: string;
	createdAt?: number;
	updatedAt?: number;
}

type ChatExecutionStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

type ChatCompletionReason =
	| "finished"
	| "pending_action"
	| "failed"
	| "cancelled"
	| "server_restart";

interface ChatPendingAction {
	kind: string;
	summary: string;
	resumable: boolean;
	toolName?: string;
}

interface ChatToolActionWire {
	id: string;
	execution_id: string;
	tool_name: string;
	arguments_json: string;
	status: "running" | "completed" | "failed" | "uncertain";
	result_json?: string | null;
	error?: string | null;
	started_at: string;
	completed_at?: string | null;
}

interface ChatExecutionActivityWire {
	id: string;
	status: string;
	toolName?: string | null;
	uiIconB64?: string | null;
	activityDetail?: string | null;
	timestamp: number;
}

interface ChatExecution {
	id: string;
	request_id?: string | null;
	conversation_id: string;
	agent_id?: string | null;
	status: ChatExecutionStatus;
	current_status?: string | null;
	activities?: string | null;
	assistant_message_id?: string | null;
	workflowRunId?: string | null;
	error?: string | null;
	completion_reason?: ChatCompletionReason | null;
	pending_action?: string | null;
	started_at?: string;
	updated_at?: string;
	completed_at?: string | null;
}

interface ConversationExecutionState {
	executionId: string;
	status: ChatExecutionStatus;
	currentStatus: AgentStatus;
	activities: AgentActivity[];
	workflowRunId?: string;
	error?: string | null;
	completionReason?: ChatCompletionReason | null;
	pendingAction?: ChatPendingAction | null;
	notified?: boolean;
}

interface Agent {
	id: string;
	name: string;
	description?: string;
	avatar?: string | null;
	color?: string | null;
	role?: string | null;
	armKey?: string | null;
	is_main?: number | boolean;
	is_builtin_arm?: number | boolean;
	effectiveModel?: string;
	reasoningEffort?: ReasoningEffort;
	capabilities?: ModelCapabilities | null;
}

function resolveAgentAvatarImage(avatar?: string | null): string | null {
	const value = avatar?.trim();
	if (!value) return LOGO_SRC;
	if (/^(https?:|data:|blob:)/i.test(value)) return value;
	if (value.startsWith("/api/")) return value;
	if (value.startsWith("/")) return publicAsset(value);
	if (/\.(png|jpe?g|gif|webp|svg)$/i.test(value)) {
		return publicAsset(`mascotas/${value}`);
	}
	return null;
}

function getAgentAvatarText(agent?: Agent | null): string {
	const avatar = agent?.avatar?.trim();
	if (avatar && !resolveAgentAvatarImage(avatar)) return avatar.slice(0, 3);
	return agent?.name?.trim().slice(0, 2).toUpperCase() || "AI";
}

function AgentAvatarContent({
	agent,
	alt,
	imageStyle,
	textStyle,
}: {
	agent?: Agent | null;
	alt: string;
	imageStyle?: React.CSSProperties;
	textStyle?: React.CSSProperties;
}) {
	const image = resolveAgentAvatarImage(agent?.avatar);
	if (image) {
		return <img src={image} alt={alt} style={imageStyle} />;
	}
	return (
		<span
			aria-label={alt}
			style={{
				fontSize: "1.45rem",
				fontWeight: 900,
				lineHeight: 1,
				color: agent?.color ?? "#f4f4f5",
				...textStyle,
			}}
		>
			{getAgentAvatarText(agent)}
		</span>
	);
}

interface UserProfileResponse {
	profile: {
		displayName: string | null;
		preferredLanguage?: string;
		communicationStyle?: string;
		preferences?: Record<string, string>;
	} | null;
}

type WorkspaceView = "chat" | "media";

interface WorkspaceRequest {
	id: number;
	view: WorkspaceView;
}

interface SpeechRecognitionAlternativeLike {
	transcript: string;
}

interface SpeechRecognitionResultLike {
	isFinal: boolean;
	length: number;
	[index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
	resultIndex: number;
	results: {
		length: number;
		[index: number]: SpeechRecognitionResultLike;
	};
}

interface SpeechRecognitionErrorEventLike extends Event {
	error: string;
}

interface SpeechRecognitionLike {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechRecognitionEventLike) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
	onend: (() => void) | null;
	start: () => void;
	stop: () => void;
	abort: () => void;
}

type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike;

interface SpeechRecognitionWindow extends Window {
	SpeechRecognition?: SpeechRecognitionConstructorLike;
	webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
}

function nanoid(): string {
	return crypto.randomUUID();
}

function toMessage(wire: ChatMessageWire): Message {
	return {
		id: wire.id || nanoid(),
		role: wire.role as "user" | "assistant",
		content: wire.content,
		timestamp: new Date(wire.timestamp || Date.now()).getTime(),
	};
}

function countMediaRefs(content: string): number {
	return (content.match(/\/api\/media\/file\//g) ?? []).length;
}

function normalizeMessageContent(content: string): string {
	return content.replace(/\r\n/g, "\n").trim();
}

function isSameMessageContent(a: Message, b: Message): boolean {
	return (
		normalizeMessageContent(a.content) === normalizeMessageContent(b.content)
	);
}

function preferRicherMessage(current: Message, incoming: Message): Message {
	if (current.role !== "assistant" || incoming.role !== "assistant") {
		return {
			...incoming,
			timestamp: Math.max(current.timestamp, incoming.timestamp),
		};
	}
	const currentMedia = countMediaRefs(current.content);
	const incomingMedia = countMediaRefs(incoming.content);
	const incomingIsRollback =
		current.content.length > incoming.content.length &&
		currentMedia >= incomingMedia;
	const incomingLostMedia = currentMedia > incomingMedia;
	if (incomingIsRollback || incomingLostMedia) {
		return {
			...current,
			timestamp: Math.max(current.timestamp, incoming.timestamp),
		};
	}
	return {
		...incoming,
		timestamp: Math.max(current.timestamp, incoming.timestamp),
	};
}

function mergeMessagesById(current: Message[], incoming: Message[]): Message[] {
	const merged = new Map<string, Message>();
	for (const message of current) merged.set(message.id, message);
	for (const message of incoming) {
		let existing = merged.get(message.id);
		if (!existing) {
			for (const candidate of merged.values()) {
				const localUserDuplicate =
					candidate.local === true &&
					message.role === "user" &&
					candidate.role === "user" &&
					isSameMessageContent(candidate, message);
				const streamAssistantDuplicate =
					candidate.id.startsWith("stream-") &&
					message.role === "assistant" &&
					candidate.role === "assistant" &&
					(isSameMessageContent(candidate, message) ||
						message.content.includes(candidate.content) ||
						candidate.content.includes(message.content));
				if (!localUserDuplicate && !streamAssistantDuplicate) continue;
				existing = candidate;
				merged.delete(candidate.id);
				break;
			}
		}
		const next = existing ? preferRicherMessage(existing, message) : message;
		merged.set(message.id, { ...next, id: message.id, local: false });
	}
	return Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function truncateActivityText(value: string): string {
	const cleaned = cleanAgentWorkText(value);
	return cleaned.length > 180
		? `${cleaned.slice(0, 177).trimEnd()}...`
		: cleaned;
}

function getActivityDisplayDetail(
	status: AgentActivityStatus,
	toolName?: string | null,
	detail?: string | null,
): string | undefined {
	const parsed = parseActivityDetailJson(detail);
	const candidate =
		asString(parsed?.message) ??
		asString(parsed?.description) ??
		asString(parsed?.reasoning) ??
		asString(parsed?.error) ??
		detail?.trim();
	if (!candidate) return undefined;
	const sanitized = truncateActivityText(candidate);
	if (!sanitized) return undefined;
	const fallback = getActivityCopy(status, toolName).detail;
	return sanitized.length > fallback.length ? sanitized : sanitized || fallback;
}

function getSpeechRecognitionConstructor():
	| SpeechRecognitionConstructorLike
	| undefined {
	const speechWindow = window as SpeechRecognitionWindow;
	return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function mergeDictationText(base: string, dictated: string): string {
	if (!dictated) return base;
	if (!base.trim()) return dictated.trimStart();
	return `${base}${/\s$/.test(base) ? "" : " "}${dictated.trimStart()}`;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatToolLabel(toolName?: string | null): string {
	if (!toolName) return "herramienta";
	return toolName.replace(/[_-]/g, " ");
}

function getActivityCopy(
	status: AgentActivityStatus,
	toolName?: string | null,
): { label: string; detail: string } {
	const toolLabel = formatToolLabel(toolName);
	switch (status) {
		case "thinking":
			return {
				label: "Pensando",
				detail: "Analizando la solicitud y preparando el siguiente paso.",
			};
		case "working":
			return {
				label: "Trabajando",
				detail: "Procesando la solicitud y preparando la siguiente acción.",
			};
		case "orchestrating":
			return {
				label: "Orquestando agentes",
				detail:
					"Dividiendo la tarea, activando brazos vivos y preparando el contexto compartido.",
			};
		case "worker_start":
			return {
				label: `Brazo ${toolLabel} activado`,
				detail: "Brazo vivo activado y comenzando su subtarea.",
			};
		case "worker_progress":
			return {
				label: `Brazo ${toolLabel} trabajando`,
				detail: "Brazo vivo ejecutando su siguiente paso.",
			};
		case "worker_done":
			return {
				label: `Brazo ${toolLabel} terminado`,
				detail: "Brazo vivo terminó su subtarea y devolvió resultado.",
			};
		case "worker_error":
			return {
				label: `Brazo ${toolLabel} falló`,
				detail: "Brazo vivo reportó un error en su subtarea.",
			};
		case "tool":
			return {
				label: `Usando ${toolLabel}`,
				detail: "Ejecutando una herramienta conectada.",
			};
		case "code":
			return {
				label: `Ejecutando ${toolLabel}`,
				detail: "Procesando código o comandos locales.",
			};
		case "responding":
			return {
				label: "Preparando respuesta",
				detail: "Organizando el resultado final para mostrarlo limpio.",
			};
		case "tool_done":
			return {
				label: `${toolLabel} completada`,
				detail: "Resultado recibido y agregado al contexto.",
			};
		case "tool_error":
			return {
				label: `${toolLabel} falló`,
				detail:
					"La herramienta devolvió un error; el agente continuará si puede.",
			};
		case "tool_skipped":
			return {
				label: `${toolLabel} omitida`,
				detail:
					"Se evitó repetir una acción o exceder el presupuesto de herramientas.",
			};
	}
}

function decodeIcon(iconB64?: string | null): string | null {
	if (!iconB64) return null;
	try {
		return atob(iconB64);
	} catch {
		return null;
	}
}

function parseActivityDetailJson(
	detail?: string | null,
): Record<string, unknown> | null {
	if (!detail) return null;
	try {
		const parsed = JSON.parse(detail) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function extractWorkflowRunIdFromDetail(
	detail?: string | null,
): string | undefined {
	const parsed = parseActivityDetailJson(detail);
	return asString(parsed?.workflowRunId);
}

function extractWorkflowRunIdFromActivities(
	activities: ChatExecutionActivityWire[],
): string | undefined {
	for (let i = activities.length - 1; i >= 0; i -= 1) {
		const workflowRunId = extractWorkflowRunIdFromDetail(
			activities[i]?.activityDetail,
		);
		if (workflowRunId) return workflowRunId;
	}
	return undefined;
}

function extractWorkflowRunIdFromExecution(
	execution: ChatExecution,
): string | undefined {
	if (execution.workflowRunId) return execution.workflowRunId;
	if (!execution.activities) return undefined;
	try {
		const raw = JSON.parse(execution.activities) as ChatExecutionActivityWire[];
		return Array.isArray(raw)
			? extractWorkflowRunIdFromActivities(raw)
			: undefined;
	} catch {
		return undefined;
	}
}

function cleanAgentWorkText(value: string): string {
	return value
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/\\n/g, " ")
		.replace(/[`*_#|[\]{}]/g, " ")
		.replace(/\/api\/media\/file\/[^\s)]+/g, "")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/Worker '[^']+' completed the task\. Result:/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function summarizeAgentWork(worker: MultiAgentWorkerState): string {
	const source = cleanAgentWorkText(
		worker.status === "done" || worker.status === "error"
			? worker.description || worker.current
			: worker.current || worker.description,
	);
	const lower = source.toLowerCase();
	let action = source;

	const sceneMatch = source.match(/escena\s+\d+/i)?.[0];
	const imageTarget =
		source.match(/imagen(?:es)?\s+(?:de|para)\s+([^.,;]+)/i)?.[1] ??
		source.match(/generaci[oó]n\s+de\s+([^.,;]+)/i)?.[1] ??
		sceneMatch;

	if (
		lower.includes("imagen") ||
		lower.includes("png") ||
		lower.includes("jpg")
	) {
		action = imageTarget
			? `generando imagen de ${imageTarget}`
			: "generando imagenes";
	} else if (lower.includes("video") || lower.includes("reel")) {
		action = sceneMatch
			? `trabajando video de ${sceneMatch}`
			: "trabajando en video";
	} else if (
		lower.includes("codigo") ||
		lower.includes("code") ||
		lower.includes("script")
	) {
		action = "ejecutando codigo";
	} else if (
		lower.includes("search") ||
		lower.includes("web") ||
		lower.includes("scrape")
	) {
		action = "buscando informacion";
	}

	if (worker.status === "done")
		return action.replace(/^generando\s+/i, "completo ");
	if (worker.status === "error") return `tuvo un problema: ${action}`;
	return action.length > 92 ? `${action.slice(0, 92).trimEnd()}...` : action;
}

function getWorkerToolKind(
	worker: MultiAgentWorkerState,
): "image" | "code" | "web" | "video" | "delegate" | "tool" {
	const lastTool = worker.steps.at(-1)?.toolName?.toLowerCase() ?? "";
	const haystack =
		`${lastTool} ${worker.current} ${worker.description}`.toLowerCase();
	if (
		haystack.includes("image") ||
		haystack.includes("imagen") ||
		haystack.includes("png") ||
		haystack.includes("jpg") ||
		haystack.includes("nano-banana")
	)
		return "image";
	if (
		haystack.includes("video") ||
		haystack.includes("reel") ||
		haystack.includes("veo")
	)
		return "video";
	if (
		haystack.includes("code") ||
		haystack.includes("codigo") ||
		haystack.includes("execute_code") ||
		haystack.includes("shell")
	)
		return "code";
	if (
		haystack.includes("web") ||
		haystack.includes("search") ||
		haystack.includes("browser") ||
		haystack.includes("scrape")
	)
		return "web";
	if (haystack.includes("delegate")) return "delegate";
	return "tool";
}

function ToolBadge({
	kind,
	active,
}: { kind: ReturnType<typeof getWorkerToolKind>; active: boolean }) {
	const labels = {
		image: "IMG",
		code: "CODE",
		web: "WEB",
		video: "VID",
		delegate: "TASK",
		tool: "TOOL",
	};
	const glyphs = {
		image: "▧",
		code: "</>",
		web: "⌕",
		video: "▶",
		delegate: "⇄",
		tool: "⚙",
	};
	return (
		<span
			className={`worker-tool-badge ${active ? "active" : ""}`}
			data-kind={kind}
			data-tooltip={labels[kind]}
		>
			{glyphs[kind]}
		</span>
	);
}

function toAgentActivity(
	activity: ChatExecutionActivityWire,
): AgentActivity | null {
	if (!AGENT_ACTIVITY_STATUSES.has(activity.status)) return null;
	const status = activity.status as AgentActivityStatus;
	const copy = getActivityCopy(status, activity.toolName);
	return {
		id: activity.id,
		status,
		label: copy.label,
		detail:
			getActivityDisplayDetail(
				status,
				activity.toolName,
				activity.activityDetail,
			) || copy.detail,
		toolName: activity.toolName ?? null,
		iconSvg: decodeIcon(activity.uiIconB64),
		timestamp: activity.timestamp,
	};
}

function parseExecutionActivities(execution: ChatExecution): AgentActivity[] {
	if (!execution.activities) return [];
	try {
		const raw = JSON.parse(execution.activities) as ChatExecutionActivityWire[];
		return raw
			.map(toAgentActivity)
			.filter((item): item is AgentActivity => Boolean(item));
	} catch {
		return [];
	}
}

function createFallbackAgentActivity(status?: AgentStatus): AgentActivity {
	const activityStatus: AgentActivityStatus =
		status && status !== "idle" ? status : "working";
	const copy = getActivityCopy(activityStatus);
	return {
		id: "active-execution-fallback",
		status: activityStatus,
		label:
			activityStatus === "working" || activityStatus === "thinking"
				? "Octopus trabajando"
				: copy.label,
		detail:
			"Octopus sigue trabajando. Esperando el siguiente evento de progreso.",
		timestamp: Date.now(),
	};
}

function executionStateFromRecord(
	execution: ChatExecution,
): ConversationExecutionState {
	const activities = parseExecutionActivities(execution);
	const currentStatus =
		execution.current_status &&
		AGENT_ACTIVITY_STATUSES.has(execution.current_status)
			? (execution.current_status as AgentActivityStatus)
			: execution.status === "queued" || execution.status === "running"
				? "working"
				: "idle";
	return {
		executionId: execution.id,
		status: execution.status,
		currentStatus,
		activities,
		workflowRunId: extractWorkflowRunIdFromExecution(execution),
		error: execution.error,
		completionReason: execution.completion_reason,
		pendingAction: parsePendingAction(execution.pending_action),
	};
}

function parsePendingAction(value: unknown): ChatPendingAction | null {
	if (!value) return null;
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		if (!parsed || typeof parsed !== "object") return null;
		const candidate = parsed as Record<string, unknown>;
		if (typeof candidate.summary !== "string") return null;
		return {
			kind: typeof candidate.kind === "string" ? candidate.kind : "continue",
			summary: candidate.summary,
			resumable: candidate.resumable !== false,
			toolName:
				typeof candidate.toolName === "string" ? candidate.toolName : undefined,
		};
	} catch {
		return null;
	}
}

function isExecutionActive(state?: ConversationExecutionState): boolean {
	return state?.status === "queued" || state?.status === "running";
}

function activityColor(status: AgentActivityStatus): string {
	if (status === "orchestrating") return "#a78bfa";
	if (status === "worker_start" || status === "worker_progress")
		return "#38bdf8";
	if (status === "worker_done") return "#34d399";
	if (status === "worker_error") return "#ef4444";
	if (status === "tool_skipped") return "#a1a1aa";
	if (status === "tool" || status === "tool_done") return "#f59e0b";
	if (status === "code") return "#10b981";
	if (status === "tool_error") return "#ef4444";
	if (status === "responding") return "#60a5fa";
	return "#818cf8";
}

// Semantic action kinds derived from the activity status, the tool in use and
// the detail text. Each kind maps to a distinct animated glyph so the card shows
// what Octopus is *actually* doing (writing, browsing, searching memory, ...).
type AgentActionKind =
	| "thinking"
	| "writing"
	| "reading"
	| "web"
	| "memory"
	| "image-analysis"
	| "image-generation"
	| "video"
	| "code"
	| "search"
	| "delegate"
	| "message"
	| "plan"
	| "media"
	| "responding"
	| "orchestrating"
	| "done"
	| "error"
	| "skipped"
	| "tool";

function getActivityActionKind(activity: AgentActivity): AgentActionKind {
	const status = activity.status;
	if (status === "thinking") return "thinking";
	if (status === "responding") return "responding";
	if (status === "tool_done" || status === "worker_done") return "done";
	if (status === "tool_error" || status === "worker_error") return "error";
	if (status === "tool_skipped") return "skipped";
	if (status === "orchestrating") return "orchestrating";

	const tool = (activity.toolName ?? "").toLowerCase();
	const detail = (activity.detail ?? "").toLowerCase();

	if (tool.includes("delegate") || tool.includes("agent_spawn"))
		return "delegate";
	if (
		tool.includes("send_message") ||
		tool.includes("broadcast") ||
		tool.includes("ask_orchestrator") ||
		tool.includes("report_file") ||
		tool.includes("list_messages") ||
		tool.includes("mark_messages")
	)
		return "message";
	if (
		tool.startsWith("kanban") ||
		tool.startsWith("workflow") ||
		tool.includes("schedule_task") ||
		tool.includes("list_tasks")
	)
		return "plan";

	// Image generation vs. analysis vs. video (checked before generic web/code).
	if (
		tool.includes("nano-banana") ||
		(detail.includes("gener") &&
			(detail.includes("imagen") || detail.includes("image")))
	)
		return "image-generation";
	if (
		tool.includes("veo") ||
		detail.includes("video") ||
		detail.includes("reel")
	)
		return "video";
	if (
		tool.includes("extract_images") ||
		detail.includes("analiz") ||
		((detail.includes("imagen") || detail.includes("image")) &&
			!detail.includes("gener"))
	)
		return "image-analysis";

	if (
		tool.startsWith("browser") ||
		tool.includes("decodo") ||
		tool.includes("scrape")
	)
		return "web";

	if (
		tool.includes("execute_code") ||
		tool.includes("install_package") ||
		tool.includes("create_tool") ||
		tool.includes("manage_workspace") ||
		tool.includes("sandbox") ||
		tool.includes("run_command") ||
		status === "code"
	)
		return "code";

	if (
		tool === "write_file" ||
		tool === "edit_file" ||
		detail.includes("escribi") ||
		detail.includes("editand") ||
		detail.includes("redactand")
	)
		return "writing";
	if (tool === "read_file" || detail.includes("leyendo")) return "reading";
	if (
		tool === "search_files" ||
		tool === "list_directory" ||
		tool === "create_directory"
	)
		return "search";

	if (
		tool.includes("save_media") ||
		tool.includes("list_media") ||
		tool.includes("import_media")
	)
		return "media";

	if (
		tool.includes("memory") ||
		detail.includes("memoria") ||
		detail.includes("recuerd")
	)
		return "memory";

	return "tool";
}

function renderActionGlyph(kind: AgentActionKind): React.ReactNode {
	switch (kind) {
		case "thinking":
			return (
				<>
					<path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
					<path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
					<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
					<path d="M17.599 6.5a3 3 0 0 0 .399-1.358" />
					<path d="M6.401 6.5a3 3 0 0 1-.399-1.358" />
				</>
			);
		case "writing":
			return (
				<>
					<path d="M12 20h9" />
					<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
				</>
			);
		case "reading":
			return (
				<>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<path d="M14 2v6h6" />
					<path d="M8 13h8" />
					<path d="M8 17h6" />
				</>
			);
		case "web":
			return (
				<>
					<circle cx="12" cy="12" r="9" />
					<path d="M3 12h18" />
					<path d="M12 3a14 14 0 0 1 0 18" />
					<path d="M12 3a14 14 0 0 0 0 18" />
				</>
			);
		case "memory":
			return (
				<>
					<path d="M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3Z" />
					<path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
					<path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
				</>
			);
		case "image-analysis":
			return (
				<>
					<path d="M3 7V5a2 2 0 0 1 2-2h2" />
					<path d="M17 3h2a2 2 0 0 1 2 2v2" />
					<path d="M21 17v2a2 2 0 0 1-2 2h-2" />
					<path d="M7 21H5a2 2 0 0 1-2-2v-2" />
					<circle cx="12" cy="12" r="3" />
				</>
			);
		case "image-generation":
			return (
				<>
					<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z" />
					<path d="M19 3v4" />
					<path d="M21 5h-4" />
				</>
			);
		case "video":
			return (
				<>
					<rect x="2" y="6" width="14" height="12" rx="2" />
					<path d="m22 8-6 4 6 4z" />
				</>
			);
		case "code":
			return (
				<>
					<path d="m16 18 4-6-4-6" />
					<path d="m8 6-4 6 4 6" />
					<path d="m14.5 4-5 16" />
				</>
			);
		case "search":
			return (
				<>
					<circle cx="11" cy="11" r="7" />
					<path d="m21 21-4.3-4.3" />
				</>
			);
		case "delegate":
			return (
				<>
					<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
					<circle cx="9" cy="7" r="4" />
					<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
					<path d="M16 3.13a4 4 0 0 1 0 7.75" />
				</>
			);
		case "message":
			return (
				<>
					<path d="m22 2-7 20-4-9-9-4Z" />
					<path d="M22 2 11 13" />
				</>
			);
		case "plan":
			return (
				<>
					<path d="m3 17 2 2 4-4" />
					<path d="m3 7 2 2 4-4" />
					<path d="M13 6h8" />
					<path d="M13 12h8" />
					<path d="M13 18h8" />
				</>
			);
		case "media":
			return (
				<>
					<rect x="3" y="3" width="18" height="18" rx="2" />
					<circle cx="8.5" cy="8.5" r="1.5" />
					<path d="m21 15-5-5L5 21" />
				</>
			);
		case "responding":
			return (
				<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			);
		case "orchestrating":
			return (
				<>
					<circle cx="6" cy="6" r="2.5" />
					<circle cx="18" cy="6" r="2.5" />
					<circle cx="12" cy="18" r="2.5" />
					<path d="M7.8 7.8 10.4 15.6" />
					<path d="M16.2 7.8 13.6 15.6" />
					<path d="M8.5 6h7" />
				</>
			);
		case "done":
			return <path d="M20 6 9 17l-5-5" />;
		case "error":
			return (
				<>
					<circle cx="12" cy="12" r="9" />
					<path d="m15 9-6 6M9 9l6 6" />
				</>
			);
		case "skipped":
			return (
				<>
					<path d="M5 12h14" />
					<path d="M12 5v14" opacity="0.35" />
				</>
			);
		default:
			return (
				<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
			);
	}
}

function AgentActivityIcon({
	activity,
	active,
}: {
	activity: AgentActivity;
	active?: boolean;
}) {
	const color = activityColor(activity.status);
	const kind = getActivityActionKind(activity);
	return (
		<svg
			aria-hidden="true"
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke={color}
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{
				animation: active ? "iconPulse 1.6s infinite ease-in-out" : undefined,
				transformOrigin: "center",
				transformBox: "fill-box",
				filter: active ? `drop-shadow(0 0 5px ${color}88)` : undefined,
			}}
		>
			{renderActionGlyph(kind)}
		</svg>
	);
}

function AgentActivityPanel({
	activities,
	multiAgentPlan,
	multiAgentWorkers,
	agent,
	workflowRunId,
	onOpenWorkflow,
}: {
	activities: AgentActivity[];
	multiAgentPlan?: MultiAgentPlanState | null;
	multiAgentWorkers?: MultiAgentWorkerState[];
	agent?: Agent | null;
	workflowRunId?: string;
	onOpenWorkflow?: (workflowRunId: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const latest = activities[activities.length - 1];
	if (!latest) return null;
	// Surface the most recent tool/file action so it stays visible briefly even
	// after the model moves on to thinking/responding. Instant tools (write_file,
	// edit_file) would otherwise flash for ~0ms and the user would only see a
	// generic state — this keeps "Creando el archivo X" on screen long enough.
	const recentTool = [...activities].reverse().find((a) => a.status === "tool");
	const surfaceRecentTool =
		!!recentTool &&
		(latest.status === "thinking" ||
			latest.status === "responding" ||
			latest.status === "tool_done") &&
		Date.now() - (recentTool.timestamp ?? 0) < 2500;
	const headline = (surfaceRecentTool ? recentTool : latest) as AgentActivity;
	// Exclude the latest activity from the history: it is already rendered as the
	// main animated card, so listing it again produced a duplicate "thinking" row.
	const recent = activities.slice(0, -1).slice(-5);
	const color = activityColor(headline.status);
	const rawWorkers = multiAgentWorkers ?? [];
	const workers = rawWorkers.length > 1 ? rawWorkers : [];
	const activeWorkers = workers.filter(
		(worker) => worker.status === "running" || worker.status === "queued",
	).length;
	const completedWorkers = workers.filter(
		(worker) => worker.status === "done",
	).length;
	const failedWorkers = workers.filter(
		(worker) => worker.status === "error",
	).length;
	let latestCompletedIndex = -1;
	for (let index = workers.length - 1; index >= 0; index -= 1) {
		if (workers[index]?.status === "done") {
			latestCompletedIndex = index;
			break;
		}
	}
	const latestCompleted =
		latestCompletedIndex >= 0 ? workers[latestCompletedIndex] : undefined;
	const showWorkerDetails = workers.length > 0 && workers.length <= 6;
	const activeGoal =
		workers.find(
			(worker) => worker.status === "running" || worker.status === "queued",
		) ?? workers[0];
	const goalText = activeGoal
		? summarizeAgentWork(activeGoal).replace(/^generando\s+/i, "generacion de ")
		: latest.detail;
	const mainSummary =
		workers.length > 0
			? latest.status === "worker_done" && latestCompleted
				? `El agente ${latestCompletedIndex + 1} completo ${summarizeAgentWork(latestCompleted).replace(/^completo\s+/i, "")}.`
				: activeWorkers > 0
					? `${activeWorkers} de ${workers.length} brazos vivos siguen trabajando en ${goalText}.`
					: failedWorkers > 0
						? `${completedWorkers}/${workers.length} brazos completaron su tarea; ${failedWorkers} tuvieron problemas.`
						: `Los ${workers.length} brazos vivos completaron sus tareas.`
			: headline.detail;
	// Only the current card is animated and visible by default; the rest of the
	// trace (plan summary, workers, historical steps) stays collapsed until the
	// user expands it, so only one thinking container is shown at a time.
	const hasHiddenDetail =
		Boolean(multiAgentPlan) || workers.length > 0 || recent.length > 0;
	const toggleLabel = expanded
		? "Ocultar detalle"
		: workers.length > 0
			? `Ver ${workers.length} agentes`
			: recent.length > 0
				? `Ver ${recent.length} paso${recent.length === 1 ? "" : "s"}`
				: "Ver detalle";

	return (
		<div className="agent-activity-row">
			<div
				className="agent-activity-avatar"
				style={{ boxShadow: `0 10px 28px ${agent?.color ?? "#ff6f3b"}24` }}
			>
				<AgentAvatarContent
					agent={agent}
					alt={agent ? `${agent.name} avatar` : "Octopus"}
				/>
				{headline.status === "thinking" && (
					<span className="agent-thought-cloud" aria-hidden="true">
						<span />
						<span />
						<span />
					</span>
				)}
			</div>
			<div
				className="agent-activity-card compact"
				style={{ borderColor: `${color}55` }}
			>
				{expanded && (multiAgentPlan || workers.length > 0) && (
					<div className="multi-agent-summary">
						<div className="multi-agent-summary-top">
							<span className="multi-agent-pill">
								{multiAgentPlan?.count ?? workers.length} agentes vivos
							</span>
							{workers.length > 0 && (
								<span className="multi-agent-pill muted">
									{completedWorkers}/{workers.length} completos
								</span>
							)}
						</div>
						<div className="multi-agent-live-text">{mainSummary}</div>
						{workflowRunId && onOpenWorkflow && (
							<button
								type="button"
								onClick={() => onOpenWorkflow(workflowRunId)}
								className="multi-agent-pill"
								style={{ marginTop: 10, cursor: "pointer" }}
							>
								Monitor durable: {workflowRunId}
							</button>
						)}
					</div>
				)}
				<div className="agent-activity-current">
					<div
						className="agent-activity-orb"
						style={{
							background: `${color}22`,
							boxShadow: `0 0 22px ${color}33`,
						}}
					>
						<AgentActivityIcon activity={headline} active />
					</div>
					<div style={{ minWidth: 0 }}>
						<div className="agent-activity-title" style={{ color }}>
							{workers.length > 0
								? "Octopus coordinando agentes vivos"
								: headline.label}
						</div>
						<div className="agent-activity-detail">{mainSummary}</div>
					</div>
					<div className="agent-activity-dots" aria-hidden="true">
						{[0, 1, 2].map((i) => (
							<span
								key={i}
								style={{ animationDelay: `${i * 0.16}s`, background: color }}
							/>
						))}
					</div>
				</div>
				{hasHiddenDetail && (
					<button
						type="button"
						className="agent-activity-toggle"
						onClick={() => setExpanded((value) => !value)}
						aria-expanded={expanded}
					>
						<svg
							aria-hidden="true"
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.4"
							strokeLinecap="round"
							strokeLinejoin="round"
							style={{
								transform: expanded ? "rotate(180deg)" : "none",
								transition: "transform .18s ease",
							}}
						>
							<path d="m6 9 6 6 6-6" />
						</svg>
						{toggleLabel}
					</button>
				)}
				{/* Show the live arm list automatically while arms are active (no
				    need to click "Ver N agentes"); collapses back when all done. */}
				{(expanded || activeWorkers > 0) && showWorkerDetails && (
					<div className="multi-agent-workers compact-list">
						{workers.map((worker, index) => {
							const statusColor =
								worker.status === "done"
									? "#34d399"
									: worker.status === "error"
										? "#ef4444"
										: "#38bdf8";
							const workerColor = worker.agentColor ?? statusColor;
							const workText = summarizeAgentWork(worker);
							const active =
								worker.status === "running" || worker.status === "queued";
							const toolKind = getWorkerToolKind(worker);
							const avatar = worker.agentAvatar;
							const workerTitle =
								worker.agentName ?? worker.role ?? `Brazo ${index + 1}`;
							return (
								<div
									key={worker.id}
									className="multi-agent-worker"
									style={{ borderColor: `${workerColor}44` }}
								>
									<div className="multi-agent-worker-head">
										<span
											className={`multi-agent-worker-avatar ${active ? "active" : ""}`}
											style={{ borderColor: `${workerColor}66` }}
										>
											{avatar?.startsWith("/") || avatar?.startsWith("http") ? (
												<img
													src={avatar}
													alt=""
													style={{
														width: 30,
														height: 30,
														borderRadius: "999px",
														objectFit: "cover",
													}}
												/>
											) : (
												<span className="agent-glyph">{avatar ?? "◎"}</span>
											)}
											<ToolBadge kind={toolKind} active={active} />
										</span>
										<span className="multi-agent-worker-title">
											{workerTitle}
										</span>
										<span
											className="multi-agent-worker-status"
											style={{ color: workerColor }}
										>
											{worker.status === "done"
												? "Completado"
												: worker.status === "error"
													? "Falló"
													: worker.status === "queued"
														? "En cola"
														: "Trabajando"}
										</span>
									</div>
									<div className="multi-agent-worker-desc">{workText}</div>
									<div className="multi-agent-progress">
										<span
											style={{
												width: `${Math.max(4, Math.min(100, worker.progress))}%`,
												background: workerColor,
											}}
										/>
									</div>
								</div>
							);
						})}
					</div>
				)}
				{expanded && workers.length > 6 && (
					<div className="multi-agent-collapsed-note">
						Detalle de {workers.length} brazos colapsado. {mainSummary}
					</div>
				)}
				{expanded && workers.length === 0 && recent.length > 0 && (
					<div className="agent-activity-steps">
						{recent.map((activity, index) => (
							<div key={activity.id} className="agent-activity-step">
								<span className="agent-activity-step-line" />
								<span className="agent-activity-step-icon">
									<AgentActivityIcon
										activity={activity}
										active={index === recent.length - 1}
									/>
								</span>
								<span className="agent-activity-step-text">
									{activity.label}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

const MEDIA_BASE = API_BASE;

function isMediaUrl(href: string): boolean {
	return (
		href.startsWith("/api/media/file/") || href.includes("/api/media/file/")
	);
}

function getMediaType(
	url: string,
): "image" | "audio" | "video" | "file" | null {
	const path = url.split("?")[0] ?? "";
	if (/\.(mp3|wav|ogg|m4a|weba|flac)(\/|$)/i.test(path)) return "audio";
	if (/\.(mp4|webm|ogv|avi|mov)(\/|$)/i.test(path)) return "video";
	if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\/|$)/i.test(path)) {
		return "image";
	}
	if (
		/\.(pdf|zip|txt|md|csv|json|doc|docx|xls|xlsx|ppt|pptx|html|xml)(\/|$)/i.test(
			path,
		)
	) {
		return "file";
	}
	if (path.includes("/api/media/file/")) return "file";
	return null;
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function getVideoPosterUrl(url: string): string {
	return url.replace("/api/media/file/", "/api/media/thumbnail/");
}

function getVideoAspectCacheKey(src: string): string {
	// Key on the stable media id so normalisation changes to the surrounding URL
	// (host, leading slash, query params) don't cause an aspect-ratio cache miss.
	const match = src.match(/\/api\/media\/file\/([^/?#]+)/);
	if (match?.[1]) return match[1];
	return src;
}

// Module-level cache of detected video aspect ratios. Survives component
// remounts (unlike a useRef) and is persisted to localStorage so it also
// survives page reloads. Read at markdown-render time so the correct ratio can
// be embedded directly into the HTML — before paint, without relying on a
// post-render useEffect that loses the race during agent re-renders.
const VIDEO_AR_STORAGE_KEY = "octopus-video-aspect-cache-v1";
const MAX_VIDEO_ASPECT_CACHE = 250;
const videoAspectRatioCache: Map<
	string,
	{ aspectRatio: string; isVertical: boolean }
> = (() => {
	try {
		const raw =
			typeof localStorage !== "undefined"
				? localStorage.getItem(VIDEO_AR_STORAGE_KEY)
				: null;
		if (raw) {
			const parsed = JSON.parse(raw) as Array<
				[string, { aspectRatio: string; isVertical: boolean }]
			>;
			return new Map(parsed.slice(-MAX_VIDEO_ASPECT_CACHE));
		}
	} catch {
		// ignore corrupt cache
	}
	return new Map();
})();
function persistVideoAspectRatioCache() {
	try {
		localStorage.setItem(
			VIDEO_AR_STORAGE_KEY,
			JSON.stringify([...videoAspectRatioCache]),
		);
	} catch {
		// storage full or unavailable; in-memory cache still works
	}
}

function getMediaFilename(url: string): string {
	try {
		const path = new URL(url, MEDIA_BASE).pathname;
		const filename = decodeURIComponent(path.split("/").pop() || "archivo");
		return filename || "archivo";
	} catch {
		return decodeURIComponent(url.split("/").pop()?.split("?")[0] || "archivo");
	}
}

function renderDownloadButton(
	url: string,
	label = "Descargar",
	corner = false,
): string {
	const safeUrl = escapeAttr(url);
	if (corner) {
		const safeLabel = escapeAttr(label);
		return `<a class="media-download media-download-corner" href="${safeUrl}" download data-download-media="true" rel="noopener noreferrer" aria-label="${safeLabel}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></a>`;
	}
	const className = corner
		? "media-download media-download-corner"
		: "media-download";
	return `<a class="${className}" href="${safeUrl}" download data-download-media="true" rel="noopener noreferrer" title="Descargar archivo">${label}</a>`;
}

function getUserMessagePreview(content: string): {
	preview: string;
	truncated: boolean;
} {
	let cutIndex = content.length;
	if (content.length > USER_MESSAGE_PREVIEW_CHARS) {
		cutIndex = USER_MESSAGE_PREVIEW_CHARS;
	}

	let wordCount = 0;
	for (const match of content.matchAll(/\S+/g)) {
		wordCount += 1;
		if (wordCount > USER_MESSAGE_PREVIEW_WORDS) {
			cutIndex = Math.min(cutIndex, match.index ?? cutIndex);
			break;
		}
	}

	if (cutIndex >= content.length) return { preview: content, truncated: false };
	return {
		preview: `${content.slice(0, cutIndex).trimEnd()}…`,
		truncated: true,
	};
}

let renderCompactMediaImages = false;
let renderAgentMediaDownloads = false;

function renderMediaInline(
	url: string,
	alt?: string,
	compactImage = renderCompactMediaImages,
	showDownload = renderAgentMediaDownloads,
): string {
	const fullUrl = url.startsWith("http") ? url : MEDIA_BASE + url;
	const mediaType = getMediaType(url);
	if (mediaType === "image") {
		const safeUrl = escapeAttr(fullUrl);
		const safeAlt = escapeAttr(alt || "Imagen adjunta");
		const imageClass = compactImage ? "media-image-thumb" : "media-image-full";
		const download = showDownload
			? renderDownloadButton(fullUrl, "Descargar", true)
			: "";
		return `<div class="media-embed media-image"><div class="media-download-frame"><a href="${safeUrl}" class="${imageClass}" data-media-preview="${safeUrl}" data-tooltip="Clic para ampliar" aria-label="Ampliar imagen"><img src="${safeUrl}" alt="${safeAlt}" loading="lazy" /></a>${download}</div></div>`;
	}
	if (mediaType === "audio") {
		const safeUrl = escapeAttr(fullUrl);
		const download = showDownload
			? renderDownloadButton(fullUrl, "Descargar", true)
			: "";
		const cardClass = showDownload
			? "media-audio-card media-has-download"
			: "media-audio-card";
		return `<div class="media-embed media-audio"><div class="${cardClass}"><audio controls src="${safeUrl}" preload="metadata"></audio>${download}</div></div>`;
	}
	if (mediaType === "video") {
		const safeUrl = escapeAttr(fullUrl);
		const posterUrl = escapeAttr(getVideoPosterUrl(fullUrl));
		const download = showDownload
			? renderDownloadButton(fullUrl, "Descargar", true)
			: "";
		const embedClass = showDownload
			? "media-embed media-video media-video-agent"
			: "media-embed media-video";
		// Embed the detected aspect ratio directly into the HTML so the correct
		// container shape survives innerHTML regeneration during agent re-renders.
		// (The post-render useEffect loses the race and its useRef cache is lost on
		// remount; this module-level cache + an embedded inline style fixes both.)
		const cached = videoAspectRatioCache.get(getVideoAspectCacheKey(fullUrl));
		const orientClass = cached
			? cached.isVertical
				? " is-vertical-video"
				: " is-horizontal-video"
			: "";
		const ratioAttr = cached
			? ` style="aspect-ratio:${cached.aspectRatio};"`
			: "";
		const frameClass = `media-download-frame media-video-frame${orientClass}`;
		return `<div class="${embedClass}"><div class="${frameClass}"${ratioAttr}><div class="video-thumbnail" data-video-src="${safeUrl}"${ratioAttr} role="button" tabindex="0" aria-label="Cargar video">
			<img src="${posterUrl}" alt="Miniatura del video" loading="lazy" />
			<div class="video-thumbnail-scrim"></div>
			<div class="video-thumbnail-play">&#9654;</div>
			<div class="video-thumbnail-label">Clic para reproducir video</div>
		</div>${download}</div></div>`;
	}
	if (mediaType === "file") {
		const filename = escapeAttr(getMediaFilename(fullUrl));
		const label = escapeAttr(alt || filename);
		const badge = fileTypeBadge(getMediaFilename(fullUrl) || fullUrl);
		const iconStyle =
			"background:transparent;border-radius:0;width:auto;height:auto;padding:0;display:inline-flex;align-items:center;justify-content:center;line-height:0";
		const download = showDownload
			? renderDownloadButton(fullUrl, "Descargar", true)
			: "";
		const cardClass = showDownload
			? "media-file-card media-has-download"
			: "media-file-card";
		return `<div class="media-embed media-file"><div class="${cardClass}"><div class="media-file-icon" aria-hidden="true" style="${iconStyle}">${fileIconSvg(badge.bg, badge.label, 44)}</div><div class="media-file-meta"><div class="media-file-title">${label}</div><div class="media-file-name">${filename}</div></div>${download}</div></div>`;
	}
	return "";
}

const mediaRenderer = {
	image({ href, text }: { href: string; text: string }): string {
		if (isMediaUrl(href)) {
			const media = renderMediaInline(
				href,
				text,
				renderCompactMediaImages,
				renderAgentMediaDownloads,
			);
			if (media) return media;
		}
		return false as unknown as string;
	},
	link({ href, text }: { href: string; text: string }): string {
		if (isMediaUrl(href)) {
			const media = renderMediaInline(
				href,
				text,
				renderCompactMediaImages,
				renderAgentMediaDownloads,
			);
			if (media) return media;
		}
		return false as unknown as string;
	},
};

marked.use({ renderer: mediaRenderer });

const CONTINUATION_CHECKPOINT_RE =
	/<!-- octopus-continuation-checkpoint[\s\S]*?-->\n?/g;
const TOOL_RESULT_MARKER_RE = /<!-- tool:[\w.-]+:(?:ok|error) -->/g;

// Strip internal agent markers (continuation checkpoints and tool-result HTML
// comments) so they never reach the user. Mirrors cleanStreamText in the CLI.
function stripInternalMarkers(raw: string): string {
	if (!raw) return raw;
	return raw
		.replace(CONTINUATION_CHECKPOINT_RE, "")
		.replace(TOOL_RESULT_MARKER_RE, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function renderMarkdown(
	text: string,
	compactImages = false,
	showMediaDownloads = false,
): string {
	const previousCompactImages = renderCompactMediaImages;
	const previousMediaDownloads = renderAgentMediaDownloads;
	renderCompactMediaImages = compactImages;
	renderAgentMediaDownloads = showMediaDownloads;
	try {
		let processed = stripInternalMarkers(text);
		// Strip think tags so they aren't displayed in the text bubble
		processed = processed.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");

		// Convert relative markdown images to absolute URLs for rendering
		processed = processed.replace(
			/!\[(.*?)\]\(\/api\/media\/file\/([^)]+)\)/g,
			`![$1](${MEDIA_BASE}/api/media/file/$2)`,
		);

		// Detect bare media URLs and convert to embeddable media
		processed = processed.replace(
			/(?:^|\n)\s*(https?:\/\/[^\s<>"']+\/(?:api\/media\/file\/)?[^\s<>"']+\.(?:png|jpg|jpeg|gif|webp|svg|mp3|wav|ogg|m4a|mp4|webm|pdf|zip|txt|md|csv|json|doc|docx|xls|xlsx|ppt|pptx)|\/api\/media\/file\/[^\s<>"']+)/gi,
			(match: string, url: string) => {
				const fullUrl = url.startsWith("http") ? url : MEDIA_BASE + url;
				const mediaType = getMediaType(url);
				if (mediaType === "image") return `\n![image](${fullUrl})\n`;
				if (mediaType === "audio") return `\n${renderMediaInline(url)}\n`;
				if (mediaType === "video") return `\n${renderMediaInline(url)}\n`;
				if (mediaType === "file") return `\n${renderMediaInline(url)}\n`;
				return match;
			},
		);
		const html = marked.parse(processed, {
			async: false,
			breaks: true,
			gfm: true,
		}) as string;
		return DOMPurify.sanitize(html, {
			ADD_TAGS: ["img", "audio", "video", "source"],
			ADD_ATTR: [
				"src",
				"alt",
				"controls",
				"playsinline",
				"loading",
				"preload",
				"style",
				"class",
				"data-video-src",
				"data-media-preview",
				"data-tooltip",
				"data-download-media",
				"download",
				"target",
				"rel",
				"title",
				"role",
				"tabindex",
				"aria-label",
			],
			FORBID_ATTR: ["onclick", "onerror", "onload", "onmouseover"],
		});
	} catch {
		return DOMPurify.sanitize(text, {
			ADD_TAGS: ["img", "audio", "video", "source"],
			ADD_ATTR: [
				"src",
				"alt",
				"controls",
				"playsinline",
				"loading",
				"preload",
				"style",
				"class",
				"data-video-src",
				"data-media-preview",
				"data-tooltip",
				"data-download-media",
				"download",
				"target",
				"rel",
				"title",
				"role",
				"tabindex",
				"aria-label",
			],
			FORBID_ATTR: ["onclick", "onerror", "onload", "onmouseover"],
		});
	} finally {
		renderCompactMediaImages = previousCompactImages;
		renderAgentMediaDownloads = previousMediaDownloads;
	}
}

function getPayloadText(payload: WsPayload | string | undefined): string {
	if (typeof payload === "string") return payload;
	if (!payload) return "";

	const text =
		payload.content ??
		payload.response ??
		payload.text ??
		payload.chunk ??
		payload.message;

	if (typeof text === "string") return text;
	return JSON.stringify(payload);
}

const ChatMessage = memo(function ChatMessage({
	msg,
	collapsed,
	agent,
}: { msg: Message; collapsed?: boolean; agent?: Agent | null }) {
	const [showFullUserMessage, setShowFullUserMessage] = useState(false);
	const [showHeavyMessage, setShowHeavyMessage] = useState(false);
	const [copied, setCopied] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset expanded state only when a different message is rendered.
	useEffect(() => {
		setShowFullUserMessage(false);
		setShowHeavyMessage(false);
	}, [msg.id]);
	const isCollapsed = Boolean(collapsed && !showHeavyMessage);
	const userPreview = useMemo(
		() =>
			msg.role === "user"
				? getUserMessagePreview(msg.content)
				: { preview: msg.content, truncated: false },
		[msg.content, msg.role],
	);
	const displayContent =
		msg.role === "user" && userPreview.truncated && !showFullUserMessage
			? userPreview.preview
			: msg.content;
	const needsMarkdown =
		msg.role === "assistant" || displayContent.includes("/api/media/file/");
	const renderedMarkdown = useMemo(
		() =>
			needsMarkdown && !isCollapsed
				? renderMarkdown(
						displayContent,
						msg.role === "user",
						msg.role === "assistant",
					)
				: "",
		[needsMarkdown, displayContent, isCollapsed, msg.role],
	);
	const bodyRef = useRef<HTMLDivElement>(null);
	const copyAssistantResponse = useCallback(async () => {
		if (!msg.content.trim()) return;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(msg.content);
			} else {
				const textarea = document.createElement("textarea");
				textarea.value = msg.content;
				textarea.style.position = "fixed";
				textarea.style.opacity = "0";
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand("copy");
				document.body.removeChild(textarea);
			}
			setCopied(true);
			showToast("success", "Respuesta copiada");
			window.setTimeout(() => setCopied(false), 1400);
		} catch {
			showToast("error", "No se pudo copiar la respuesta");
		}
	}, [msg.content]);

	// Keep videos/images as cheap thumbnails until the user explicitly opens one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Rebind media handlers after sanitized markdown content is replaced.
	useEffect(() => {
		if (isCollapsed || !bodyRef.current) return;
		const root = bodyRef.current;
		const previewMedia = (el: HTMLElement) => {
			const src = el.getAttribute("data-media-preview");
			if (!src) return;
			const openPreview = (window as unknown as Record<string, unknown>)
				.openMediaPreview;
			if (typeof openPreview === "function") openPreview(src);
		};

		const getDownloadFilename = (url: string, response: Response): string => {
			const disposition = response.headers.get("content-disposition");
			const match = disposition?.match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
			if (match?.[1]) return decodeURIComponent(match[1].replace(/"/g, ""));
			return getMediaFilename(url);
		};

		const downloadMedia = async (link: HTMLAnchorElement) => {
			const href = link.href;
			if (!href) return;

			try {
				const response = await fetch(href);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const blob = await response.blob();
				const objectUrl = URL.createObjectURL(blob);
				const filename = getDownloadFilename(href, response);
				const tempLink = document.createElement("a");
				tempLink.href = objectUrl;
				tempLink.download = filename;
				tempLink.style.display = "none";
				document.body.appendChild(tempLink);
				tempLink.click();
				document.body.removeChild(tempLink);
				window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
			} catch {
				showToast("error", "No se pudo descargar el archivo");
			}
		};

		const applyVideoAspectRatio = (
			frame: HTMLElement,
			thumbnail: HTMLElement | null,
			aspectRatio: string,
			isVertical: boolean,
		) => {
			frame.classList.toggle("is-vertical-video", isVertical);
			frame.classList.toggle("is-horizontal-video", !isVertical);
			frame.style.aspectRatio = aspectRatio;
			if (thumbnail) thumbnail.style.aspectRatio = aspectRatio;
		};

		const cacheAndApplyVideoDimensions = (
			frame: HTMLElement,
			thumbnail: HTMLElement | null,
			width: number,
			height: number,
			src?: string | null,
		) => {
			if (!width || !height) return;
			const isVertical = width < height;
			const aspectRatio = `${width} / ${height}`;
			if (src) {
				const cacheKey = getVideoAspectCacheKey(src);
				videoAspectRatioCache.delete(cacheKey);
				videoAspectRatioCache.set(cacheKey, {
					aspectRatio,
					isVertical,
				});
				while (videoAspectRatioCache.size > MAX_VIDEO_ASPECT_CACHE) {
					const oldest = videoAspectRatioCache.keys().next().value;
					if (!oldest) break;
					videoAspectRatioCache.delete(oldest);
				}
				persistVideoAspectRatioCache();
			}
			applyVideoAspectRatio(frame, thumbnail, aspectRatio, isVertical);
		};

		const applyCachedVideoAspectRatio = (thumbnail: HTMLElement) => {
			const src = thumbnail.getAttribute("data-video-src");
			if (!src) return false;
			const cached = videoAspectRatioCache.get(getVideoAspectCacheKey(src));
			if (!cached) return false;
			const frame = thumbnail.closest<HTMLElement>(".media-video-frame");
			if (!frame) return false;
			applyVideoAspectRatio(
				frame,
				thumbnail,
				cached.aspectRatio,
				cached.isVertical,
			);
			return true;
		};

		const classifyVideoPoster = (img: HTMLImageElement) => {
			if (!img.complete || !img.naturalWidth || !img.naturalHeight) return;
			const frame = img.closest<HTMLElement>(".media-video-frame");
			const thumbnail = img.closest<HTMLElement>(".video-thumbnail");
			if (!frame || !thumbnail) return;
			cacheAndApplyVideoDimensions(
				frame,
				thumbnail,
				img.naturalWidth,
				img.naturalHeight,
				thumbnail.getAttribute("data-video-src"),
			);
		};

		const classifyVideoDimensions = (
			frame: HTMLElement,
			thumbnail: HTMLElement | null,
			width: number,
			height: number,
			src?: string | null,
		) => {
			cacheAndApplyVideoDimensions(frame, thumbnail, width, height, src);
		};

		const preloadVideoAspectRatio = (thumbnail: HTMLElement) => {
			const src = thumbnail.getAttribute("data-video-src");
			const frame = thumbnail.closest<HTMLElement>(".media-video-frame");
			if (!src || !frame) return;
			if (applyCachedVideoAspectRatio(thumbnail)) return;
			if (frame.dataset.videoAspectLoaded === "true") return;
			frame.dataset.videoAspectLoaded = "true";
			const video = document.createElement("video");
			video.preload = "metadata";
			video.muted = true;
			video.src = src;
			video.addEventListener(
				"loadedmetadata",
				() => {
					classifyVideoDimensions(
						frame,
						thumbnail,
						video.videoWidth,
						video.videoHeight,
						src,
					);
					video.removeAttribute("src");
					video.load();
				},
				{ once: true },
			);
		};

		const syncVideoLayouts = () => {
			for (const thumbnail of root.querySelectorAll<HTMLElement>(
				".video-thumbnail[data-video-src]",
			)) {
				applyCachedVideoAspectRatio(thumbnail);
			}
			for (const img of root.querySelectorAll<HTMLImageElement>(
				".video-thumbnail img",
			)) {
				if (img.complete && img.naturalWidth && img.naturalHeight) {
					classifyVideoPoster(img);
				} else {
					img.addEventListener("load", () => classifyVideoPoster(img), {
						once: true,
					});
				}
			}
			for (const thumbnail of root.querySelectorAll<HTMLElement>(
				".video-thumbnail[data-video-src]",
			)) {
				preloadVideoAspectRatio(thumbnail);
			}
		};

		syncVideoLayouts();
		const animationFrame = window.requestAnimationFrame(syncVideoLayouts);
		const layoutTimers = [100, 500, 1500].map((delay) =>
			window.setTimeout(syncVideoLayouts, delay),
		);
		// Re-apply cached aspect ratio on any DOM mutation: agent re-renders swap the
		// video markup faster than the post-render sync can keep up, so a MutationObserver
		// catches each fresh frame and fixes it synchronously.
		const aspectObserver = new MutationObserver(() => {
			for (const thumbnail of root.querySelectorAll<HTMLElement>(
				".video-thumbnail[data-video-src]",
			)) {
				applyCachedVideoAspectRatio(thumbnail);
			}
		});
		aspectObserver.observe(root, { childList: true, subtree: true });

		const loadVideo = (el: HTMLElement) => {
			const src = el.getAttribute("data-video-src");
			if (!src || el.querySelector("video")) return;
			const rect = el.getBoundingClientRect();
			const poster = el.querySelector("img")?.getAttribute("src") ?? "";
			el.style.height = `${rect.height}px`;
			el.style.aspectRatio = `${rect.width} / ${rect.height}`;
			const video = document.createElement("video");
			video.className = "media-video-player";
			video.controls = true;
			video.src = src;
			video.preload = "metadata";
			video.playsInline = true;
			video.autoplay = true;
			if (poster) video.poster = poster;
			video.addEventListener(
				"loadedmetadata",
				() => {
					if (!video.videoWidth || !video.videoHeight) return;
					const frame = el.closest<HTMLElement>(".media-video-frame");
					if (frame) {
						classifyVideoDimensions(
							frame,
							el,
							video.videoWidth,
							video.videoHeight,
							src,
						);
					}
					el.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
					el.style.height = "";
				},
				{ once: true },
			);
			el.replaceChildren(video);
			el.removeAttribute("data-video-src");
			video.focus();
			void video.play().catch(() => {
				// Some browsers block autoplay even after replacement; controls remain visible.
			});
		};

		const handleActivate = (event: Event) => {
			const target = event.target as HTMLElement | null;
			const downloadLink = target?.closest<HTMLAnchorElement>(
				'a[data-download-media="true"]',
			);
			if (downloadLink && root.contains(downloadLink)) {
				event.preventDefault();
				event.stopPropagation();
				void downloadMedia(downloadLink);
				return;
			}
			const previewEl = target?.closest<HTMLElement>("[data-media-preview]");
			if (previewEl && root.contains(previewEl)) {
				event.preventDefault();
				previewMedia(previewEl);
				return;
			}
			const el = target?.closest<HTMLElement>("[data-video-src]");
			if (!el || !root.contains(el)) return;
			event.preventDefault();
			loadVideo(el);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			const target = event.target as HTMLElement | null;
			const downloadLink = target?.closest<HTMLAnchorElement>(
				'a[data-download-media="true"]',
			);
			if (downloadLink && root.contains(downloadLink)) {
				event.preventDefault();
				event.stopPropagation();
				void downloadMedia(downloadLink);
				return;
			}
			const previewEl = target?.closest<HTMLElement>("[data-media-preview]");
			if (previewEl && root.contains(previewEl)) {
				event.preventDefault();
				previewMedia(previewEl);
				return;
			}
			const el = target?.closest<HTMLElement>("[data-video-src]");
			if (!el || !root.contains(el)) return;
			event.preventDefault();
			loadVideo(el);
		};

		root.addEventListener("click", handleActivate);
		root.addEventListener("keydown", handleKeyDown);

		return () => {
			window.cancelAnimationFrame(animationFrame);
			for (const timer of layoutTimers) window.clearTimeout(timer);
			aspectObserver.disconnect();
			root.removeEventListener("click", handleActivate);
			root.removeEventListener("keydown", handleKeyDown);
		};
	}, [renderedMarkdown, isCollapsed]);

	const renderUserToggle = () => {
		if (!userPreview.truncated) return null;
		return (
			<button
				type="button"
				onClick={() => setShowFullUserMessage((value) => !value)}
				style={{
					marginTop: "10px",
					padding: "6px 10px",
					borderRadius: "999px",
					border: "1px solid #52525b",
					background: "rgba(39,39,42,.7)",
					color: "#a5b4fc",
					fontSize: "0.78rem",
					fontWeight: 700,
					fontFamily: "inherit",
					cursor: "pointer",
				}}
			>
				{showFullUserMessage ? "Ocultar mensaje largo" : "Ver mensaje completo"}
			</button>
		);
	};

	// Collapsed heavy assistant messages keep the timeline usable without hiding content completely.
	if (isCollapsed) {
		const mediaCount = (msg.content.match(/\/api\/media\/file\//g) ?? [])
			.length;
		const preview = msg.content
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "[media]")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 520);
		return (
			<div
				style={{
					marginBottom: "24px",
					display: "flex",
					justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
				}}
			>
				{msg.role === "assistant" && (
					<div
						style={{
							width: "36px",
							height: "36px",
							borderRadius: "10px",
							background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							marginRight: "16px",
							flexShrink: 0,
							fontSize: "18px",
						}}
					>
						{"\uD83D\uDC19"}
					</div>
				)}
				<div
					style={{
						maxWidth: msg.role === "user" ? "80%" : "calc(100% - 52px)",
						fontSize: "0.85rem",
						color: "#a1a1aa",
					}}
				>
					<span style={{ color: msg.role === "user" ? "#a1a1aa" : "#71717a" }}>
						{msg.role === "user" ? "Tu" : "Asistente"} -{" "}
						{formatTime(msg.timestamp)}
					</span>
					<div
						style={{
							marginTop: "8px",
							padding: "12px",
							border: "1px solid #3f3f46",
							borderRadius: "14px",
							background: "rgba(24,24,27,.72)",
							color: "#d4d4d8",
							lineHeight: 1.55,
						}}
					>
						<div
							style={{ fontWeight: 800, color: "#e4e4e7", marginBottom: "6px" }}
						>
							Respuesta grande contraida para proteger el rendimiento
						</div>
						<div style={{ color: "#a1a1aa" }}>
							{mediaCount > 0 ? `${mediaCount} archivos multimedia. ` : ""}
							{msg.content.length.toLocaleString()} caracteres.
						</div>
						{preview && (
							<div style={{ marginTop: "8px" }}>
								{preview}
								{msg.content.length > preview.length ? "..." : ""}
							</div>
						)}
						<button
							type="button"
							onClick={() => setShowHeavyMessage(true)}
							style={{
								marginTop: "10px",
								padding: "8px 12px",
								borderRadius: "999px",
								border: "1px solid rgba(99,102,241,.45)",
								background: "rgba(99,102,241,.14)",
								color: "#c4b5fd",
								fontWeight: 800,
								fontFamily: "inherit",
								cursor: "pointer",
							}}
						>
							Mostrar respuesta completa
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			style={{
				marginBottom: "32px",
				display: "flex",
				justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
			}}
		>
			{msg.role === "assistant" && (
				<div
					style={{
						width: "63px",
						height: "63px",
						borderRadius: "18px",
						background: "rgba(24,24,27,.72)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						marginRight: "16px",
						flexShrink: 0,
						boxShadow: `0 8px 22px ${agent?.color ?? "#ff6f3b"}22`,
						overflow: "hidden",
					}}
				>
					<AgentAvatarContent
						agent={agent}
						alt={agent ? `${agent.name} avatar` : "Octopus"}
						imageStyle={{ width: "54px", height: "54px", objectFit: "contain" }}
					/>
				</div>
			)}
			<div
				ref={bodyRef}
				style={{
					maxWidth: msg.role === "user" ? "80%" : "calc(100% - 79px)",
					width: msg.role === "assistant" ? "100%" : undefined,
					minWidth: msg.role === "assistant" ? 0 : undefined,
					flex: msg.role === "assistant" ? "1 1 auto" : undefined,
				}}
			>
				{msg.role === "user" ? (
					<div
						style={{
							padding: "14px 20px",
							borderRadius: "20px 20px 4px 20px",
							background: "#27272a",
							color: "#f4f4f5",
							fontSize: "0.95rem",
							lineHeight: "1.6",
							border: "1px solid #3f3f46",
						}}
					>
						{needsMarkdown ? (
							<div
								className={`markdown-body markdown-body-${msg.role}`}
								// biome-ignore lint/security/noDangerouslySetInnerHtml: user-uploaded local media
								dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
							/>
						) : (
							displayContent
						)}
						{renderUserToggle()}
					</div>
				) : (
					<div
						style={{
							color: "#e4e4e7",
							fontSize: "0.95rem",
							lineHeight: "1.7",
						}}
					>
						<div
							className={`markdown-body markdown-body-${msg.role}`}
							// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized assistant markdown
							dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
						/>
						{msg.content.trim().length > 0 && (
							<div
								style={{
									display: "flex",
									justifyContent: "flex-start",
									marginTop: "12px",
								}}
							>
								<button
									type="button"
									onClick={copyAssistantResponse}
									data-tooltip="Copiar respuesta del agente"
									aria-label="Copiar respuesta del agente"
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: "6px",
										padding: "6px 10px",
										borderRadius: "999px",
										border: "1px solid #3f3f46",
										background: copied
											? "rgba(16,185,129,.12)"
											: "rgba(24,24,27,.78)",
										color: copied ? "#34d399" : "#a1a1aa",
										fontSize: "0.74rem",
										fontWeight: 700,
										fontFamily: "inherit",
										cursor: "pointer",
										transition: "all .18s ease",
									}}
								>
									<svg
										aria-hidden="true"
										width="13"
										height="13"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
										<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
									</svg>
									{copied ? "Copiado" : "Copiar"}
								</button>
							</div>
						)}
					</div>
				)}
				<div
					style={{
						fontSize: "0.7rem",
						color: "#71717a",
						marginTop: "6px",
						textAlign: msg.role === "user" ? "right" : "left",
						paddingLeft: msg.role === "user" ? "0" : "4px",
					}}
				>
					{formatTime(msg.timestamp)}
				</div>
			</div>
		</div>
	);
});

const SIDEBAR_WIDTH = 312;

export const ChatPage: React.FC<{
	onNavigate?: (tab: string) => void;
	workspaceRequest?: WorkspaceRequest;
}> = ({ onNavigate, workspaceRequest }) => {
	const [messages, setMessages] = useState<Message[]>([]);
	const messagesRef = useRef<Message[]>([]);
	const [input, setInput] = useState("");
	const [isConnected, setIsConnected] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [status, setStatus] = useState<StatusData | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
	const dictationBaseRef = useRef("");
	const dictationFinalRef = useRef("");
	const pendingIdRef = useRef<string>("");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isUploadingImage, setIsUploadingImage] = useState(false);
	const [isDictating, setIsDictating] = useState(false);
	const [speechSupported] = useState(() =>
		Boolean(getSpeechRecognitionConstructor()),
	);
	const [pendingAttachments, setPendingAttachments] = useState<
		{ url: string; file: File; previewUrl: string }[]
	>([]);
	const clearPendingAttachments = useCallback(() => {
		setPendingAttachments((current) => {
			for (const attachment of current)
				URL.revokeObjectURL(attachment.previewUrl);
			return [];
		});
	}, []);
	const removePendingAttachment = useCallback((index: number) => {
		setPendingAttachments((current) => {
			const removed = current[index];
			if (removed) URL.revokeObjectURL(removed.previewUrl);
			return current.filter((_, i) => i !== index);
		});
	}, []);

	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [conversationSearch, setConversationSearch] = useState("");
	const [conversationsLoaded, setConversationsLoaded] = useState(false);
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(() => {
		try {
			return localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
		} catch {
			return null;
		}
	});
	const activeConvRef = useRef<string | null>(null);
	const [agents, setAgents] = useState<Agent[]>([]);
	const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
	const [modelCapabilities, setModelCapabilities] = useState<
	 Record<string, ModelCapabilities>
	>({});
	const [userDisplayName, setUserDisplayName] = useState("Usuario");
	const [selectedAgentId, setSelectedAgentId] = useState<string>("");
	const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
		try {
			return localStorage.getItem("octopus-stream") !== "false";
		} catch {
			return true;
		}
	});
	const [tenacidad, setTenacidad] = useState<"normal" | "tenaz">(() => {
		try {
			return (
				(localStorage.getItem("octopus-tenacidad") as "normal" | "tenaz") ??
				"normal"
			);
		} catch {
			return "normal";
		}
	});
	const [isStreaming, setIsStreaming] = useState(false);
	const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
	const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
	const [activityClock, setActivityClock] = useState(() => Date.now());
	const [multiAgentPlan, setMultiAgentPlan] =
		useState<MultiAgentPlanState | null>(null);
	const [multiAgentWorkers, setMultiAgentWorkers] = useState<
		MultiAgentWorkerState[]
	>([]);
	const [executionByConversation, setExecutionByConversation] = useState<
		Record<string, ConversationExecutionState>
	>({});
	const [toolActions, setToolActions] = useState<ChatToolActionWire[]>([]);
	const lastActivityKeyRef = useRef<string>("");
	const lastResponseChunkAtRef = useRef(0);
	const scrollRafRef = useRef<number | null>(null);
	const pendingStreamDeltasRef = useRef<Map<string, string>>(new Map());
	const streamFlushRafRef = useRef<number | null>(null);
	const hydratedMultiAgentExecutionRef = useRef<string>("");
	const notifiedExecutionRef = useRef<Set<string>>(new Set());
	const [editingConvId, setEditingConvId] = useState<string | null>(null);
	const [visibleMessageCount, setVisibleMessageCount] = useState(
		INITIAL_VISIBLE_MESSAGES,
	);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);
	const scrollRestoreRef = useRef<{ height: number; top: number } | null>(null);
	const [editingTitle, setEditingTitle] = useState("");

	useEffect(() => {
		if (workspaceRequest) setWorkspaceView(workspaceRequest.view);
	}, [workspaceRequest]);
	const [mediaPreviewSrc, setMediaPreviewSrc] = useState<string | null>(null);

	// Register global media preview handler for onclick in rendered HTML
	useEffect(() => {
		(window as unknown as Record<string, unknown>).openMediaPreview = (
			src: string,
		) => setMediaPreviewSrc(src);
		return () => {
			(window as unknown as Record<string, unknown>).openMediaPreview =
				undefined;
		};
	}, []);

	useEffect(() => {
		messagesRef.current = messages;
	}, [messages]);

	const [stats, setStats] = useState<{
		agents: number;
		tools: number;
		mcp: number;
		tasks: number;
		memories: number;
	} | null>(null);

	const resetAgentTrace = useCallback(() => {
		setAgentStatus("idle");
		setAgentActivity([]);
		setMultiAgentPlan(null);
		setMultiAgentWorkers([]);
		lastActivityKeyRef.current = "";
		lastResponseChunkAtRef.current = 0;
	}, []);

	const applyMultiAgentEvent = useCallback(
		(
			status: AgentActivityStatus,
			workerId: string | null,
			detail?: string | null,
		) => {
			const parsed = parseActivityDetailJson(detail);
			if (status === "orchestrating") {
				if (parsed) {
					const subtasks = Array.isArray(parsed.subtasks)
						? parsed.subtasks
						: [];
					const count = asNumber(parsed.count) ?? subtasks.length;
					if (count < 2 && subtasks.length < 2) {
						setMultiAgentPlan(null);
						setMultiAgentWorkers([]);
						return;
					}
					if (
						count > 0 ||
						subtasks.length > 0 ||
						parsed.executionPlan ||
						parsed.reasoning
					) {
						setMultiAgentPlan({
							count,
							executionPlan: asString(parsed.executionPlan),
							reasoning: asString(parsed.reasoning),
						});
					} else if (
						parsed.totalMs ||
						parsed.executionMs ||
						parsed.synthesisMs
					) {
						setMultiAgentPlan((prev) =>
							prev
								? {
										...prev,
										reasoning: `${prev.reasoning ?? "Ejecución multiagente completada."} Telemetría: ejecución ${asNumber(parsed.executionMs) ?? 0}ms, síntesis ${asNumber(parsed.synthesisMs) ?? 0}ms.`,
									}
								: prev,
						);
					}
					if (subtasks.length > 0) {
						setMultiAgentWorkers(
							subtasks.map((raw, index) => {
								const task =
									raw && typeof raw === "object"
										? (raw as Record<string, unknown>)
										: {};
								const id = asString(task.id) ?? `task_${index + 1}`;
								return {
									id,
									taskId: id,
									role: asString(task.role),
									description:
										asString(task.description) ?? "Subtarea asignada.",
									agentId: asString(task.agentId),
									agentName: asString(task.agentName),
									armKey: asString(task.armKey),
									agentAvatar: asString(task.agentAvatar),
									agentColor: asString(task.agentColor),
									status: "queued" as const,
									progress: 0,
									current: "Esperando asignación del brazo vivo.",
									steps: [],
								};
							}),
						);
					}
				}
				return;
			}

			if (!workerId && !parsed) return;
			const id =
				asString(parsed?.workerId) ??
				workerId ??
				asString(parsed?.taskId) ??
				"worker";
			const taskId = asString(parsed?.taskId);
			const message =
				asString(parsed?.message) ??
				asString(parsed?.description) ??
				asString(parsed?.result) ??
				asString(parsed?.error) ??
				detail ??
				"Actualizando progreso.";
			const progress = Math.max(
				0,
				Math.min(
					100,
					asNumber(parsed?.progress) ?? (status === "worker_done" ? 100 : 8),
				),
			);
			const nextStatus: MultiAgentWorkerStatus =
				status === "worker_done"
					? "done"
					: status === "worker_error"
						? "error"
						: "running";
			const copy = getActivityCopy(status, id);
			const step: MultiAgentStep = {
				id: nanoid(),
				label: copy.label,
				detail: message,
				rawDetail: detail ?? null,
				timestamp: Date.now(),
				status,
				toolName: asString(parsed?.toolName) ?? null,
			};
			const agentId = asString(parsed?.agentId);
			const agentName = asString(parsed?.agentName);
			const armKey = asString(parsed?.armKey);
			const agentAvatar = asString(parsed?.agentAvatar);
			const agentColor = asString(parsed?.agentColor);

			setMultiAgentWorkers((prev) => {
				const existingIndex = prev.findIndex(
					(worker) => worker.id === id || worker.taskId === taskId,
				);
				if (existingIndex === -1) {
					return [
						...prev,
						{
							id,
							taskId,
							role: asString(parsed?.role),
							description: asString(parsed?.description) ?? message,
							agentId,
							agentName,
							armKey,
							agentAvatar,
							agentColor,
							status: nextStatus,
							progress,
							current: message,
							steps: [step],
						},
					];
				}

				return prev.map((worker, index) => {
					if (index !== existingIndex) return worker;
					return {
						...worker,
						id,
						taskId: taskId ?? worker.taskId,
						role: asString(parsed?.role) ?? worker.role,
						description: asString(parsed?.description) ?? worker.description,
						agentId: agentId ?? worker.agentId,
						agentName: agentName ?? worker.agentName,
						armKey: armKey ?? worker.armKey,
						agentAvatar: agentAvatar ?? worker.agentAvatar,
						agentColor: agentColor ?? worker.agentColor,
						status: nextStatus,
						progress: Math.max(worker.progress, progress),
						current: message,
						steps: [...worker.steps, step].slice(-8),
					};
				});
			});
		},
		[],
	);

	const addAgentActivity = useCallback(
		(
			status: AgentActivityStatus,
			toolName?: string | null,
			iconSvg?: string | null,
			activityDetail?: string | null,
		) => {
			const key = `${status}:${toolName ?? ""}:${activityDetail?.trim() ?? ""}`;
			if (
				lastActivityKeyRef.current === key &&
				status !== "tool_done" &&
				status !== "tool_error"
			) {
				return;
			}

			lastActivityKeyRef.current = key;
			const copy = getActivityCopy(status, toolName);
			const detail = activityDetail?.trim() || copy.detail;
			setAgentActivity((prev) =>
				[
					...prev,
					{
						id: nanoid(),
						status,
						label: copy.label,
						detail,
						toolName: toolName ?? null,
						iconSvg: iconSvg ?? null,
						timestamp: Date.now(),
					},
				].slice(-6),
			);
		},
		[],
	);

	const updateConversationExecution = useCallback(
		(
			conversationId: string | undefined | null,
			updater: (
				prev: ConversationExecutionState | undefined,
			) => ConversationExecutionState | undefined,
		) => {
			if (!conversationId) return;
			setExecutionByConversation((prev) => {
				const nextState = updater(prev[conversationId]);
				if (!nextState) {
					const { [conversationId]: _removed, ...rest } = prev;
					return rest;
				}
				return { ...prev, [conversationId]: nextState };
			});
		},
		[],
	);

	const subscribeConversation = useCallback((conversationId: string | null) => {
		if (!conversationId || wsRef.current?.readyState !== WebSocket.OPEN) return;
		wsRef.current.send(
			JSON.stringify({
				id: nanoid(),
				type: "request",
				channel: "chat.control",
				payload: { action: "subscribe", conversationId },
				timestamp: Date.now(),
			}),
		);
	}, []);

	const unsubscribeConversation = useCallback((conversationId: string | null) => {
		if (!conversationId || wsRef.current?.readyState !== WebSocket.OPEN) return;
		wsRef.current.send(
			JSON.stringify({
				id: nanoid(),
				type: "request",
				channel: "chat.control",
				payload: { action: "unsubscribe", conversationId },
				timestamp: Date.now(),
			}),
		);
	}, []);

	const loadDashboardStats = useCallback(async () => {
		try {
			const [agents, mcp, memory] = await Promise.all([
				apiGet<unknown[]>("/api/agents").catch(() => []),
				apiGet<unknown[]>("/api/mcp/servers").catch(() => []),
				apiGet<{ longTerm?: { maxItems?: number } }>("/api/memory/stats").catch(
					() => ({ longTerm: { maxItems: 0 } }),
				),
			]);
			setStats({
				agents: agents.length,
				tools: 10 + mcp.length * 3, // Est.
				mcp: mcp.length,
				tasks: 0,
				memories: memory.longTerm?.maxItems ?? 0,
			});
		} catch {}
	}, []);

	useEffect(() => {
		if (!activeConversationId && messages.length === 0) {
			loadDashboardStats();
		}
	}, [activeConversationId, messages.length, loadDashboardStats]);

	useEffect(() => {
		apiGet<StatusData>("/api/status")
			.then(setStatus)
			.catch(() => {});
	}, []);

	useEffect(() => {
		apiGet<Agent[]>("/api/agents")
			.then((list) => {
				setAgents(list);
				if (list.length > 0) {
					setSelectedAgentId((current) => current || list[0].id);
				}
			})
			.catch(() => {});
	}, []);

	// Fetch available models (grouped by provider) + per-model capabilities for the
	// chat model/reasoning selectors.
	useEffect(() => {
		apiGet<{
			providers?: Array<{
				provider: string;
				providerDisplayName: string;
				models: string[];
			}>;
			modelCapabilities?: ModelCapabilities[];
		}>("/api/models")
			.then((data) => {
				const groups: ModelGroup[] = (data.providers ?? []).map((p) => ({
					providerKey: p.provider,
					providerName: p.providerDisplayName,
					models: p.models.map((m) => ({ value: `${p.provider}/${m}`, label: m })),
				}));
				setModelGroups(groups);
				const capsMap: Record<string, ModelCapabilities> = {};
				for (const c of data.modelCapabilities ?? []) {
					capsMap[`${c.provider}/${c.model}`] = c;
				}
				setModelCapabilities(capsMap);
			})
			.catch(() => {});
	}, []);

	// Persist a model or reasoning change for the active agent and update local
	// state from the server response so chat, agents page and dashboard stay in
	// sync.
	const updateAgentConfig = useCallback(
		async (agentId: string, patch: { model?: string; reasoningEffort?: string }) => {
			try {
				const res = (await apiPutJson(`/api/agents/${agentId}`, patch)) as {
					agent?: Partial<Agent>;
					effectiveModel?: string;
					effectiveReasoning?: string;
				};
				if (res.agent || res.effectiveModel || res.effectiveReasoning) {
					setAgents((prev) =>
						prev.map((a) =>
							a.id === agentId
								? {
										...a,
										...(res.agent as Partial<Agent>),
										effectiveModel: res.effectiveModel ?? a.effectiveModel,
										reasoningEffort:
											(res.effectiveReasoning as ReasoningEffort | undefined) ??
											a.reasoningEffort,
									}
								: a,
						),
					);
				}
				// Refresh status so the global header reflects Octavio's change.
				apiGet<StatusData>("/api/status")
					.then(setStatus)
					.catch(() => {});
			} catch (err) {
				console.error("Failed to update agent config:", err);
			}
		},
		[],
	);

	useEffect(() => {
		apiGet<UserProfileResponse>("/api/memory/profile")
			.then((response) => {
				const name = response.profile?.displayName?.trim();
				if (name) setUserDisplayName(name);
			})
			.catch(() => {});
	}, []);

	const selectedAgent = useMemo(
		() => agents.find((agent) => agent.id === selectedAgentId) ?? null,
		[agents, selectedAgentId],
	);

	// Agent whose model/reasoning the chat controls act on: the selected agent,
	// or Octavio (main) when none is explicitly selected.
	const agentForControls = useMemo<Agent | null>(() => {
		if (selectedAgent) return selectedAgent;
		return agents.find((a) => a.is_main) ?? null;
	}, [selectedAgent, agents]);

	const activeCapabilities = useMemo<ModelCapabilities | null>(() => {
		const model = agentForControls?.effectiveModel;
		if (model && modelCapabilities[model]) return modelCapabilities[model];
		return agentForControls?.capabilities ?? null;
	}, [agentForControls, modelCapabilities]);

	const activeModelValue = agentForControls?.effectiveModel ?? "";
	const activeReasoning = (agentForControls?.reasoningEffort ?? "none") as ReasoningEffort;
	const allowedEfforts: ReasoningEffort[] = activeCapabilities?.supportsReasoning
		? (activeCapabilities.allowedReasoningEfforts as ReasoningEffort[])
		: ["none"];
	const canEditAgent = Boolean(agentForControls?.id);

	const visibleConversations = useMemo(() => {
		const query = conversationSearch.trim().toLowerCase();
		if (!query) return conversations;
		return conversations.filter((conversation) =>
			(conversation.title || "Sin titulo").toLowerCase().includes(query),
		);
	}, [conversations, conversationSearch]);

	const loadConversations = useCallback(() => {
		apiGet<Conversation[]>("/api/conversations")
			.then((list) => {
				setConversations(list);
				setConversationsLoaded(true);
			})
			.catch(() => {
				setConversationsLoaded(true);
			});
	}, []);

	useEffect(() => {
		loadConversations();
	}, [loadConversations]);

	useEffect(() => {
		apiGet<ChatExecution[]>("/api/chat/executions")
			.then((executions) => {
				setExecutionByConversation((prev) => {
					const next = { ...prev };
					for (const execution of executions) {
						next[execution.conversation_id] =
							executionStateFromRecord(execution);
					}
					return next;
				});
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		// Don't auto-select until conversations have been loaded from the API
		if (!conversationsLoaded) return;

		if (conversations.length === 0) {
			if (activeConversationId !== null) {
				setActiveConversationId(null);
			}
			return;
		}

		const exists =
			activeConversationId !== null &&
			conversations.some((conv) => conv.id === activeConversationId);

		if (!exists) {
			setActiveConversationId(conversations[0]?.id ?? null);
		}
	}, [conversations, activeConversationId, conversationsLoaded]);

	const loadConversationMessages = useCallback(
		async (convId: string, options?: { merge?: boolean; signal?: AbortSignal }) => {
			try {
				const raw = await apiGet<{ conversation: Conversation }>(
					`/api/conversations/${convId}`,
					{ signal: options?.signal },
				);
				if (options?.signal?.aborted || convId !== activeConvRef.current) return;
				const conv = raw.conversation ?? (raw as unknown as Conversation);
				const incoming = conv.messages?.map(toMessage) ?? [];
				if (options?.merge) {
					setMessages((prev) => mergeMessagesById(prev, incoming));
					return;
				}
				setMessages(incoming);
			} catch (error) {
				if (!options?.signal?.aborted && (!(error instanceof Error) || error.name !== "AbortError") && !options?.merge && convId === activeConvRef.current) setMessages([]);
			}
		},
		[],
	);

	const syncConversationExecution = useCallback(
		async (conversationId: string, options?: { reloadMessages?: boolean; signal?: AbortSignal }) => {
			try {
				const { execution } = await apiGet<{ execution: ChatExecution | null }>(
					`/api/conversations/${conversationId}/execution`,
					{ signal: options?.signal },
				);
				if (options?.signal?.aborted) return;
				if (!execution) {
					updateConversationExecution(conversationId, () => undefined);
					if (conversationId === activeConvRef.current) {
						setIsLoading(false);
						setIsStreaming(false);
						setAgentStatus("idle");
						setAgentActivity([]);
						lastActivityKeyRef.current = "";
						pendingIdRef.current = "";
						if (options?.reloadMessages)
							void loadConversationMessages(conversationId, { merge: true, signal: options?.signal });
					}
					return;
				}

				const nextState = executionStateFromRecord(execution);
				setExecutionByConversation((prev) => ({
					...prev,
					[conversationId]: nextState,
				}));
				if (
					conversationId === activeConvRef.current &&
					options?.reloadMessages
				) {
					void loadConversationMessages(conversationId, { merge: true, signal: options?.signal });
				}
				if (
					conversationId === activeConvRef.current &&
					isExecutionActive(nextState)
				) {
					setIsLoading(true);
					setIsStreaming(Boolean(execution.assistant_message_id));
					setAgentStatus(
						nextState.currentStatus === "idle"
							? "working"
							: nextState.currentStatus,
					);
					setAgentActivity((prev) =>
						nextState.activities.length > 0 ? nextState.activities : prev,
					);
					return;
				}
				if (
					conversationId === activeConvRef.current &&
					!isExecutionActive(nextState)
				) {
					setIsLoading(false);
					setIsStreaming(false);
					setAgentStatus("idle");
					setAgentActivity([]);
					lastActivityKeyRef.current = "";
					pendingIdRef.current = "";
					loadConversations();
					inputRef.current?.focus();
				}
			} catch (error) {
				if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) return;
				// Keep the local optimistic state if the recovery request fails.
			}
		},
		[loadConversationMessages, loadConversations, updateConversationExecution],
	);

	useEffect(() => {
		activeConvRef.current = activeConversationId;
		try {
			if (activeConversationId) {
				localStorage.setItem(
					ACTIVE_CONVERSATION_STORAGE_KEY,
					activeConversationId,
				);
			} else {
				localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
			}
		} catch {
			// ignore storage failures
		}

		setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
		const controller = new AbortController();
		if (activeConversationId) {
			subscribeConversation(activeConversationId);
			void loadConversationMessages(activeConversationId, { signal: controller.signal });
			void syncConversationExecution(activeConversationId, { signal: controller.signal });
		} else {
			setMessages([]);
		}
		return () => {
			controller.abort();
			unsubscribeConversation(activeConversationId);
		};
	}, [
		activeConversationId,
		loadConversationMessages,
		subscribeConversation,
		syncConversationExecution,
		unsubscribeConversation,
	]);

	const handleSelectConversation = useCallback(
		(convId: string) => {
			const executionId = executionByConversation[convId]?.executionId;
			if (executionId) notifiedExecutionRef.current.delete(executionId);
			setWorkspaceView("chat");
			setActiveConversationId(convId);
		},
		[executionByConversation],
	);

	const handleNewChat = useCallback(async () => {
		setWorkspaceView("chat");
		try {
			const body: Record<string, string> = {};
			if (selectedAgentId) body.agentId = selectedAgentId;
			const result = await apiPost("/api/conversations", body);
			const created =
				(result.conversation as Conversation | undefined) ??
				(result as unknown as Conversation);
			const newConv: Conversation = {
				id: created.id || nanoid(),
				title: created.title || "Nueva conversación",
			};
			setConversations((prev) => [newConv, ...prev]);
			setActiveConversationId(newConv.id);
			activeConvRef.current = newConv.id;
			setMessages([]);
		} catch {
			setActiveConversationId(null);
			setMessages([]);
		}
	}, [selectedAgentId]);

	const handleDeleteConversation = useCallback(
		async (convId: string) => {
			try {
				await apiDelete(`/api/conversations/${convId}`);
				setConversations((prev) => prev.filter((c) => c.id !== convId));
				if (activeConversationId === convId) {
					setActiveConversationId(null);
					activeConvRef.current = null;
					setMessages([]);
				}
			} catch {}
		},
		[activeConversationId],
	);

	const scrollToBottom = useCallback((instant?: boolean) => {
		const doScroll = () => {
			if (messagesContainerRef.current) {
				const container = messagesContainerRef.current;
				if (instant) {
					container.scrollTop = container.scrollHeight;
				} else {
					container.scrollTo({
						top: container.scrollHeight,
						behavior: "smooth",
					});
				}
			} else {
				messagesEndRef.current?.scrollIntoView({
					behavior: instant ? ("instant" as ScrollBehavior) : "smooth",
					block: "end",
				});
			}
			setShowScrollToBottom(false);
		};
		setTimeout(doScroll, 30);
	}, []);

	const updateScrollToBottomVisibility = useCallback(() => {
		const container = messagesContainerRef.current;
		if (!container) {
			setShowScrollToBottom(false);
			return;
		}
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		setShowScrollToBottom(distanceFromBottom > 180);
	}, []);

	const handleMessagesScroll = useCallback(() => {
		updateScrollToBottomVisibility();
	}, [updateScrollToBottomVisibility]);

	useEffect(() => {
		void messages.length;
		scrollToBottom();
	}, [messages, scrollToBottom]);

	const revealOlderMessages = useCallback(() => {
		const container = messagesContainerRef.current;
		if (container) {
			scrollRestoreRef.current = {
				height: container.scrollHeight,
				top: container.scrollTop,
			};
		}
		setVisibleMessageCount((count) =>
			Math.min(count + MESSAGE_PAGE_SIZE, messagesRef.current.length),
		);
	}, []);

	useEffect(() => {
		void visibleMessageCount;
		const restore = scrollRestoreRef.current;
		if (!restore) return;
		const container = messagesContainerRef.current;
		if (!container) {
			scrollRestoreRef.current = null;
			return;
		}
		requestAnimationFrame(() => {
			container.scrollTop =
				restore.top + (container.scrollHeight - restore.height);
			scrollRestoreRef.current = null;
		});
	}, [visibleMessageCount]);

	const handleSaveTitle = async (convId: string) => {
		if (!editingTitle.trim()) {
			setEditingConvId(null);
			return;
		}
		try {
			await apiPatch(`/api/conversations/${convId}`, {
				title: editingTitle.trim(),
			});
			setConversations((prev) =>
				prev.map((c) =>
					c.id === convId ? { ...c, title: editingTitle.trim() } : c,
				),
			);
		} catch {}
		setEditingConvId(null);
	};

	const connect = useCallback(() => {
		if (
			wsRef.current?.readyState === WebSocket.OPEN ||
			wsRef.current?.readyState === WebSocket.CONNECTING
		)
			return;
		if (reconnectTimerRef.current) {
			clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
		}

		const ws = new WebSocket(WS_URL);

		ws.onopen = () => {
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = null;
			}
			setIsConnected(true);
			if (activeConvRef.current) {
				const conversationId = activeConvRef.current;
				ws.send(
					JSON.stringify({
						id: nanoid(),
						type: "request",
						channel: "chat.control",
						payload: {
							action: "subscribe",
							conversationId,
						},
						timestamp: Date.now(),
					}),
				);
				void syncConversationExecution(conversationId, {
					reloadMessages: true,
				});
			}
		};

		ws.onclose = () => {
			if (wsRef.current !== ws) return;
			wsRef.current = null;
			setIsConnected(false);
			if (!reconnectTimerRef.current) {
				reconnectTimerRef.current = setTimeout(() => {
					reconnectTimerRef.current = null;
					connect();
				}, 3000);
			}
		};

		ws.onerror = () => {
			ws.close();
		};

		// Coalesce streaming deltas into a single setState per animation frame so
		// high token rates don't trigger one messages array map per token.
		const flushStreamDeltas = () => {
			streamFlushRafRef.current = null;
			const deltas = pendingStreamDeltasRef.current;
			if (deltas.size === 0) return;
			pendingStreamDeltasRef.current = new Map();
			setMessages((prev) => {
				let next = prev;
				for (const [streamId, delta] of deltas) {
					const existing = next.find((m) => m.id === streamId);
					const incomingContent = existing
						? existing.content + delta
						: delta;
					const incoming: Message = {
						id: streamId,
						role: "assistant",
						content: incomingContent,
						timestamp: Date.now(),
					};
					next = existing
						? next.map((m) =>
								m.id === existing.id
									? { ...preferRicherMessage(m, incoming), id: streamId }
									: m,
						)
						: [...next, incoming];
				}
				return next;
			});
		};

		ws.onmessage = (event) => {
			try {
				const msg: WsMessage = JSON.parse(event.data);

				if (msg.type === "pong") return;

				const conversationId = msg.payload?.conversationId;
				const executionId = msg.payload?.executionId;
				const payloadWorkflowRunId =
					msg.payload?.workflowRunId ??
					extractWorkflowRunIdFromDetail(msg.payload?.activityDetail);
				const assistantMessageId = msg.payload?.assistantMessageId ?? undefined;
				const isActiveConversation =
					!conversationId || conversationId === activeConvRef.current;
				if (
					conversationId &&
					msg.payload?.kind === "execution_snapshot" &&
					msg.payload.execution
				) {
					const execution = msg.payload.execution;
					const nextState = executionStateFromRecord(execution);
					setExecutionByConversation((prev) => ({
						...prev,
						[conversationId]: nextState,
					}));
					if (isActiveConversation) {
						if (msg.payload.assistantMessage?.content) {
							const checkpoint = toMessage(msg.payload.assistantMessage);
							setMessages((prev) => {
								return mergeMessagesById(prev, [checkpoint]);
							});
						}
						if (isExecutionActive(nextState)) {
							setIsLoading(true);
							setIsStreaming(Boolean(execution.assistant_message_id));
							setAgentStatus(
								nextState.currentStatus === "idle"
									? "thinking"
									: nextState.currentStatus,
							);
							setAgentActivity((prev) =>
								nextState.activities.length > 0 ? nextState.activities : prev,
							);
						} else {
							setIsLoading(false);
							setIsStreaming(false);
							lastResponseChunkAtRef.current = 0;
							setAgentStatus("idle");
							setAgentActivity(nextState.activities);
							pendingIdRef.current = "";
						}
						void loadConversationMessages(conversationId, { merge: true });
					}
					return;
				}
				if (conversationId && msg.payload?.execution) {
					const execution = msg.payload.execution;
					setExecutionByConversation((prev) => ({
						...prev,
						[conversationId]: executionStateFromRecord(execution),
					}));
				}
				if (conversationId && !activeConvRef.current) {
					setActiveConversationId(conversationId);
					activeConvRef.current = conversationId;
					const lastUserMsg =
						messagesRef.current[messagesRef.current.length - 1];
					const autoTitle =
						lastUserMsg?.role === "user" &&
						lastUserMsg.content.trim().length > 0
							? lastUserMsg.content.length > 50
								? `${lastUserMsg.content.substring(0, 50).trimEnd()}...`
								: lastUserMsg.content
							: "Nueva conversación";
					setConversations((prev) => {
						if (prev.some((c) => c.id === conversationId)) return prev;
						return [
							{
								id: conversationId,
								title: autoTitle,
							},
							...prev,
						];
					});
					if (
						autoTitle !== "Nueva conversación" &&
						lastUserMsg?.role === "user"
					) {
						apiPatch(`/api/conversations/${conversationId}`, {
							title: autoTitle,
						}).catch(() => {});
					}
				}

				if (msg.type === "response") {
					const responseStatus =
						(msg.payload?.status as ChatExecutionStatus | undefined) ??
						"completed";
					const completionReason = msg.payload
						?.completionReason as ChatCompletionReason | undefined;
					const pendingAction = parsePendingAction(msg.payload?.pendingAction);
					updateConversationExecution(conversationId, (prev) => ({
						executionId: executionId ?? prev?.executionId ?? msg.id,
						status: responseStatus,
						currentStatus: "idle",
						activities: prev?.activities ?? [],
						workflowRunId: payloadWorkflowRunId ?? prev?.workflowRunId,
						completionReason,
						pendingAction,
					}));
					resetAgentTrace();
					const assistantContent = getPayloadText(msg.payload);

					if (isActiveConversation) {
						setMessages((prev) => {
							const fallbackStreamId = `stream-${executionId ?? msg.id}`;
							const responseMessageId = assistantMessageId ?? fallbackStreamId;
							const incoming: Message = {
								id: responseMessageId,
								role: "assistant",
								content: assistantContent,
								timestamp: Date.now(),
							};
							const existing =
								prev.find((m) => m.id === responseMessageId) ??
								(assistantMessageId
									? prev.find((m) => m.id === fallbackStreamId)
									: undefined);
							if (existing) {
								return prev.map((m) =>
									m.id === existing.id
										? {
												...preferRicherMessage(m, incoming),
												id: responseMessageId,
											}
										: m,
								);
							}
							return [...prev, incoming];
						});
					} else if (
						executionId &&
						!notifiedExecutionRef.current.has(executionId)
					) {
						notifiedExecutionRef.current.add(executionId);
						showToast(
							responseStatus === "interrupted" ? "warning" : "success",
							responseStatus === "interrupted"
								? "El agente dejó una acción pendiente en otro chat."
								: "El agente terminó una tarea en otro chat.",
						);
						if (
							responseStatus !== "interrupted" &&
							Notification.permission === "granted"
						) {
							new Notification("Octopus AI", {
								body: "El agente terminó una tarea en otro chat.",
							});
						}
					}
					setIsLoading(false);
					setIsStreaming(false);
					lastResponseChunkAtRef.current = 0;
					pendingIdRef.current = "";
					loadConversations();
					inputRef.current?.focus();
				} else if (msg.type === "stream") {
					const chunk = getPayloadText(msg.payload);
					lastResponseChunkAtRef.current = Date.now();
					setActivityClock(lastResponseChunkAtRef.current);
					const fallbackStreamId = `stream-${executionId ?? msg.id}`;
					const streamId = assistantMessageId ?? fallbackStreamId;
					updateConversationExecution(conversationId, (prev) => ({
						executionId: executionId ?? prev?.executionId ?? msg.id,
						status: "running",
						currentStatus: "responding",
						activities: prev?.activities ?? [],
						workflowRunId: payloadWorkflowRunId ?? prev?.workflowRunId,
					}));
					if (!isActiveConversation) return;
					setIsStreaming(true);
					setAgentStatus("responding");
					addAgentActivity("responding");
					pendingStreamDeltasRef.current.set(
						streamId,
						(pendingStreamDeltasRef.current.get(streamId) ?? "") + chunk,
					);
					if (streamFlushRafRef.current == null) {
						streamFlushRafRef.current =
							requestAnimationFrame(flushStreamDeltas);
					}
					// Auto-scroll on each streaming chunk, but coalesce via rAF so we
					// never force layout more than once per animation frame.
					if (scrollRafRef.current == null) {
						scrollRafRef.current = requestAnimationFrame(() => {
							scrollRafRef.current = null;
							scrollToBottom(true);
						});
					}
				} else if (msg.type === "stream_end") {
					const streamEndStatus =
						(msg.payload?.status as ChatExecutionStatus | undefined) ??
						(msg.payload?.cancelled ? "cancelled" : "completed");
					const completionReason = msg.payload
						?.completionReason as ChatCompletionReason | undefined;
					const pendingAction = parsePendingAction(msg.payload?.pendingAction);
					updateConversationExecution(conversationId, (prev) => ({
						executionId: executionId ?? prev?.executionId ?? msg.id,
						status: streamEndStatus,
						currentStatus: "idle",
						activities: prev?.activities ?? [],
						workflowRunId: payloadWorkflowRunId ?? prev?.workflowRunId,
						error: msg.payload?.error ?? null,
						completionReason,
						pendingAction,
					}));
					if (
						!isActiveConversation &&
						executionId &&
						!notifiedExecutionRef.current.has(executionId)
					) {
						notifiedExecutionRef.current.add(executionId);
						showToast(
							msg.payload?.cancelled || streamEndStatus === "interrupted"
								? "warning"
								: "success",
							msg.payload?.cancelled
								? "Una tarea del agente fue detenida."
								: streamEndStatus === "interrupted"
									? "El agente dejó una acción pendiente en otro chat."
								: "El agente terminó una tarea en otro chat.",
						);
						if (
							!msg.payload?.cancelled &&
							streamEndStatus !== "interrupted" &&
							Notification.permission === "granted"
						) {
							new Notification("Octopus AI", {
								body: "El agente terminó una tarea en otro chat.",
							});
						}
					}
					if (!isActiveConversation) {
						loadConversations();
						return;
					}
					if (streamFlushRafRef.current != null) {
						cancelAnimationFrame(streamFlushRafRef.current);
						streamFlushRafRef.current = null;
					}
					flushStreamDeltas();
					setIsLoading(false);
					setIsStreaming(false);
					lastResponseChunkAtRef.current = 0;
					resetAgentTrace();
					pendingIdRef.current = "";
					if (conversationId)
						void loadConversationMessages(conversationId, { merge: true });
					loadConversations();
					inputRef.current?.focus();
				} else if (msg.type === "event") {
					const agentStatus = msg.payload?.agentStatus;
					if (agentStatus && AGENT_ACTIVITY_STATUSES.has(agentStatus)) {
						const nextStatus = agentStatus as AgentActivityStatus;
						const nextToolName = msg.payload?.toolName || null;
						const iconB64 = msg.payload?.uiIconB64;
						let nextIcon: string | null = null;
						if (iconB64) {
							try {
								nextIcon = atob(iconB64);
							} catch {
								nextIcon = null;
							}
						}
						const displayDetail = getActivityDisplayDetail(
							nextStatus,
							nextToolName,
							msg.payload?.activityDetail,
						);
						const copy = getActivityCopy(nextStatus, nextToolName);
						const nextActivity: AgentActivity = {
							id: nanoid(),
							status: nextStatus,
							label: copy.label,
							detail: displayDetail || copy.detail,
							toolName: nextToolName,
							iconSvg: nextIcon,
							timestamp: Date.now(),
						};
						updateConversationExecution(conversationId, (prev) => ({
							executionId: executionId ?? prev?.executionId ?? msg.id,
							status: "running",
							currentStatus: nextStatus,
							activities: [...(prev?.activities ?? []), nextActivity].slice(
								-80,
							),
							workflowRunId: payloadWorkflowRunId ?? prev?.workflowRunId,
						}));
						if (isActiveConversation) {
							setAgentStatus(nextStatus);
							applyMultiAgentEvent(
								nextStatus,
								nextToolName,
								msg.payload?.activityDetail,
							);
							addAgentActivity(
								nextStatus,
								nextToolName,
								nextIcon,
								displayDetail,
							);
							scrollToBottom(true);
						}
					}
				} else if (msg.type === "error") {
					const errMsg = msg.payload?.error || "Error desconocido";
					updateConversationExecution(conversationId, (prev) => ({
						executionId: executionId ?? prev?.executionId ?? msg.id,
						status: "failed",
						currentStatus: "idle",
						activities: prev?.activities ?? [],
						workflowRunId: payloadWorkflowRunId ?? prev?.workflowRunId,
						error: errMsg,
					}));
					if (isActiveConversation) {
						setMessages((prev) => [
							...prev,
							{
								id: nanoid(),
								role: "assistant",
								content: `⚠️ Error: ${errMsg}`,
								timestamp: Date.now(),
							},
						]);
					} else if (
						executionId &&
						!notifiedExecutionRef.current.has(executionId)
					) {
						notifiedExecutionRef.current.add(executionId);
						showToast("error", "Una tarea del agente falló en otro chat.");
					}
					if (streamFlushRafRef.current != null) {
						cancelAnimationFrame(streamFlushRafRef.current);
						streamFlushRafRef.current = null;
					}
					flushStreamDeltas();
					setIsLoading(false);
					setIsStreaming(false);
					lastResponseChunkAtRef.current = 0;
					resetAgentTrace();
					pendingIdRef.current = "";
					loadConversations();
				}
			} catch (err) {
				console.error("Failed to parse WS message:", err);
			}
		};

		wsRef.current = ws;
	}, [
		addAgentActivity,
		applyMultiAgentEvent,
		loadConversationMessages,
		loadConversations,
		resetAgentTrace,
		scrollToBottom,
		syncConversationExecution,
		updateConversationExecution,
	]);

	useEffect(() => {
		connect();
		return () => {
			if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
			const ws = wsRef.current;
			wsRef.current = null;
			if (ws) {
				ws.onclose = null;
				ws.close();
			}
			clearPendingAttachments();
		};
	}, [connect, clearPendingAttachments]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if ("Notification" in window && Notification.permission === "default") {
			Notification.requestPermission().catch(() => {});
		}
	}, []);

	const activeExecution = activeConversationId
		? executionByConversation[activeConversationId]
		: undefined;
	const activeBusy = isExecutionActive(activeExecution);
	const hasActiveWork =
		activeBusy || isLoading || isStreaming || agentStatus !== "idle";
	const latestAgentActivity = agentActivity[agentActivity.length - 1];
	const isActivelyReceivingResponse =
		latestAgentActivity?.status === "responding" &&
		lastResponseChunkAtRef.current > 0 &&
		activityClock - lastResponseChunkAtRef.current < RESPONSE_ACTIVITY_GRACE_MS;
	const fallbackStatus: AgentStatus =
		agentStatus === "responding" ? "working" : agentStatus;
	const visibleAgentActivity = hasActiveWork
		? agentActivity.length === 0
			? [createFallbackAgentActivity(fallbackStatus)]
			: agentActivity
		: agentActivity;
	const shouldShowAgentActivity = hasActiveWork && !isActivelyReceivingResponse;
	const activeWorkflowRunId = activeExecution?.workflowRunId;

	useEffect(() => {
		if (!activeConversationId) {
			setToolActions([]);
			return;
		}
		const executionQuery = activeExecution?.executionId
			? `&executionId=${encodeURIComponent(activeExecution.executionId)}`
			: "";
		const phaseQuery = activeExecution?.status
			? `&phase=${encodeURIComponent(activeExecution.status)}`
			: "";
		const controller = new AbortController();
		apiGet<{ actions: ChatToolActionWire[] }>(
			`/api/conversations/${encodeURIComponent(activeConversationId)}/tool-actions?limit=30${executionQuery}${phaseQuery}`,
			{ signal: controller.signal },
		)
			.then((response) => {
				if (!controller.signal.aborted) setToolActions(response.actions ?? []);
			})
			.catch((error) => {
				if (!controller.signal.aborted && (!(error instanceof Error) || error.name !== "AbortError")) setToolActions([]);
			});
		return () => controller.abort();
	}, [
		activeConversationId,
		activeExecution?.executionId,
		activeExecution?.status,
	]);

	useEffect(() => {
		if (!hasActiveWork) return;
		const timer = window.setInterval(() => setActivityClock(Date.now()), 400);
		return () => window.clearInterval(timer);
	}, [hasActiveWork]);

	const openWorkflowMonitor = useCallback(
		(workflowRunId: string) => {
			try {
				localStorage.setItem(SELECTED_WORKFLOW_STORAGE_KEY, workflowRunId);
			} catch {
				// Navigation still works; Tasks will simply show the workflow list.
			}
			onNavigate?.("tasks");
		},
		[onNavigate],
	);

	useEffect(() => {
		const needsRecovery =
			activeBusy || isLoading || isStreaming || agentStatus !== "idle";
		if (!activeConversationId || !needsRecovery) return;
		const timer = window.setInterval(() => {
			void syncConversationExecution(activeConversationId, {
				reloadMessages: true,
			});
		}, 5000);
		return () => window.clearInterval(timer);
	}, [
		activeConversationId,
		activeBusy,
		agentStatus,
		isLoading,
		isStreaming,
		syncConversationExecution,
	]);

	useEffect(() => {
		if (!activeExecution || !isExecutionActive(activeExecution)) {
			if (!isLoading && !isStreaming) {
				setAgentStatus("idle");
				setAgentActivity([]);
			}
			return;
		}
		setAgentStatus(activeExecution.currentStatus);
		setAgentActivity((prev) =>
			activeExecution.activities.length > 0 ? activeExecution.activities : prev,
		);
	}, [activeExecution, isLoading, isStreaming]);

	useEffect(() => {
		if (!activeExecution || !isExecutionActive(activeExecution)) {
			hydratedMultiAgentExecutionRef.current = "";
			return;
		}
		if (
			hydratedMultiAgentExecutionRef.current === activeExecution.executionId ||
			activeExecution.activities.length === 0
		) {
			return;
		}
		hydratedMultiAgentExecutionRef.current = activeExecution.executionId;
		setMultiAgentPlan(null);
		setMultiAgentWorkers([]);
		for (const activity of activeExecution.activities) {
			applyMultiAgentEvent(
				activity.status,
				activity.toolName ?? null,
				activity.detail,
			);
		}
	}, [activeExecution, applyMultiAgentEvent]);

	const resizeInputToContent = useCallback(() => {
		const textarea = inputRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
	}, []);

	const stopDictation = useCallback(() => {
		const recognition = recognitionRef.current;
		if (!recognition) return;
		recognition.onend = null;
		recognition.onerror = null;
		recognition.onresult = null;
		recognition.stop();
		recognitionRef.current = null;
		setIsDictating(false);
		inputRef.current?.focus();
	}, []);

	const startDictation = useCallback(() => {
		const SpeechRecognition = getSpeechRecognitionConstructor();
		if (!SpeechRecognition) {
			showToast("warning", "Dictado no soportado en este navegador.");
			return;
		}

		if (recognitionRef.current) {
			stopDictation();
			return;
		}

		const recognition = new SpeechRecognition();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = "es-ES";
		dictationBaseRef.current = input;
		dictationFinalRef.current = "";

		recognition.onresult = (event) => {
			let interimTranscript = "";
			for (let i = event.resultIndex; i < event.results.length; i += 1) {
				const result = event.results[i];
				const transcript = result[0]?.transcript ?? "";
				if (result.isFinal) {
					dictationFinalRef.current =
						`${dictationFinalRef.current} ${transcript}`.trim();
				} else {
					interimTranscript = `${interimTranscript} ${transcript}`.trim();
				}
			}

			const dictated =
				`${dictationFinalRef.current} ${interimTranscript}`.trim();
			setInput(mergeDictationText(dictationBaseRef.current, dictated));
			requestAnimationFrame(resizeInputToContent);
		};

		recognition.onerror = (event) => {
			const message =
				event.error === "not-allowed" || event.error === "service-not-allowed"
					? "No se pudo acceder al microfono."
					: "No se pudo continuar el dictado.";
			showToast("error", message);
			setIsDictating(false);
			recognitionRef.current = null;
		};

		recognition.onend = () => {
			setIsDictating(false);
			recognitionRef.current = null;
		};

		try {
			recognition.start();
			recognitionRef.current = recognition;
			setIsDictating(true);
			inputRef.current?.focus();
		} catch {
			showToast("error", "No se pudo iniciar el dictado.");
		}
	}, [input, resizeInputToContent, stopDictation]);

	useEffect(() => {
		return () => {
			recognitionRef.current?.abort();
			recognitionRef.current = null;
		};
	}, []);

	const handleSend = () => {
		const text = input.trim();
		if (
			(!text && pendingAttachments.length === 0) ||
			!isConnected ||
			activeBusy
		)
			return;
		stopDictation();

		let finalContent = text;
		if (pendingAttachments.length > 0) {
			// Alt text carries the original filename so document attachments render
			// as a typed file card (and the backend can label them on extraction).
			const attachmentsMd = pendingAttachments
				.map((a) => `![${a.file?.name ?? "Image"}](${a.url})`)
				.join("\n");
			finalContent = finalContent
				? `${finalContent}\n\n${attachmentsMd}`
				: attachmentsMd;
		}

		const userMsg: Message = {
			id: nanoid(),
			role: "user",
			content: finalContent,
			timestamp: Date.now(),
			local: true,
		};
		setMessages((prev) => [...prev, userMsg]);
		setInput("");
		clearPendingAttachments();
		setIsLoading(true);
		setIsStreaming(false);
		lastResponseChunkAtRef.current = 0;
		setMultiAgentPlan(null);
		setMultiAgentWorkers([]);
		setAgentStatus("working");
		lastActivityKeyRef.current = "";
		const initialActivityCopy = getActivityCopy("working");
		setAgentActivity([
			{
				id: nanoid(),
				status: "working",
				label: initialActivityCopy.label,
				detail: initialActivityCopy.detail,
				timestamp: Date.now(),
			},
		]);
		lastActivityKeyRef.current = "thinking::";

		if (inputRef.current) {
			inputRef.current.style.height = "auto";
			inputRef.current.focus();
		}

		const requestId = nanoid();
		pendingIdRef.current = requestId;

		const payload: Record<string, unknown> = {
			message: finalContent,
			stream: streamEnabled,
		};
		if (activeConversationId) payload.conversationId = activeConversationId;
		if (selectedAgentId) payload.agentId = selectedAgentId;

		const wsMsg: WsMessage = {
			id: requestId,
			type: "request",
			channel: "chat",
			payload: payload as WsPayload,
			timestamp: Date.now(),
		};

		const convIdForTitle = payload.conversationId as string | undefined;
		const isFirstMsg = messagesRef.current.length === 0;

		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(wsMsg));

			if (isFirstMsg && finalContent.trim().length > 0) {
				const targetConvId = convIdForTitle ?? activeConversationId;
				if (targetConvId) {
					const titleSource = text || "Imagen";
					const title =
						titleSource.length > 50
							? `${titleSource.substring(0, 50).trimEnd()}...`
							: titleSource;
					apiPatch(`/api/conversations/${targetConvId}`, { title }).catch(
						() => {},
					);
					setConversations((prev) =>
						prev.map((c) => (c.id === targetConvId ? { ...c, title } : c)),
					);
				}
			}
		} else {
			setMessages((prev) => [
				...prev,
				{
					id: nanoid(),
					role: "assistant",
					content:
						"⚠️ No hay conexión con el servidor. Verifica que el backend esté corriendo.",
					timestamp: Date.now(),
				},
			]);
			setIsLoading(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setInput(e.target.value);
		resizeInputToContent();
	};

	const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		setIsUploadingImage(true);
		try {
			const formData = new FormData();
			formData.append("file", file);

			const res = await fetch(`${API_BASE}/api/media/upload`, {
				method: "POST",
				body: formData,
			});

			if (!res.ok) throw new Error("Error al subir archivo");
			const data = await res.json();

			const previewUrl = URL.createObjectURL(file);
			setPendingAttachments((prev) => [
				...prev,
				{ url: data.url, file, previewUrl },
			]);
			if (inputRef.current) inputRef.current.focus();
		} catch (error) {
			console.error("Upload error:", error);
			setAgentActivity((prev) => [
				{
					id: nanoid(),
					status: "tool_error",
					label: "No se pudo adjuntar la imagen",
					detail: error instanceof Error ? error.message : "Error de subida",
					timestamp: Date.now(),
				},
				...prev.slice(0, 4),
			]);
		} finally {
			setIsUploadingImage(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	const handleStopExecution = async () => {
		if (!activeConversationId || !activeBusy) return;
		try {
			await apiPost(`/api/conversations/${activeConversationId}/stop`);
			updateConversationExecution(activeConversationId, (prev) =>
				prev
					? {
							...prev,
							status: "cancelled",
							currentStatus: "idle",
							error: "Cancelado por el usuario",
						}
					: prev,
			);
			setIsLoading(false);
			setIsStreaming(false);
			resetAgentTrace();
			showToast("warning", "Tarea del agente detenida.");
		} catch (error) {
			showToast(
				"error",
				error instanceof Error ? error.message : "No se pudo detener la tarea.",
			);
		}
	};

	const dictationUnavailable =
		!speechSupported || (!isDictating && (!isConnected || activeBusy));

	return (
		<div
			style={{
				display: "flex",
				height: "100%",
				background: "#09090b",
				color: "#f4f4f5",
			}}
		>
			{/* Sidebar */}
			{sidebarOpen && (
				<div
					style={{
						width: SIDEBAR_WIDTH,
						minWidth: SIDEBAR_WIDTH,
						background: "#000",
						borderRight: "1px solid #151515",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<div
						style={{
							padding: "20px 18px 14px",
							borderBottom: "1px solid #111",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								marginBottom: "24px",
							}}
						>
							<div
								style={{
									fontSize: "1.28rem",
									fontWeight: 800,
									color: "#fff",
									letterSpacing: "-0.02em",
								}}
							>
								Octopus
							</div>
							<button
								type="button"
								onClick={() => setSidebarOpen(false)}
								data-tooltip="Ocultar panel"
								style={{
									width: "30px",
									height: "30px",
									borderRadius: "9px",
									border: "none",
									background: "transparent",
									color: "#a1a1aa",
									cursor: "pointer",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
								}}
							>
								<svg
									aria-hidden="true"
									width="20"
									height="20"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.8"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<rect x="4" y="4" width="16" height="16" rx="3" />
									<path d="M10 4v16" />
								</svg>
							</button>
						</div>
						<button
							type="button"
							onClick={() => {
								void handleNewChat();
								inputRef.current?.focus();
							}}
							style={{
								width: "100%",
								padding: "14px 16px",
								borderRadius: "14px",
								border: "none",
								background: "#2f2f2f",
								color: "#f4f4f5",
								cursor: "pointer",
								display: "flex",
								alignItems: "center",
								justifyContent: "flex-start",
								gap: "12px",
								fontWeight: 700,
								fontSize: "0.98rem",
								fontFamily: "inherit",
								transition: "all 0.2s",
							}}
							data-tooltip="Nuevo chat"
							onMouseEnter={(e) => {
								e.currentTarget.style.background = "#383838";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.background = "#2f2f2f";
							}}
						>
							<svg
								aria-hidden="true"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<line x1="12" y1="5" x2="12" y2="19" />
								<line x1="5" y1="12" x2="19" y2="12" />
							</svg>
							Nuevo chat
						</button>
						<label
							style={{
								marginTop: "14px",
								display: "flex",
								alignItems: "center",
								gap: "12px",
								padding: "12px 4px",
								color: "#f4f4f5",
							}}
						>
							<svg
								aria-hidden="true"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<circle cx="11" cy="11" r="7" />
								<path d="m20 20-3.5-3.5" />
							</svg>
							<input
								value={conversationSearch}
								onChange={(event) => setConversationSearch(event.target.value)}
								placeholder="Buscar chats"
								style={{
									width: "100%",
									minWidth: 0,
									border: "none",
									outline: "none",
									background: "transparent",
									color: "#f4f4f5",
									fontSize: "0.96rem",
									fontFamily: "inherit",
								}}
							/>
						</label>
					</div>

					<div
						style={{
							flex: 1,
							overflowY: "auto",
							overflowX: "hidden",
							padding: "14px 10px 8px",
						}}
					>
						<div
							style={{
								padding: "6px 8px 10px",
								fontSize: "0.7rem",
								textTransform: "uppercase",
								letterSpacing: "0.06em",
								fontWeight: 800,
								color: "#71717a",
							}}
						>
							Historial
						</div>
						{visibleConversations.length === 0 && (
							<div
								style={{
									padding: "20px 12px",
									textAlign: "center",
									color: "#52525b",
									fontSize: "0.8rem",
								}}
							>
								{conversationSearch.trim()
									? "Sin resultados"
									: "No hay conversaciones"}
							</div>
						)}
						{visibleConversations.map((conv) => (
							<div
								key={conv.id}
								style={{
									display: "flex",
									alignItems: "center",
									boxSizing: "border-box",
									width: "100%",
									maxWidth: "100%",
									padding: "10px 14px",
									borderRadius: "13px",
									marginBottom: "2px",
									background:
										activeConversationId === conv.id ? "#111" : "transparent",
									transition: "background 0.15s",
									gap: "8px",
								}}
								onMouseEnter={(e) => {
									if (activeConversationId !== conv.id) {
										e.currentTarget.style.background = "#1c1c22";
									}
								}}
								onMouseLeave={(e) => {
									if (activeConversationId !== conv.id) {
										e.currentTarget.style.background = "transparent";
									}
								}}
							>
								{editingConvId === conv.id ? (
									<div style={{ flex: 1, overflow: "hidden" }}>
										<input
											id={`conversation-title-${conv.id}`}
											name="conversationTitle"
											type="text"
											value={editingTitle}
											onChange={(e) => setEditingTitle(e.target.value)}
											onBlur={() => void handleSaveTitle(conv.id)}
											onKeyDown={(e) => {
												if (e.key === "Enter") void handleSaveTitle(conv.id);
												if (e.key === "Escape") setEditingConvId(null);
											}}
											onClick={(e) => e.stopPropagation()}
											style={{
												width: "100%",
												background: "#09090b",
												border: "1px solid #3f3f46",
												color: "#f4f4f5",
												fontSize: "0.93rem",
												padding: "2px 4px",
												borderRadius: "4px",
												outline: "none",
											}}
										/>
									</div>
								) : (
									<button
										type="button"
										onClick={() => handleSelectConversation(conv.id)}
										onDoubleClick={(e) => {
											e.stopPropagation();
											setEditingConvId(conv.id);
											setEditingTitle(conv.title || "Sin título");
										}}
										style={{
											flex: 1,
											overflow: "hidden",
											display: "flex",
											alignItems: "center",
											gap: 8,
											padding: 0,
											border: "none",
											background: "transparent",
											fontFamily: "inherit",
											cursor: "pointer",
											textAlign: "left",
										}}
									>
										{isExecutionActive(executionByConversation[conv.id]) && (
											<span
												data-tooltip="El agente sigue trabajando en este chat"
												style={{
													width: "8px",
													height: "8px",
													borderRadius: "50%",
													background: "#6366f1",
													boxShadow: "0 0 10px rgba(99,102,241,0.8)",
													animation: "pulse 1.4s infinite",
													flexShrink: 0,
												}}
											/>
										)}
										{!isExecutionActive(executionByConversation[conv.id]) &&
											executionByConversation[conv.id]?.status ===
												"completed" &&
											executionByConversation[conv.id]?.executionId &&
											notifiedExecutionRef.current.has(
												executionByConversation[conv.id]?.executionId,
											) && (
												<span
													data-tooltip="Tarea terminada"
													style={{
														width: "8px",
														height: "8px",
														borderRadius: "50%",
														background: "#10b981",
														flexShrink: 0,
													}}
												/>
											)}
										<span
											style={{
												fontSize: "0.83rem",
												color:
													activeConversationId === conv.id ? "#fff" : "#d4d4d8",
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
											}}
											data-tooltip="Doble clic para editar"
										>
											{conv.title || "Sin título"}
										</span>
									</button>
								)}
								<div
									style={{
										display: "flex",
										gap: "4px",
										opacity: activeConversationId === conv.id ? 1 : 0.6,
										flexShrink: 0,
									}}
								>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setEditingConvId(conv.id);
											setEditingTitle(conv.title || "Sin título");
										}}
										data-tooltip="Editar título"
										style={{
											background: "none",
											border: "none",
											color: "#52525b",
											cursor: "pointer",
											padding: "4px",
											borderRadius: "6px",
											display: "flex",
											alignItems: "center",
											flexShrink: 0,
											transition: "color 0.15s",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.color = "#a1a1aa";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.color = "#52525b";
										}}
									>
										<svg
											aria-hidden="true"
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
											<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
										</svg>
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											handleDeleteConversation(conv.id);
										}}
										data-tooltip="Eliminar conversación"
										style={{
											background: "none",
											border: "none",
											color: "#52525b",
											cursor: "pointer",
											padding: "4px",
											borderRadius: "6px",
											display: "flex",
											alignItems: "center",
											flexShrink: 0,
											transition: "color 0.15s",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.color = "#ef4444";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.color = "#52525b";
										}}
									>
										<svg
											aria-hidden="true"
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<polyline points="3 6 5 6 21 6" />
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
										</svg>
									</button>
								</div>
							</div>
						))}
					</div>

					<div
						style={{
							padding: "10px 14px 14px",
							borderTop: "1px solid #111",
							display: "grid",
							gap: "10px",
							overflowX: "hidden",
							boxSizing: "border-box",
						}}
					>
						<button
							type="button"
							onClick={() => setWorkspaceView("media")}
							aria-pressed={workspaceView === "media"}
							style={{
								width: "100%",
								boxSizing: "border-box",
								padding: "10px 12px",
								borderRadius: "12px",
								border: `1px solid ${workspaceView === "media" ? "#202020" : "transparent"}`,
								background: workspaceView === "media" ? "#111" : "transparent",
								color: workspaceView === "media" ? "#f4f4f5" : "#e4e4e7",
								fontFamily: "inherit",
								fontWeight: 700,
								fontSize: "0.92rem",
								cursor: "pointer",
								display: "flex",
								alignItems: "center",
								gap: "10px",
								textAlign: "left",
							}}
						>
							<span
								aria-hidden="true"
								style={{ display: "flex", color: "#f4f4f5" }}
							>
								<svg
									aria-hidden="true"
									width="19"
									height="19"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.9"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<rect x="3" y="5" width="18" height="14" rx="3" />
									<circle
										cx="8.5"
										cy="10"
										r="1.4"
										fill="currentColor"
										stroke="none"
									/>
									<path d="m5 17 4.2-4.2a1.5 1.5 0 0 1 2.1 0L13 14.5l2.2-2.2a1.5 1.5 0 0 1 2.1 0L21 16" />
								</svg>
							</span>
							<span style={{ flex: 1 }}>Biblioteca de medios</span>
						</button>
						<button
							type="button"
							onClick={() => onNavigate?.("settings")}
							style={{
								width: "100%",
								boxSizing: "border-box",
								padding: "10px 12px",
								borderRadius: "14px",
								border: "none",
								background: "transparent",
								color: "#f4f4f5",
								fontFamily: "inherit",
								cursor: "pointer",
								display: "flex",
								alignItems: "center",
								gap: "10px",
								textAlign: "left",
							}}
							data-tooltip="Configuración y resto de secciones"
						>
							<span
								style={{
									width: "30px",
									height: "30px",
									borderRadius: "999px",
									background: "#27272a",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									flexShrink: 0,
								}}
							>
								<svg
									aria-hidden="true"
									width="17"
									height="17"
									viewBox="0 0 24 24"
									fill="none"
									stroke="#c4b5fd"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M20 21a8 8 0 0 0-16 0" />
									<circle cx="12" cy="8" r="4" />
								</svg>
							</span>
							<span style={{ flex: 1, minWidth: 0 }}>
								<span
									style={{
										display: "block",
										fontSize: "0.84rem",
										fontWeight: 800,
									}}
								>
									Usuario Local
								</span>
								<span
									style={{
										display: "block",
										fontSize: "0.7rem",
										color: "#71717a",
									}}
								>
									Auto-hospedado
								</span>
							</span>
							<span
								aria-hidden="true"
								style={{
									width: "34px",
									height: "34px",
									borderRadius: "12px",
									border: "1px solid #2f2f35",
									background: "#17171b",
									color: "#d4d4d8",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									flexShrink: 0,
								}}
							>
								<svg
									aria-hidden="true"
									width="17"
									height="17"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
									<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.11.35.39.72 1.55 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1Z" />
								</svg>
							</span>
						</button>
					</div>
				</div>
			)}

			{/* Main area */}
			<div
				style={{
					flex: 1,
					display: "flex",
					flexDirection: "column",
					height: "100%",
					minWidth: 0,
					position: "relative",
				}}
			>
				{workspaceView === "media" ? (
					<>
						{!sidebarOpen && (
							<div
								style={{
									padding: "10px 16px",
									background: "#09090b",
									borderBottom: "1px solid #27272a",
									display: "flex",
									alignItems: "center",
									gap: "10px",
								}}
							>
								<button
									type="button"
									onClick={() => setSidebarOpen(true)}
									data-tooltip="Mostrar panel"
									style={{
										background: "none",
										border: "1px solid #3f3f46",
										borderRadius: "8px",
										color: "#a1a1aa",
										cursor: "pointer",
										padding: "6px 8px",
										display: "flex",
										alignItems: "center",
									}}
								>
									<svg
										aria-hidden="true"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
										<line x1="9" y1="3" x2="9" y2="21" />
									</svg>
								</button>
								<button
									type="button"
									onClick={() => setWorkspaceView("chat")}
									style={{
										border: "1px solid #3f3f46",
										borderRadius: "8px",
										background: "#18181b",
										color: "#f4f4f5",
										cursor: "pointer",
										fontFamily: "inherit",
										fontWeight: 700,
										padding: "6px 12px",
									}}
								>
									Volver al chat
								</button>
							</div>
						)}
						<div
							className="chat-media-library-view"
							style={{
								flex: 1,
								minHeight: 0,
								overflow: "hidden",
								background: "#000",
							}}
						>
							<Suspense
								fallback={
									<div
										style={{
											height: "100%",
											display: "flex",
											alignItems: "center",
											justifyContent: "center",
											color: "#a1a1aa",
										}}
									>
										Cargando biblioteca...
									</div>
								}
							>
								<MediaLibraryPage />
							</Suspense>
						</div>
					</>
				) : (
					<>
						{/* Top bar */}
						<div
							className="chat-status-bar"
							style={{
								position: "relative",
								zIndex: 10,
								padding: "10px 24px",
								background: "#09090b",
								borderBottom: "1px solid #27272a",
								display: "flex",
								alignItems: "center",
								gap: "10px",
								flexWrap: "wrap",
							}}
						>
							{!sidebarOpen && (
								<button
									type="button"
									onClick={() => setSidebarOpen((v) => !v)}
									style={{
										background: "none",
										border: "1px solid #3f3f46",
										borderRadius: "8px",
										color: "#a1a1aa",
										cursor: "pointer",
										padding: "6px 8px",
										display: "flex",
										alignItems: "center",
										transition: "border-color 0.2s",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.borderColor = "#6366f1";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.borderColor = "#3f3f46";
									}}
									data-tooltip={sidebarOpen ? "Ocultar panel" : "Mostrar panel"}
								>
									<svg
										aria-hidden="true"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
										<line x1="9" y1="3" x2="9" y2="21" />
									</svg>
								</button>
							)}

							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "8px",
									padding: "6px 12px",
									borderRadius: "8px",
									background: isConnected
										? "rgba(16, 185, 129, 0.1)"
										: "rgba(239, 68, 68, 0.1)",
									border: `1px solid ${isConnected ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
								}}
							>
								<div
									style={{
										width: "8px",
										height: "8px",
										borderRadius: "50%",
										background: isConnected ? "#10b981" : "#ef4444",
										flexShrink: 0,
										boxShadow: isConnected
											? "0 0 8px rgba(16, 185, 129, 0.5)"
											: "0 0 8px rgba(239, 68, 68, 0.5)",
										animation: isConnected ? "pulse 2s infinite" : "none",
									}}
								/>
								<span
									style={{
										color: isConnected ? "#10b981" : "#ef4444",
										fontSize: "0.85rem",
										fontWeight: 700,
									}}
								>
									{isConnected ? "● CONECTADO" : "○ DESCONECTADO"}
								</span>
							</div>

							{/* Agent selector */}
							<select
								id="chat-agent-selector"
								name="agentId"
								value={selectedAgentId}
								onChange={(e) => setSelectedAgentId(e.target.value)}
								style={{
									marginLeft: "12px",
									padding: "6px 12px",
									borderRadius: "8px",
									border: "1px solid #3f3f46",
									background: "#18181b",
									color: "#f4f4f5",
									fontSize: "0.8rem",
									outline: "none",
									cursor: "pointer",
									fontFamily: "inherit",
								}}
							>
								<option value="">Seleccionar agente</option>
								{agents.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
									</option>
								))}
							</select>

							{/* Model selector — reflects/edits the active agent's model */}
							<select
								aria-label="Modelo del agente"
								value={activeModelValue}
								disabled={!canEditAgent || modelGroups.length === 0}
								onChange={(e) => {
									if (agentForControls?.id) {
										void updateAgentConfig(agentForControls.id, {
											model: e.target.value,
										});
									}
								}}
								data-tooltip="Modelo del agente activo"
								style={{
									marginLeft: "8px",
									padding: "6px 12px",
									borderRadius: "8px",
									border: "1px solid #3f3f46",
									background: "#18181b",
									color: "#f4f4f5",
									fontSize: "0.8rem",
									outline: "none",
									cursor: canEditAgent ? "pointer" : "not-allowed",
									fontFamily: "inherit",
									maxWidth: "220px",
								}}
							>
								{!activeModelValue && <option value="">Modelo…</option>}
								{modelGroups.map((group) => (
									<optgroup key={group.providerKey} label={group.providerName}>
										{group.models.map((m) => (
											<option key={m.value} value={m.value}>
												{m.label}
											</option>
										))}
									</optgroup>
								))}
							</select>

							{/* Reasoning selector — options scoped to the active model */}
							<select
								aria-label="Nivel de razonamiento"
								value={activeReasoning}
								disabled={!canEditAgent || !activeCapabilities?.supportsReasoning}
								onChange={(e) => {
									if (agentForControls?.id) {
										void updateAgentConfig(agentForControls.id, {
											reasoningEffort: e.target.value,
										});
									}
								}}
								data-tooltip={
									activeCapabilities?.supportsReasoning
										? "Nivel de pensamiento del modelo"
										: "Este modelo no admite razonamiento ajustable"
								}
								style={{
									marginLeft: "8px",
									padding: "6px 12px",
									borderRadius: "8px",
									border: "1px solid #3f3f46",
									background: "#18181b",
									color: "#f4f4f5",
									fontSize: "0.8rem",
									outline: "none",
									cursor: canEditAgent && activeCapabilities?.supportsReasoning
										? "pointer"
										: "not-allowed",
									fontFamily: "inherit",
								}}
							>
								{allowedEfforts.map((effort) => (
									<option key={effort} value={effort}>
										{REASONING_LABELS[effort]}
									</option>
								))}
							</select>

							<button
								type="button"
								onClick={() => {
									const next = !streamEnabled;
									setStreamEnabled(next);
									try {
										localStorage.setItem("octopus-stream", String(next));
									} catch {}
								}}
								data-tooltip={
									streamEnabled
										? "Streaming activado (respuesta en tiempo real)"
										: "Streaming desactivado (respuesta completa)"
								}
								style={{
									marginLeft: "8px",
									padding: "6px 12px",
									borderRadius: "8px",
									border: `1px solid ${streamEnabled ? "rgba(99, 102, 241, 0.4)" : "#3f3f46"}`,
									background: streamEnabled
										? "rgba(99, 102, 241, 0.1)"
										: "#18181b",
									color: streamEnabled ? "#818cf8" : "#71717a",
									fontSize: "0.8rem",
									cursor: "pointer",
									display: "flex",
									alignItems: "center",
									gap: "6px",
									fontWeight: 500,
									transition: "all 0.2s",
									fontFamily: "inherit",
								}}
							>
								<svg
									aria-hidden="true"
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
								</svg>
								{streamEnabled ? "Stream" : "Completo"}
							</button>

							<button
								type="button"
								onClick={() => {
									const next = tenacidad === "tenaz" ? "normal" : "tenaz";
									setTenacidad(next);
									try {
										localStorage.setItem("octopus-tenacidad", next);
									} catch {}
									apiPut("/api/config/tenacidad.level", next).catch(() => {});
								}}
								data-tooltip={
									tenacidad === "tenaz"
										? "Modo Tenaz: el agente no se detiene hasta completar la tarea"
										: "Modo Normal: el agente puede detenerse por l\u00edmites de iteraci\u00f3n"
								}
								style={{
									marginLeft: "8px",
									padding: "6px 12px",
									borderRadius: "8px",
									border: `1px solid ${tenacidad === "tenaz" ? "rgba(245, 158, 11, 0.4)" : "#3f3f46"}`,
									background:
										tenacidad === "tenaz"
											? "rgba(245, 158, 11, 0.1)"
											: "#18181b",
									color: tenacidad === "tenaz" ? "#f59e0b" : "#71717a",
									fontSize: "0.8rem",
									cursor: "pointer",
									display: "flex",
									alignItems: "center",
									gap: "6px",
									fontWeight: 500,
									transition: "all 0.2s",
									fontFamily: "inherit",
								}}
							>
								{tenacidad === "tenaz" ? "🔥" : "⚡"}
								{tenacidad === "tenaz" ? "Tenaz" : "Normal"}
							</button>
							<div style={{ flex: 1 }} />
							{(() => {
								const providerName =
									activeCapabilities?.providerDisplayName ??
									status?.agent?.providerDisplayName ??
									status?.providerDisplayName ??
									status?.provider;
								const modelName =
									agentForControls?.effectiveModel ??
									status?.agent?.model ??
									status?.model ??
									status?.provider;
								const modelShort = modelName?.includes("/")
									? modelName.slice(modelName.indexOf("/") + 1)
									: modelName;
								if (!providerName && !modelName) return null;
								return (
									<div
										className="chat-status-meta"
										style={{ display: "flex", alignItems: "center", gap: "8px" }}
									>
										{agentForControls?.name && (
											<span
												style={{
													fontSize: "0.7rem",
													padding: "4px 10px",
													borderRadius: "20px",
													background: "rgba(244, 114, 182, 0.1)",
													color: "#f472b6",
													border: "1px solid rgba(244, 114, 182, 0.2)",
													fontWeight: 500,
												}}
											>
												{agentForControls.name}
											</span>
										)}
										{activeReasoning && activeReasoning !== "none" && (
											<span
												style={{
													fontSize: "0.75rem",
													padding: "4px 10px",
													borderRadius: "20px",
													background: "rgba(16, 185, 129, 0.1)",
													color: "#10b981",
													border: "1px solid rgba(16, 185, 129, 0.2)",
													fontWeight: 500,
												}}
											>
												Razonamiento: {REASONING_LABELS[activeReasoning]}
											</span>
										)}
										<span
											style={{
												fontSize: "0.75rem",
												padding: "4px 10px",
												borderRadius: "20px",
												background: "rgba(99, 102, 241, 0.1)",
												color: "#818cf8",
												border: "1px solid rgba(99, 102, 241, 0.2)",
												fontWeight: 500,
											}}
										>
											{providerName ? `${providerName} · ` : ""}Modelo:{" "}
											{modelShort || "—"}
										</span>
									</div>
								);
							})()}
						</div>

						{/* Messages */}
						<div
							ref={messagesContainerRef}
							className="chat-messages"
							onScroll={handleMessagesScroll}
							style={{ flex: 1, overflowY: "auto", padding: "30px 20px" }}
						>
							<div
								className="chat-messages-inner"
								style={{ maxWidth: "800px", margin: "0 auto" }}
							>
								{messages.length === 0 && (
									<div className="chat-welcome">
										<div className="chat-welcome-title-row">
											<div className="chat-welcome-logo">
												<AgentAvatarContent
													agent={selectedAgent}
													alt={
														selectedAgent
															? `${selectedAgent.name} avatar`
															: "Octopus"
													}
													imageStyle={{
														width: "100%",
														height: "100%",
														objectFit: "contain",
													}}
													textStyle={{ fontSize: "2.2rem" }}
												/>
											</div>
											<h1 className="chat-welcome-title">
												{(() => {
													const h = new Date().getHours();
													const g =
														h < 12
															? "Buenos dias"
															: h < 19
																? "Buenas tardes"
																: "Buenas noches";
													return `${g}, ${userDisplayName}`;
												})()}
											</h1>
										</div>
										<div className="chat-welcome-chips">
											{[
												{ label: "Escribir", prompt: "Ayudame a escribir " },
												{ label: "Aprender", prompt: "Explicame paso a paso " },
												{
													label: "Codigo",
													prompt: "Ayudame con este codigo: ",
												},
												{
													label: "Vida personal",
													prompt: "Ayudame a organizar ",
												},
												{
													label: "Multimedia",
													prompt: "Genera una imagen de ",
												},
											].map((suggestion) => (
												<button
													key={suggestion.label}
													type="button"
													className="chat-welcome-chip"
													onClick={() => {
														setInput(suggestion.prompt);
														inputRef.current?.focus();
													}}
												>
													{suggestion.label}
												</button>
											))}
										</div>
									</div>
								)}
								{(() => {
									const visibleCount = Math.min(
										visibleMessageCount,
										messages.length,
									);
									const visible = messages.slice(-visibleCount);
									const collapsedCount = messages.length - visible.length;
									const nextBatchCount = Math.min(
										MESSAGE_PAGE_SIZE,
										collapsedCount,
									);
									return (
										<>
											{collapsedCount > 0 && (
												<button
													type="button"
													onClick={revealOlderMessages}
													style={{
														display: "block",
														width: "100%",
														padding: "12px",
														marginBottom: "16px",
														background: "#18181b",
														border: "1px dashed #3f3f46",
														borderRadius: "12px",
														color: "#71717a",
														fontSize: "0.85rem",
														cursor: "pointer",
														textAlign: "center",
													}}
												>
													↑ Mostrar {nextBatchCount} mensajes anteriores (
													{collapsedCount} restantes)
												</button>
											)}
											{visible.map((msg) => (
												<ChatMessage
													key={msg.id}
													msg={msg}
													collapsed={false}
													agent={selectedAgent}
												/>
											))}
										</>
									);
								})()}
								{activeExecution?.completionReason === "pending_action" &&
									activeExecution.pendingAction && (
										<div
											style={{
												margin: "14px 0",
												padding: "14px 16px",
												borderRadius: 12,
												border: "1px solid #854d0e",
												background: "rgba(120, 53, 15, 0.18)",
												color: "#fde68a",
											}}
										>
											<strong>Acción pendiente</strong>
											<div style={{ marginTop: 6, color: "#fef3c7" }}>
												{stripInternalMarkers(
												activeExecution.pendingAction.summary,
											)}
											</div>
											{activeExecution.pendingAction.resumable && (
												<button
													type="button"
													onClick={() => {
														setInput("continúa");
														inputRef.current?.focus();
													}}
													style={{
														marginTop: 10,
														padding: "7px 12px",
														borderRadius: 8,
														border: "1px solid #f59e0b",
														background: "transparent",
														color: "#fbbf24",
														cursor: "pointer",
													}}
												>
													Preparar continuación
												</button>
											)}
										</div>
									)}
								{toolActions.length > 0 && (
									<details
										style={{
											margin: "12px 0",
											padding: "10px 14px",
											border: "1px solid #3f3f46",
											borderRadius: 10,
											background: "#18181b",
										}}
									>
										<summary style={{ cursor: "pointer", color: "#d4d4d8" }}>
											Acciones de herramientas ({toolActions.length})
										</summary>
										<div style={{ marginTop: 10, display: "grid", gap: 8 }}>
											{toolActions.map((action) => (
												<details key={action.id} style={{ color: "#a1a1aa" }}>
													<summary style={{ cursor: "pointer" }}>
														<strong style={{ color: "#e4e4e7" }}>
															{action.tool_name}
														</strong>{" "}
														· {action.status === "uncertain" ? "por verificar" : action.status}
													</summary>
													<pre
														style={{
															whiteSpace: "pre-wrap",
															wordBreak: "break-word",
															fontSize: 12,
														}}
													>
														{action.error ?? action.result_json ?? action.arguments_json}
													</pre>
												</details>
											))}
										</div>
									</details>
								)}
								{shouldShowAgentActivity && (
									<AgentActivityPanel
										activities={visibleAgentActivity}
										multiAgentPlan={multiAgentPlan}
										multiAgentWorkers={multiAgentWorkers}
										agent={selectedAgent}
										workflowRunId={activeWorkflowRunId}
										onOpenWorkflow={openWorkflowMonitor}
									/>
								)}
								{!shouldShowAgentActivity && activeWorkflowRunId && (
									<div className="agent-activity-row">
										<div
											className="agent-activity-avatar"
											style={{
												boxShadow: `0 10px 28px ${selectedAgent?.color ?? "#ff6f3b"}24`,
											}}
										>
											<AgentAvatarContent
												agent={selectedAgent}
												alt={
													selectedAgent
														? `${selectedAgent.name} avatar`
														: "Octopus"
												}
											/>
										</div>
										<div className="agent-activity-card compact">
											<div className="agent-activity-current">
												<div style={{ minWidth: 0 }}>
													<div className="agent-activity-title">
														Workflow durable registrado
													</div>
													<div className="agent-activity-detail">
														El run {activeWorkflowRunId} tiene subtareas,
														eventos y artefactos persistidos.
													</div>
												</div>
												<button
													type="button"
													onClick={() =>
														openWorkflowMonitor(activeWorkflowRunId)
													}
													className="multi-agent-pill"
													style={{ cursor: "pointer" }}
												>
													Abrir monitor
												</button>
											</div>
										</div>
									</div>
								)}

								<div
									ref={messagesEndRef}
									style={{ height: "1px", width: "100%" }}
								/>
							</div>
						</div>
						{showScrollToBottom && messages.length > 0 && (
							<button
								type="button"
								onClick={() => scrollToBottom()}
								data-tooltip="Volver al final del chat"
								style={{
									position: "absolute",
									left: "50%",
									bottom: "112px",
									transform: "translateX(-50%)",
									zIndex: 20,
									display: "inline-flex",
									alignItems: "center",
									gap: "8px",
									padding: "10px 14px",
									borderRadius: "999px",
									border: "1px solid rgba(99,102,241,.45)",
									background: "rgba(24,24,27,.92)",
									color: "#e0e7ff",
									fontSize: "0.82rem",
									fontWeight: 800,
									fontFamily: "inherit",
									cursor: "pointer",
									boxShadow:
										"0 12px 30px rgba(0,0,0,.32), 0 0 24px rgba(99,102,241,.18)",
									backdropFilter: "blur(10px)",
								}}
							>
								<svg
									aria-hidden="true"
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M12 5v14" />
									<path d="m19 12-7 7-7-7" />
								</svg>
								Ir al final
							</button>
						)}

						{/* Input Area */}
						<div
							className="chat-input-area"
							style={{
								padding: "0 20px 30px",
								background:
									"linear-gradient(180deg, rgba(9,9,11,0) 0%, rgba(9,9,11,1) 30%)",
							}}
						>
							<div
								className="chat-composer-shell"
								style={{
									maxWidth: "800px",
									margin: "0 auto",
									position: "relative",
								}}
							>
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										background: "#18181b",
										borderRadius: "16px",
										border: "1px solid #3f3f46",
										padding: "8px 12px",
										boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
										transition: "border-color 0.2s",
									}}
								>
									{pendingAttachments.length > 0 && (
										<div
											style={{
												display: "flex",
												flexWrap: "wrap",
												gap: "8px",
												paddingBottom: "8px",
												borderBottom: "1px solid #27272a",
												marginBottom: "8px",
											}}
										>
											{pendingAttachments.map((attachment, idx) => {
												const cat = fileCategory(
													attachment.file?.name ?? attachment.url,
													attachment.file?.type,
												);
												const badge = fileTypeBadge(
													attachment.file?.name ?? attachment.url,
													attachment.file?.type,
												);
												const isImage = cat.kind === "image";
												return (
												<div
													key={attachment.previewUrl}
													style={{
														position: "relative",
														width: isImage ? "60px" : "auto",
														maxWidth: "240px",
														height: isImage ? "60px" : "50px",
														borderRadius: "8px",
														overflow: "hidden",
														border: "1px solid #3f3f46",
														display: "flex",
														alignItems: "center",
														gap: "6px",
														padding: isImage ? 0 : "4px 30px 4px 6px",
														background: isImage
															? "transparent"
															: "rgba(39,39,42,0.6)",
													}}
												>
													<button
														type="button"
														onClick={() =>
															isImage &&
															setMediaPreviewSrc(attachment.previewUrl)
														}
														aria-label={
															isImage
																? "Ampliar imagen adjunta"
																: cat.label
														}
														style={{
															width: "100%",
															height: "100%",
															padding: 0,
															border: 0,
															background: "transparent",
															cursor: isImage ? "zoom-in" : "default",
															display: "flex",
															alignItems: "center",
															gap: "6px",
														}}
													>
														{isImage ? (
															<img
																src={attachment.previewUrl}
																alt="adjunto"
																style={{
																	width: "100%",
																	height: "100%",
																	objectFit: "cover",
																	display: "block",
																}}
															/>
														) : (
															<>
																<span
																	style={{
																		display: "inline-flex",
																		alignItems: "center",
																		justifyContent: "center",
																		flexShrink: 0,
																		lineHeight: 0,
																	}}
																// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG values are generated locally and labels are XML-escaped.
																dangerouslySetInnerHTML={{
																		__html: fileIconSvg(badge.bg, badge.label, 42),
																	}}
																/>
																<span
																	style={{
																		display: "flex",
																		flexDirection: "column",
																		lineHeight: 1.1,
																		overflow: "hidden",
																		textAlign: "left",
																	}}
																>
																	<span
																		style={{
																			fontSize: "12px",
																			whiteSpace: "nowrap",
																			overflow: "hidden",
																			textOverflow: "ellipsis",
																			maxWidth: "150px",
																		}}
																	>
																		{attachment.file?.name ?? cat.label}
																	</span>
																	<span
																		style={{
																			fontSize: "10px",
																			opacity: 0.6,
																		}}
																	>
																		{cat.label}
																		{attachment.file?.size
																			? ` · ${formatFileSize(attachment.file.size)}`
																			: ""}
																	</span>
																</span>
															</>
														)}
													</button>
													<button
														type="button"
														onClick={() => removePendingAttachment(idx)}
														style={{
															position: "absolute",
															top: "50%",
															right: "4px",
															transform: "translateY(-50%)",
															background: "rgba(0,0,0,0.6)",
															color: "white",
															border: "none",
															borderRadius: "50%",
															width: "20px",
															height: "20px",
															display: "flex",
															alignItems: "center",
															justifyContent: "center",
															cursor: "pointer",
															fontSize: "12px",
															zIndex: 1,
														}}
													>
														✕
													</button>
												</div>
												);
											})}
										</div>
									)}
									<div style={{ display: "flex", alignItems: "flex-end" }}>
										<input
											id="chat-image-upload"
											name="imageUpload"
											type="file"
											ref={fileInputRef}
											style={{ display: "none" }}
											onChange={handleFileUpload}
											accept={ACCEPTED_ATTACHMENT_TYPES}
										/>
										<button
											type="button"
											aria-label="Adjuntar imagen"
											onClick={() => fileInputRef.current?.click()}
											disabled={isUploadingImage}
											data-tooltip="Adjuntar imagen"
											style={{
												width: "36px",
												height: "36px",
												borderRadius: "10px",
												border: "none",
												background: "transparent",
												color: isUploadingImage ? "#6366f1" : "#a1a1aa",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												cursor: isUploadingImage ? "wait" : "pointer",
												transition: "all 0.2s",
												marginBottom: "4px",
												marginRight: "4px",
												flexShrink: 0,
											}}
											onMouseEnter={(e) => {
												if (!isUploadingImage)
													e.currentTarget.style.color = "#f4f4f5";
											}}
											onMouseLeave={(e) => {
												if (!isUploadingImage)
													e.currentTarget.style.color = "#a1a1aa";
											}}
										>
											{isUploadingImage ? (
												<svg
													aria-hidden="true"
													width="20"
													height="20"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													style={{ animation: "spin 2s linear infinite" }}
												>
													<circle cx="12" cy="12" r="9" strokeDasharray="30" />
												</svg>
											) : (
												<svg
													aria-hidden="true"
													width="20"
													height="20"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												>
													<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
												</svg>
											)}
										</button>
										<button
											type="button"
											aria-label={
												isDictating ? "Detener dictado" : "Iniciar dictado"
											}
											onClick={isDictating ? stopDictation : startDictation}
											disabled={dictationUnavailable}
											data-tooltip={
												!speechSupported
													? "Dictado no soportado"
													: isDictating
														? "Detener dictado"
														: "Dictar mensaje"
											}
											style={{
												order: 2,
												width: "36px",
												height: "36px",
												borderRadius: "10px",
												border: "none",
												background: isDictating ? "#ef4444" : "transparent",
												color: dictationUnavailable
													? "#52525b"
													: isDictating
														? "#fff"
														: "#a1a1aa",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												cursor: dictationUnavailable
													? "not-allowed"
													: "pointer",
												transition: "all 0.2s",
												marginBottom: "4px",
												marginRight: "4px",
												flexShrink: 0,
											}}
											onMouseEnter={(e) => {
												if (!isDictating && !dictationUnavailable)
													e.currentTarget.style.color = "#f4f4f5";
											}}
											onMouseLeave={(e) => {
												if (!isDictating && !dictationUnavailable)
													e.currentTarget.style.color = "#a1a1aa";
											}}
										>
											<svg
												aria-hidden="true"
												width="20"
												height="20"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
												<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
												<line x1="12" y1="19" x2="12" y2="22" />
											</svg>
										</button>
										<textarea
											id="chat-message-input"
											name="message"
											ref={inputRef}
											value={input}
											onChange={handleInput}
											onKeyDown={handleKeyDown}
											placeholder={
												isConnected
													? "Escribe un mensaje..."
													: "Conectando al servidor..."
											}
											disabled={!isConnected}
											rows={1}
											style={{
												order: 1,
												flex: 1,
												padding: "10px 8px",
												background: "transparent",
												border: "none",
												color: "#f4f4f5",
												fontSize: "0.95rem",
												outline: "none",
												resize: "none",
												maxHeight: "200px",
												lineHeight: "1.5",
												fontFamily: "inherit",
											}}
										/>
										{activeBusy ? (
											<button
												type="button"
												onClick={() => void handleStopExecution()}
												aria-label="Parar tarea del agente"
												data-tooltip="Parar tarea del agente"
												style={{
													order: 3,
													width: "36px",
													height: "36px",
													borderRadius: "10px",
													border: "none",
													background: "#ef4444",
													color: "#fff",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													cursor: "pointer",
													transition: "all 0.2s",
													marginBottom: "4px",
													flexShrink: 0,
												}}
											>
												<svg
													width="16"
													height="16"
													viewBox="0 0 24 24"
													fill="currentColor"
													aria-hidden="true"
												>
													<title>Parar</title>
													<rect x="6" y="6" width="12" height="12" rx="2" />
												</svg>
											</button>
										) : (
											<button
												type="button"
												onClick={handleSend}
												disabled={
													(!input.trim() && pendingAttachments.length === 0) ||
													!isConnected
												}
												style={{
													order: 3,
													width: "36px",
													height: "36px",
													borderRadius: "10px",
													border: "none",
													background:
														(!input.trim() &&
															pendingAttachments.length === 0) ||
														!isConnected
															? "#27272a"
															: "#6366f1",
													color:
														(!input.trim() &&
															pendingAttachments.length === 0) ||
														!isConnected
															? "#52525b"
															: "#fff",
													display: "flex",
													alignItems: "center",
													justifyContent: "center",
													cursor:
														(!input.trim() &&
															pendingAttachments.length === 0) ||
														!isConnected
															? "not-allowed"
															: "pointer",
													transition: "all 0.2s",
													marginBottom: "4px",
													flexShrink: 0,
												}}
											>
												<svg
													width="18"
													height="18"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
													aria-hidden="true"
												>
													<title>Enviar</title>
													<line x1="22" y1="2" x2="11" y2="13" />
													<polygon points="22 2 15 22 11 13 2 9 22 2" />
												</svg>
											</button>
										)}
									</div>
								</div>
								<div
									style={{
										textAlign: "center",
										marginTop: "10px",
										fontSize: "0.7rem",
										color: "#71717a",
									}}
								>
									Octopus AI puede cometer errores. Considera verificar la
									información importante.
								</div>
							</div>
						</div>
					</>
				)}
			</div>

			<style>{`
				@keyframes spin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
				@keyframes pulse {
					0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
					40% { opacity: 1; transform: scale(1); }
				}
				@keyframes fadeInFast {
					from { opacity: 0; transform: translateY(8px); }
					to { opacity: 1; transform: translateY(0); }
				}
				@keyframes toolFloat {
					0%, 100% { transform: translateY(0) scale(1); }
					50% { transform: translateY(-2px) scale(1.04); }
				}
				.agent-activity-row { display: flex; align-items: flex-start; margin-bottom: 32px; animation: fadeInFast 0.22s ease-out; }
				.agent-activity-avatar { position: relative; width: 63px; height: 63px; border-radius: 18px; background: rgba(24,24,27,.72); display: flex; align-items: center; justify-content: center; margin-right: 16px; flex-shrink: 0; box-shadow: 0 10px 28px rgba(255,111,59,.14); overflow: visible; }
				.agent-activity-avatar img { width: 54px; height: 54px; object-fit: contain; }
				.agent-thought-cloud { position: absolute; top: -18px; right: -10px; width: 40px; height: 28px; pointer-events: none; animation: thoughtCloudFloat 1.8s infinite ease-in-out; filter: drop-shadow(0 7px 12px rgba(0,0,0,.35)); }
				.agent-thought-cloud span { position: absolute; display: block; border-radius: 999px; background: rgba(244,244,245,.92); border: 1px solid rgba(255,255,255,.78); }
				.agent-thought-cloud span:nth-child(1) { width: 22px; height: 16px; left: 11px; top: 5px; }
				.agent-thought-cloud span:nth-child(2) { width: 16px; height: 16px; left: 2px; top: 9px; opacity: .9; animation: thoughtDotPulse 1.35s infinite ease-in-out; }
				.agent-thought-cloud span:nth-child(3) { width: 9px; height: 9px; left: 0; top: 24px; opacity: .78; animation: thoughtDotPulse 1.35s .18s infinite ease-in-out; }
				@keyframes thoughtCloudFloat { 0%, 100% { transform: translateY(0) scale(.96); opacity: .82; } 50% { transform: translateY(-4px) scale(1.04); opacity: 1; } }
				@keyframes thoughtDotPulse { 0%, 100% { transform: scale(.82); opacity: .62; } 50% { transform: scale(1.08); opacity: 1; } }
				@keyframes iconPulse { 0%, 100% { transform: scale(.9); opacity: .82; } 50% { transform: scale(1.1); opacity: 1; } }
				.agent-activity-card { width: 440px; max-width: calc(100vw - 120px); padding: 12px 14px; border-radius: 16px; background: linear-gradient(135deg, rgba(24,24,27,0.92), rgba(9,9,11,0.84)); border: 1px solid rgba(63,63,70,0.75); box-shadow: 0 12px 34px rgba(0,0,0,0.28); backdrop-filter: blur(10px); }
				.multi-agent-summary { margin-bottom: 12px; padding: 10px 11px; border: 1px solid rgba(99,102,241,0.24); border-radius: 14px; background: rgba(99,102,241,0.08); }
				.multi-agent-summary-top { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
				.multi-agent-pill { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 999px; background: rgba(99,102,241,0.18); color: #c4b5fd; font-size: 0.72rem; font-weight: 800; }
				.multi-agent-pill.muted { background: rgba(39,39,42,0.78); color: #a1a1aa; }
				.multi-agent-plan-text { margin-top: 8px; color: #d4d4d8; font-size: 0.78rem; line-height: 1.4; }
				.multi-agent-live-text { margin-top: 7px; color: #67e8f9; font-size: 0.74rem; font-weight: 700; }
				.multi-agent-workers { margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
				.multi-agent-worker { padding: 10px; border-radius: 14px; border: 1px solid rgba(63,63,70,0.75); background: rgba(9,9,11,0.62); min-width: 0; }
				.multi-agent-worker-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
				.multi-agent-worker-dot { width: 8px; height: 8px; border-radius: 999px; flex-shrink: 0; }
				.multi-agent-worker-title { color: #f4f4f5; font-size: 0.78rem; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.multi-agent-worker-status { margin-left: auto; font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
				.multi-agent-worker-desc { margin-top: 7px; color: #a1a1aa; font-size: 0.72rem; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
				.multi-agent-progress { margin-top: 9px; height: 5px; border-radius: 999px; background: rgba(63,63,70,0.64); overflow: hidden; }
				.multi-agent-progress span { display: block; height: 100%; border-radius: inherit; transition: width 0.25s ease; }
				.multi-agent-current { margin-top: 8px; color: #e4e4e7; font-size: 0.73rem; line-height: 1.35; }
				.multi-agent-worker-steps { margin-top: 8px; display: grid; gap: 6px; }
				.multi-agent-worker-step { display: grid; grid-template-columns: auto minmax(0, auto) minmax(0, 1fr); gap: 6px; align-items: baseline; color: #a1a1aa; font-size: 0.68rem; }
				.multi-agent-worker-step span { color: #71717a; }
				.multi-agent-worker-step b { color: #d4d4d8; font-weight: 800; white-space: nowrap; }
				.multi-agent-worker-step em { color: #a1a1aa; font-style: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.agent-activity-card.compact { max-width: min(760px, calc(100vw - 120px)); }
				.agent-activity-card.compact .multi-agent-summary { margin-bottom: 10px; padding: 9px 10px; }
				.agent-activity-card.compact .multi-agent-plan-text { display: none; }
				.multi-agent-workers.compact-list { grid-template-columns: 1fr; gap: 7px; }
				.multi-agent-workers.compact-list .multi-agent-worker { padding: 8px 10px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
				.multi-agent-workers.compact-list .multi-agent-worker-desc { margin-top: 0; color: #d4d4d8; font-size: 0.78rem; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.multi-agent-workers.compact-list .multi-agent-progress { margin-top: 0; height: 4px; }
				.multi-agent-worker-avatar { position: relative; width: 28px; height: 28px; border-radius: 10px; border: 1px solid rgba(63,63,70,.9); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; background: linear-gradient(135deg, rgba(99,102,241,.18), rgba(14,165,233,.08)); color: #e0e7ff; }
				.multi-agent-worker-avatar.active { animation: toolFloat 1.8s infinite ease-in-out; }
				.agent-glyph { font-size: 15px; line-height: 1; font-weight: 900; }
				.worker-tool-badge { position: absolute; right: -6px; top: -6px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(99,102,241,.42); background: #111827; color: #c4b5fd; font-size: 0.56rem; font-weight: 900; line-height: 1; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
				.worker-tool-badge.active { animation: pulse 1.1s infinite ease-in-out; }
				.worker-tool-badge[data-kind="image"] { color: #f0abfc; border-color: rgba(217,70,239,.45); background: rgba(88,28,135,.92); }
				.worker-tool-badge[data-kind="code"] { color: #86efac; border-color: rgba(34,197,94,.45); background: rgba(20,83,45,.92); }
				.worker-tool-badge[data-kind="web"] { color: #93c5fd; border-color: rgba(59,130,246,.45); background: rgba(30,58,138,.92); }
				.worker-tool-badge[data-kind="video"] { color: #fca5a5; border-color: rgba(239,68,68,.45); background: rgba(127,29,29,.92); }
				.multi-agent-collapsed-note { margin-top: 10px; padding: 9px 10px; border-radius: 12px; border: 1px dashed rgba(99,102,241,.34); color: #a1a1aa; background: rgba(24,24,27,.54); font-size: .76rem; line-height: 1.4; }
				.agent-activity-current { display: flex; align-items: center; gap: 12px; }
				.agent-activity-orb { width: 34px; height: 34px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
				.agent-activity-icon > svg { display: block !important; width: 100% !important; height: 100% !important; max-width: 100% !important; max-height: 100% !important; position: static !important; inset: auto !important; overflow: hidden; flex-shrink: 0; transform-origin: center; transform-box: fill-box; }
				.agent-activity-icon svg * { transform-origin: center; transform-box: fill-box; }
				.agent-activity-title { font-size: 0.88rem; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.agent-activity-detail { margin-top: 2px; font-size: 0.76rem; color: #a1a1aa; line-height: 1.35; }
				.agent-activity-dots { margin-left: auto; display: flex; gap: 4px; padding-left: 10px; }
				.agent-activity-dots span { width: 5px; height: 5px; border-radius: 999px; opacity: 0.35; animation: pulse 1s infinite ease-in-out; }
				.agent-activity-toggle { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 5px 11px; border-radius: 999px; border: 1px solid rgba(99,102,241,.32); background: rgba(99,102,241,.1); color: #c4b5fd; font-size: .72rem; font-weight: 800; font-family: inherit; cursor: pointer; transition: background .16s ease, border-color .16s ease; }
				.agent-activity-toggle:hover { background: rgba(99,102,241,.18); border-color: rgba(99,102,241,.5); }
				.agent-activity-steps { margin-top: 12px; padding-top: 11px; border-top: 1px solid rgba(63,63,70,0.45); display: grid; gap: 8px; }
				.agent-activity-step { display: flex; align-items: center; gap: 9px; color: #d4d4d8; font-size: 0.76rem; min-width: 0; position: relative; }
				.agent-activity-step-line { width: 7px; height: 1px; border-radius: 999px; background: #3f3f46; flex-shrink: 0; }
				.agent-activity-step-icon { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; opacity: 0.9; }
				.agent-activity-step-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.chat-welcome { min-height: min(640px, calc(100vh - 230px)); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 16px 22px; text-align: center; }
				.chat-welcome-plan { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 72px; padding: 9px 16px; border-radius: 13px; background: rgba(24,24,27,.82); color: #a1a1aa; font-size: 0.92rem; font-weight: 700; border: 1px solid rgba(63,63,70,.45); }
				.chat-welcome-title-row { display: flex; align-items: center; justify-content: center; gap: 30px; margin-bottom: 14px; }
				.chat-welcome-logo { width: 184px; height: 184px; display: flex; align-items: center; justify-content: center; object-fit: contain; filter: drop-shadow(0 14px 28px rgba(255,111,59,.18)); image-rendering: auto; }
				.chat-welcome-title { margin: 0; color: #d9d6cd; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(2.35rem, 5vw, 4.45rem); font-weight: 400; letter-spacing: -0.055em; line-height: 1.02; }
				.chat-welcome-subtitle { margin: 0 0 54px; color: #a6a39c; font-size: clamp(1.1rem, 2.2vw, 1.55rem); font-weight: 500; }
				.chat-welcome-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; max-width: 900px; }
				.chat-welcome-chip { padding: 12px 18px; border-radius: 14px; border: 1px solid #383838; background: rgba(31,31,31,.72); color: #c8c4ba; font-family: inherit; font-size: 0.98rem; font-weight: 700; cursor: pointer; transition: all .16s ease; }
				.chat-welcome-chip:hover { background: #2a2926; border-color: #4a4944; color: #f0ede6; transform: translateY(-1px); }
				@media (max-width: 640px) {
					.agent-activity-card { min-width: 0; max-width: calc(100vw - 92px); }
					.agent-activity-detail { font-size: 0.72rem; }
					.agent-activity-steps { display: none; }
					.multi-agent-workers { grid-template-columns: 1fr; }
					.multi-agent-worker-steps { display: none; }
					.media-image-thumb, .media-image-thumb img { width: 96px; height: 96px; }
					.chat-welcome { min-height: calc(100vh - 240px); padding-top: 28px; }
					.chat-welcome-plan { margin-bottom: 38px; }
					.chat-welcome-title-row { flex-direction: column; gap: 10px; }
					.chat-welcome-logo { width: 144px; height: 144px; }
					.chat-welcome-subtitle { margin-bottom: 32px; }
				}
				.markdown-body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
				.markdown-body p { margin: 0 0 12px 0; }
				.markdown-body p:last-child { margin-bottom: 0; }
				.markdown-body code { background: #18181b; padding: 3px 6px; border-radius: 6px; border: 1px solid #27272a; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.85em; color: #e4e4e7; }
				.markdown-body pre { background: #18181b; padding: 16px; border-radius: 12px; border: 1px solid #27272a; overflow-x: auto; margin: 16px 0; }
				.markdown-body pre code { background: none; padding: 0; border: none; color: #e4e4e7; }
				.markdown-body ul, .markdown-body ol { margin: 8px 0 16px; padding-left: 24px; }
				.markdown-body li { margin-bottom: 4px; }
				.markdown-body blockquote { border-left: 4px solid #6366f1; margin: 16px 0; padding: 8px 16px; background: rgba(99, 102, 241, 0.05); border-radius: 0 8px 8px 0; color: #a1a1aa; }
				.markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 24px 0 12px; color: #f4f4f5; font-weight: 600; letter-spacing: -0.02em; }
				.markdown-body a { color: #818cf8; text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 0.2s; }
				.markdown-body a:hover { border-bottom-color: #818cf8; }
				.markdown-body table { border-collapse: collapse; margin: 16px 0; width: 100%; border-radius: 8px; overflow: hidden; border: 1px solid #27272a; }
				.markdown-body th, .markdown-body td { border-bottom: 1px solid #27272a; padding: 10px 14px; text-align: left; }
				.markdown-body th { background: #18181b; font-weight: 500; color: #e4e4e7; }
				.media-embed { margin: 10px 0; display: flex; justify-content: flex-start; align-items: center; width: 100%; gap: 10px; flex-wrap: wrap; }
				.markdown-body-assistant .media-embed { justify-content: center; }
				.markdown-body-assistant .media-embed.media-image { display: flex; width: 100%; }
				.markdown-body-assistant .media-video { width: 100%; max-width: 100%; align-items: center; margin-left: auto; margin-right: auto; }
				.markdown-body-assistant .media-image { justify-content: center; }
				.media-image { display: inline-flex; width: auto; max-width: 100%; }
				.media-image-thumb { display: inline-flex; width: 128px; height: 128px; border-radius: 18px; overflow: hidden; border: 1px solid rgba(63,63,70,.9); background: #111113; box-shadow: 0 10px 26px rgba(0,0,0,.22); transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease; cursor: zoom-in; }
				.media-image-thumb:hover { transform: translateY(-1px); border-color: rgba(129,140,248,.7); box-shadow: 0 14px 34px rgba(99,102,241,.2); }
				.media-image-thumb img { display: block; width: 128px; height: 128px; object-fit: cover; margin: 0; border: 0; border-radius: 0; }
				.media-download-frame { position: relative; display: inline-flex; max-width: 100%; line-height: 0; }
				.markdown-body a.media-image-full, .media-image-full { display: inline-flex; max-width: 100%; cursor: zoom-in; line-height: 0; border: 0 !important; border-bottom: 0 !important; text-decoration: none !important; outline: none; }
				.media-image-full img { display: block; width: auto; height: auto; max-width: 100%; max-height: min(72vh, calc(100vh - 260px)); object-fit: contain; margin: 0 auto; border-radius: 12px; border: 1px solid #27272a; transition: transform 0.2s, box-shadow 0.2s; }
				.markdown-body a.media-image-full:hover, .media-image-full:hover { border: 0 !important; border-bottom: 0 !important; }
				.media-image-full:hover img { transform: scale(1.01); box-shadow: 0 0 28px rgba(99, 102, 241, 0.22); }
				.media-audio { padding: 8px 0; align-items: center; }
				.media-audio-card { position: relative; width: min(520px, 100%); }
				.media-audio-card.media-has-download { padding-bottom: 42px; }
				.media-audio audio { width: 100%; max-width: 500px; border-radius: 8px; }
				.media-video { align-items: flex-start; flex-direction: column; max-width: min(520px, 100%); }
				.media-video-agent { max-width: 100%; }
				.media-video-frame { width: 100%; justify-content: center; aspect-ratio: 16 / 9; }
				.video-thumbnail { position: relative; width: 100%; max-width: 100%; aspect-ratio: 16 / 9; border-radius: 14px; border: 1px solid #27272a; background: #09090b; display: block; cursor: pointer; overflow: hidden; }
				.video-thumbnail img { display: block; width: 100%; height: 100%; max-width: 100%; object-fit: contain; pointer-events: none; background: #000; }
				.video-thumbnail-scrim { position: absolute; inset: 0; background: linear-gradient(180deg,rgba(0,0,0,.04),rgba(0,0,0,.46)); pointer-events: none; }
				.video-thumbnail-play { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 58px; height: 58px; border-radius: 50%; background: rgba(99,102,241,.9); display: flex; align-items: center; justify-content: center; color: white; font-size: 24px; box-shadow: 0 10px 30px rgba(99,102,241,.35); padding-left: 4px; pointer-events: none; }
				.video-thumbnail-label { position: absolute; left: 14px; bottom: 12px; color: #f4f4f5; font-size: .8rem; text-shadow: 0 1px 8px rgba(0,0,0,.75); pointer-events: none; }
				.media-video-player { display: block; width: 100%; height: auto; max-width: 100%; max-height: min(82vh, calc(100vh - 210px)); object-fit: contain; border-radius: 12px; border: 1px solid #27272a; background: #000; }
				.media-video-frame.is-horizontal-video { width: 100%; height: auto; }
				.media-video-frame.is-horizontal-video .video-thumbnail, .media-video-frame.is-horizontal-video .media-video-player { width: 100%; height: auto; aspect-ratio: inherit; }
				.media-video-frame.is-vertical-video { width: auto; height: min(82vh, calc(100vh - 210px)); max-width: 100%; aspect-ratio: inherit; }
				.media-video-frame.is-vertical-video .video-thumbnail, .media-video-frame.is-vertical-video .media-video-player { width: auto; height: 100%; max-width: 100%; aspect-ratio: inherit; }
				.media-download { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 10px; border-radius: 999px; border: 1px solid rgba(99,102,241,.38); background: rgba(99,102,241,.12); color: #c4b5fd !important; font-size: 0.74rem; font-weight: 800; line-height: 1; text-decoration: none !important; white-space: nowrap; transition: all .16s ease; }
				.media-download:hover { border-color: rgba(129,140,248,.72); background: rgba(99,102,241,.2); color: #eef2ff !important; transform: translateY(-1px); }
				.markdown-body a.media-download-corner, .media-download-corner { position: absolute; right: 12px; bottom: 12px; z-index: 4; width: 42px; height: 42px; padding: 0; border: 0 !important; border-bottom: 0 !important; border-radius: 999px; background: rgba(39,39,42,.52); color: rgba(244,244,245,.9) !important; box-shadow: 0 10px 24px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.08); backdrop-filter: blur(16px) saturate(1.25); -webkit-backdrop-filter: blur(16px) saturate(1.25); text-decoration: none !important; overflow: visible; outline: none !important; }
				.media-download-corner svg { width: 21px; height: 21px; stroke-width: 2.35; filter: drop-shadow(0 1px 1px rgba(0,0,0,.34)); }
				.markdown-body a.media-download-corner:hover, .media-download-corner:hover { background: rgba(63,63,70,.88); border: 0 !important; border-bottom: 0 !important; color: #fff !important; transform: scale(1.04); box-shadow: 0 14px 32px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.12); }
				.media-download-corner:focus, .media-download-corner:focus-visible, .media-download-corner:active { border: 0 !important; border-bottom: 0 !important; outline: none !important; box-shadow: 0 14px 32px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.12); }
				.media-download-corner::after { content: attr(aria-label); position: absolute; right: 0; bottom: calc(100% + 10px); padding: 7px 10px; border-radius: 10px; background: rgba(9,9,11,.96); color: #f4f4f5; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 32px rgba(0,0,0,.45); font-size: .75rem; font-weight: 800; line-height: 1; white-space: nowrap; opacity: 0; transform: translateY(4px) scale(.96); pointer-events: none; transition: opacity .14s ease, transform .14s ease; }
				.media-download-corner:hover::after, .media-download-corner:focus-visible::after { opacity: 1; transform: translateY(0) scale(1); }
				.media-file { justify-content: stretch; }
				.media-file-card { position: relative; display: flex; align-items: center; gap: 12px; width: min(460px, 100%); padding: 12px; border: 1px solid rgba(63,63,70,.86); border-radius: 16px; background: linear-gradient(135deg, rgba(24,24,27,.92), rgba(39,39,42,.68)); box-shadow: 0 10px 28px rgba(0,0,0,.2); }
				.media-file-card.media-has-download { padding-right: 128px; }
				.media-file-icon { width: 38px; height: 38px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(99,102,241,.18); color: #c4b5fd; font-size: 1.1rem; font-weight: 900; }
				.media-file-meta { min-width: 0; flex: 1; }
				.media-file-title { color: #f4f4f5; font-size: 0.86rem; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.media-file-name { margin-top: 3px; color: #a1a1aa; font-size: 0.72rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
				.media-preview-overlay { position: fixed; inset: 0; z-index: 10000; display: flex; width: 100vw; height: 100dvh; max-width: none; max-height: none; align-items: center; justify-content: center; box-sizing: border-box; margin: 0; border: 0; padding: 24px; background: rgba(0,0,0,.94); cursor: zoom-out; opacity: 1; }
				.media-preview-overlay::backdrop { background: transparent; }
				.media-preview-content { position: relative; max-width: min(94vw, 1440px); max-height: 92dvh; }
				.media-preview-frame { display: flex; align-items: center; justify-content: center; max-width: min(94vw, 1440px); max-height: 92dvh; border-radius: 14px; background: #050505; box-shadow: 0 18px 70px rgba(0,0,0,0.9); overflow: hidden; cursor: default; }
				.media-preview-overlay img { display: block; width: auto; height: auto; max-width: min(94vw, 1440px); max-height: 92dvh; object-fit: contain; border-radius: 12px; opacity: 1 !important; background: #050505; filter: none !important; mix-blend-mode: normal !important; }
				.media-preview-close { position: absolute; top: 12px; right: 12px; z-index: 10001; width: 38px; height: 38px; border-radius: 999px; border: 1px solid rgba(255,255,255,.28); background: rgba(24,24,27,.86); color: #f4f4f5; font-size: 22px; line-height: 1; cursor: pointer; box-shadow: 0 10px 28px rgba(0,0,0,.45); backdrop-filter: blur(8px); }
				.media-preview-close:hover { background: rgba(39,39,42,.98); }
				::-webkit-scrollbar { width: 8px; height: 8px; }
				::-webkit-scrollbar-track { background: transparent; }
				::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; border: 2px solid #09090b; }
				::-webkit-scrollbar-thumb:hover { background: #52525b; }
			`}</style>

			{/* Media preview overlay */}
			{mediaPreviewSrc && (
				<MediaPreviewModal
					src={mediaPreviewSrc}
					onClose={() => setMediaPreviewSrc(null)}
				/>
			)}
		</div>
	);
};
