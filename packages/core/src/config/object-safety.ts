const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function assertSafeObjectKey(key: string): void {
	if (UNSAFE_OBJECT_KEYS.has(key)) {
		throw new Error(`Unsafe object key: ${key}`);
	}
}

export function assertSafeObjectTree(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) assertSafeObjectTree(item);
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		assertSafeObjectKey(key);
		assertSafeObjectTree(item);
	}
}
