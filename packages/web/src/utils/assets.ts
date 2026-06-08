const viteEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;

export function publicAsset(path: string): string {
	const base = viteEnv?.BASE_URL || "/";
	const normalizedBase = base.endsWith("/") ? base : `${base}/`;
	return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}
