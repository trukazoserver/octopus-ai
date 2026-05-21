const ASSISTANT_DENIAL_PHRASES = [
	"no lo recuerdo",
	"no recuerdo",
	"no tengo registro",
	"no tengo información",
	"no existe ningún registro",
	"no tengo acceso a conversaciones anteriores",
	"each conversation starts fresh",
] as const;

export function isAssistantMemoryDenialEcho(content: string): boolean {
	const normalized = content.toLowerCase();
	if (!normalized.includes("assistant replied")) return false;
	return ASSISTANT_DENIAL_PHRASES.some((phrase) => normalized.includes(phrase));
}
