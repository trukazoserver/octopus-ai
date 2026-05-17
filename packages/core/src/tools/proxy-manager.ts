/**
 * ProxyManager — Gestión inteligente de proxies para navegación stealth.
 *
 * Funcionalidades:
 * - Auto-selección del mejor proxy según el dominio target
 * - Rotación automática cuando se detecta bloqueo
 * - Health checking de proxies
 * - Geo-matching: usar proxy del país del sitio target
 * - Pool de proxies con estadísticas de rendimiento
 */

export interface ProxyConfig {
	type: "http" | "https" | "socks5" | "residential" | "datacenter";
	host: string;
	port: number;
	username?: string;
	password?: string;
	country?: string;
	provider?: "brightdata" | "decodo" | "smartproxy" | "oxylabs" | "custom";
	/** Rotación automática de IP (para proxies residenciales) */
	autoRotate?: boolean;
}

interface ProxyStats {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	blockedRequests: number;
	avgResponseTimeMs: number;
	lastUsed: number;
	lastBlocked?: number;
	consecutiveFailures: number;
}

interface ProxyEntry {
	config: ProxyConfig;
	stats: ProxyStats;
	enabled: boolean;
}

/** Patterns que indican que un proxy fue bloqueado */
const BLOCK_PATTERNS = [
	/captcha/i,
	/blocked/i,
	/access denied/i,
	/forbidden/i,
	/rate limit/i,
	/too many requests/i,
	/cloudflare/i,
	/datadome/i,
	/pardon our interruption/i,
	/unusual traffic/i,
	/verify.*human/i,
	/challenge-platform/i,
];

/** Mapeo de dominios a países para geo-matching */
const DOMAIN_COUNTRY_MAP: Record<string, string> = {
	"etsy.com": "US",
	"amazon.com": "US",
	"amazon.co.uk": "GB",
	"amazon.de": "DE",
	"amazon.es": "ES",
	"amazon.fr": "FR",
	"ebay.com": "US",
	"ebay.co.uk": "GB",
	"aliexpress.com": "US",
	"mercadolibre.com": "MX",
	"linkedin.com": "US",
	"indeed.com": "US",
};

export class ProxyManager {
	private proxies: Map<string, ProxyEntry> = new Map();
	private currentProxy: string | null = null;
	private proxyIdCounter = 0;

	constructor(proxies?: ProxyConfig[]) {
		if (proxies) {
			for (const config of proxies) {
				this.addProxy(config);
			}
		}
	}

	/**
	 * Agregar un proxy al pool.
	 */
	addProxy(config: ProxyConfig): string {
		const id = `proxy_${++this.proxyIdCounter}`;
		this.proxies.set(id, {
			config,
			stats: {
				totalRequests: 0,
				successfulRequests: 0,
				failedRequests: 0,
				blockedRequests: 0,
				avgResponseTimeMs: 0,
				lastUsed: 0,
				consecutiveFailures: 0,
			},
			enabled: true,
		});
		return id;
	}

	/**
	 * Auto-seleccionar el mejor proxy para un dominio target.
	 */
	async selectProxy(targetDomain: string): Promise<ProxyConfig | null> {
		if (this.proxies.size === 0) return null;

		const country = this.getCountryForDomain(targetDomain);
		const candidates = this.getEnabledProxies();

		if (candidates.length === 0) {
			// Rehabilitar proxies si todos están deshabilitados
			this.rehabilitateProxies();
			return this.getBestProxy(this.getEnabledProxies(), country);
		}

		return this.getBestProxy(candidates, country);
	}

	/**
	 * Seleccionar el mejor proxy de una lista de candidatos.
	 */
	private getBestProxy(
		candidates: Array<[string, ProxyEntry]>,
		preferredCountry?: string,
	): ProxyConfig | null {
		if (candidates.length === 0) return null;

		// Priorizar por: 1) país correcto, 2) menor tasa de fallos, 3) menos uso reciente
		const scored = candidates.map(([id, entry]) => {
			let score = 0;

			// Bonus por geo-match
			if (preferredCountry && entry.config.country === preferredCountry) {
				score += 100;
			}

			// Bonus por tipo residencial (más difícil de detectar)
			if (entry.config.type === "residential") score += 50;

			// Penalización por fallos consecutivos
			score -= entry.stats.consecutiveFailures * 30;

			// Penalización por tasa de bloqueo
			const blockRate =
				entry.stats.totalRequests > 0
					? entry.stats.blockedRequests / entry.stats.totalRequests
					: 0;
			score -= blockRate * 100;

			// Bonus por menor uso reciente (balanceo de carga)
			const timeSinceUse = Date.now() - entry.stats.lastUsed;
			score += Math.min(50, timeSinceUse / 60_000); // +1 por cada minuto sin usar, max 50

			return { id, entry, score };
		});

		scored.sort((a, b) => b.score - a.score);
		const best = scored[0];
		this.currentProxy = best.id;
		return best.entry.config;
	}

	/**
	 * Reportar el resultado de un request con el proxy actual.
	 */
	reportResult(
		success: boolean,
		responseTimeMs: number,
		responseContent?: string,
	): void {
		if (!this.currentProxy) return;
		const entry = this.proxies.get(this.currentProxy);
		if (!entry) return;

		entry.stats.totalRequests++;
		entry.stats.lastUsed = Date.now();

		if (success) {
			entry.stats.successfulRequests++;
			entry.stats.consecutiveFailures = 0;

			// Verificar si fue bloqueado a pesar de "success" HTTP
			if (responseContent && this.isBlocked(responseContent)) {
				entry.stats.blockedRequests++;
				entry.stats.consecutiveFailures++;
			}
		} else {
			entry.stats.failedRequests++;
			entry.stats.consecutiveFailures++;
		}

		// Actualizar promedio de response time
		const n = entry.stats.totalRequests;
		entry.stats.avgResponseTimeMs =
			((n - 1) * entry.stats.avgResponseTimeMs + responseTimeMs) / n;

		// Deshabilitar proxy con demasiados fallos consecutivos
		if (entry.stats.consecutiveFailures >= 5) {
			entry.enabled = false;
			entry.stats.lastBlocked = Date.now();
		}
	}

	/**
	 * Rotar proxy cuando se detecta bloqueo.
	 */
	async rotateOnBlock(targetDomain: string): Promise<ProxyConfig | null> {
		if (this.currentProxy) {
			const entry = this.proxies.get(this.currentProxy);
			if (entry) {
				entry.stats.blockedRequests++;
				entry.stats.consecutiveFailures++;
				entry.stats.lastBlocked = Date.now();

				// Deshabilitar temporalmente
				if (entry.stats.consecutiveFailures >= 3) {
					entry.enabled = false;
				}
			}
		}

		// Seleccionar un proxy diferente
		return this.selectProxy(targetDomain);
	}

	/**
	 * Detectar si una respuesta indica bloqueo.
	 */
	isBlocked(content: string): boolean {
		return BLOCK_PATTERNS.some((pattern) => pattern.test(content));
	}

	/**
	 * Obtener el país recomendado para un dominio.
	 */
	private getCountryForDomain(domain: string): string | undefined {
		const normalized = domain.replace(/^www\./, "").toLowerCase();
		return DOMAIN_COUNTRY_MAP[normalized];
	}

	/**
	 * Obtener proxies habilitados.
	 */
	private getEnabledProxies(): Array<[string, ProxyEntry]> {
		return Array.from(this.proxies.entries()).filter(
			([, entry]) => entry.enabled,
		);
	}

	/**
	 * Rehabilitar proxies que llevan tiempo deshabilitados.
	 */
	private rehabilitateProxies(): void {
		const cooldownMs = 5 * 60_000; // 5 minutos
		const now = Date.now();

		for (const [, entry] of this.proxies) {
			if (!entry.enabled && entry.stats.lastBlocked) {
				if (now - entry.stats.lastBlocked > cooldownMs) {
					entry.enabled = true;
					entry.stats.consecutiveFailures = 0;
				}
			}
		}
	}

	/**
	 * Health check de todos los proxies.
	 */
	getHealthReport(): Array<{
		id: string;
		host: string;
		type: string;
		country?: string;
		enabled: boolean;
		successRate: number;
		blockRate: number;
		avgResponseMs: number;
		totalRequests: number;
	}> {
		return Array.from(this.proxies.entries()).map(([id, entry]) => ({
			id,
			host: entry.config.host,
			type: entry.config.type,
			country: entry.config.country,
			enabled: entry.enabled,
			successRate:
				entry.stats.totalRequests > 0
					? entry.stats.successfulRequests / entry.stats.totalRequests
					: 1,
			blockRate:
				entry.stats.totalRequests > 0
					? entry.stats.blockedRequests / entry.stats.totalRequests
					: 0,
			avgResponseMs: entry.stats.avgResponseTimeMs,
			totalRequests: entry.stats.totalRequests,
		}));
	}

	/**
	 * Generar la URL del proxy actual para Puppeteer/Playwright.
	 */
	toProxyUrl(config: ProxyConfig): string {
		const protocol = config.type === "socks5" ? "socks5" : "http";
		const auth = config.username
			? `${config.username}:${config.password || ""}@`
			: "";
		return `${protocol}://${auth}${config.host}:${config.port}`;
	}

	/**
	 * Número de proxies disponibles.
	 */
	get availableCount(): number {
		return this.getEnabledProxies().length;
	}

	/**
	 * Total de proxies en el pool.
	 */
	get totalCount(): number {
		return this.proxies.size;
	}
}
