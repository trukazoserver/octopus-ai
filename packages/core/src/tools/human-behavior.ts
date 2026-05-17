/**
 * HumanBehavior — Simulación de comportamiento humano para evasión de detección.
 *
 * Genera patrones realistas de:
 * - Movimiento del mouse con curvas de Bézier
 * - Velocidad de escritura variable
 * - Pausas naturales (lectura, pensamiento)
 * - Scroll suave con aceleración/desaceleración
 * - Variación de timing entre acciones
 */

/** Generar un número aleatorio con distribución gaussiana (media=0, std=1) */
function gaussianRandom(): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Clamp un valor entre min y max */
function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Generar puntos de una curva de Bézier cúbica */
function bezierCurve(
	p0: [number, number],
	p1: [number, number],
	p2: [number, number],
	p3: [number, number],
	steps: number,
): Array<[number, number]> {
	const points: Array<[number, number]> = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const t2 = t * t;
		const t3 = t2 * t;
		const mt = 1 - t;
		const mt2 = mt * mt;
		const mt3 = mt2 * mt;
		const x =
			mt3 * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t3 * p3[0];
		const y =
			mt3 * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t3 * p3[1];
		points.push([Math.round(x), Math.round(y)]);
	}
	return points;
}

export interface HumanTypingOptions {
	/** Velocidad base en ms entre teclas (default: 80) */
	baseDelayMs?: number;
	/** Variación en ms (default: 40) */
	variationMs?: number;
	/** Probabilidad de pausa larga entre palabras (0-1, default: 0.15) */
	wordPauseProbability?: number;
	/** Duración de pausa entre palabras en ms (default: 200) */
	wordPauseMs?: number;
	/** Probabilidad de cometer un typo y corregirlo (0-1, default: 0.03) */
	typoProbability?: number;
}

export interface HumanMouseOptions {
	/** Número de pasos para el movimiento (default: 20-40 aleatorio) */
	steps?: number;
	/** Delay entre pasos en ms (default: 5-15) */
	stepDelayMs?: number;
	/** Overshoot probability (0-1, default: 0.2) */
	overshootProbability?: number;
}

export interface HumanScrollOptions {
	/** Pixels por paso de scroll (default: 100-300) */
	pixelsPerStep?: number;
	/** Delay entre pasos de scroll (default: 50-150ms) */
	stepDelayMs?: number;
	/** Número de pasos (default: 3-8) */
	steps?: number;
}

export class HumanBehavior {
	private lastMouseX = 0;
	private lastMouseY = 0;

	/**
	 * Genera la secuencia de caracteres para escribir un texto de forma humana.
	 * Retorna un array de { char, delayMs } para que el caller ejecute.
	 */
	generateTypingSequence(
		text: string,
		options: HumanTypingOptions = {},
	): Array<{ char: string; delayMs: number }> {
		const baseDelay = options.baseDelayMs ?? 80;
		const variation = options.variationMs ?? 40;
		const wordPauseProb = options.wordPauseProbability ?? 0.15;
		const wordPauseMs = options.wordPauseMs ?? 200;
		const typoProb = options.typoProbability ?? 0.03;

		const sequence: Array<{ char: string; delayMs: number }> = [];

		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			let delay = baseDelay + gaussianRandom() * variation;

			// Pausa más larga al inicio de palabra
			if (char === " " && Math.random() < wordPauseProb) {
				delay += wordPauseMs + gaussianRandom() * (wordPauseMs * 0.5);
			}

			// Más lento después de puntuación
			if (i > 0 && /[.!?,;:]/.test(text[i - 1])) {
				delay += 150 + Math.random() * 200;
			}

			// Más rápido en secuencias comunes
			if (
				i > 1 &&
				/^(th|he|in|er|an|re|on|at|en|nd|ti|es|or|te|of|ed|is|it|al|ar|st|to|nt|ng|se)$/i.test(
					text.slice(i - 1, i + 1),
				)
			) {
				delay *= 0.7;
			}

			// Simular typo ocasional
			if (Math.random() < typoProb && /[a-zA-Z]/.test(char)) {
				const typoChar = this.nearbyKey(char);
				if (typoChar) {
					sequence.push({
						char: typoChar,
						delayMs: clamp(delay * 0.8, 30, 300),
					});
					sequence.push({
						char: "Backspace",
						delayMs: clamp(100 + Math.random() * 150, 80, 300),
					});
				}
			}

			sequence.push({ char, delayMs: clamp(delay, 30, 500) });
		}

		return sequence;
	}

	/**
	 * Genera los puntos de movimiento del mouse con curva de Bézier.
	 */
	generateMousePath(
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		options: HumanMouseOptions = {},
	): Array<{ x: number; y: number; delayMs: number }> {
		const distance = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2);
		const steps =
			options.steps ?? Math.max(15, Math.min(50, Math.round(distance / 15)));
		const stepDelay = options.stepDelayMs ?? 5 + Math.random() * 10;
		const overshootProb = options.overshootProbability ?? 0.2;

		// Puntos de control para la curva de Bézier (con variación humana)
		const midX = (fromX + toX) / 2;
		const midY = (fromY + toY) / 2;
		const spread = distance * 0.3;

		const cp1: [number, number] = [
			midX + gaussianRandom() * spread * 0.5,
			midY + gaussianRandom() * spread * 0.5,
		];
		const cp2: [number, number] = [
			midX + gaussianRandom() * spread * 0.3,
			midY + gaussianRandom() * spread * 0.3,
		];

		let targetX = toX;
		let targetY = toY;

		// Overshoot ocasional
		const willOvershoot = Math.random() < overshootProb && distance > 100;
		if (willOvershoot) {
			const overshootDist = 5 + Math.random() * 15;
			const angle = Math.atan2(toY - fromY, toX - fromX);
			targetX = toX + Math.cos(angle) * overshootDist;
			targetY = toY + Math.sin(angle) * overshootDist;
		}

		const mainPath = bezierCurve(
			[fromX, fromY],
			cp1,
			cp2,
			[targetX, targetY],
			steps,
		);

		const result: Array<{ x: number; y: number; delayMs: number }> = [];

		for (let i = 0; i < mainPath.length; i++) {
			// Easing: más lento al inicio y final, más rápido en el medio
			const t = i / mainPath.length;
			const easedDelay = stepDelay * (1 + 0.5 * Math.sin(Math.PI * t));

			result.push({
				x: mainPath[i][0],
				y: mainPath[i][1],
				delayMs: clamp(easedDelay + gaussianRandom() * 3, 2, 30),
			});
		}

		// Corrección del overshoot
		if (willOvershoot) {
			const correctionSteps = 5 + Math.floor(Math.random() * 5);
			const correctionPath = bezierCurve(
				[targetX, targetY],
				[targetX - (targetX - toX) * 0.5, targetY - (targetY - toY) * 0.5],
				[toX + gaussianRandom() * 2, toY + gaussianRandom() * 2],
				[toX, toY],
				correctionSteps,
			);
			for (const point of correctionPath) {
				result.push({
					x: point[0],
					y: point[1],
					delayMs: clamp(stepDelay * 1.5 + gaussianRandom() * 5, 3, 25),
				});
			}
		}

		this.lastMouseX = toX;
		this.lastMouseY = toY;

		return result;
	}

	/**
	 * Genera un patrón de scroll suave.
	 */
	generateScrollSequence(
		direction: "down" | "up",
		totalPixels: number,
		options: HumanScrollOptions = {},
	): Array<{ deltaY: number; delayMs: number }> {
		const steps = options.steps ?? 3 + Math.floor(Math.random() * 6);
		const baseDelay = options.stepDelayMs ?? 50 + Math.random() * 100;
		const sign = direction === "down" ? 1 : -1;

		const sequence: Array<{ deltaY: number; delayMs: number }> = [];
		let remaining = totalPixels;

		for (let i = 0; i < steps && remaining > 0; i++) {
			// Aceleración/desaceleración: más grande en el medio
			const t = i / (steps - 1);
			const factor = Math.sin(Math.PI * t) * 0.7 + 0.3;
			const pixels = Math.min(
				remaining,
				Math.round(
					(totalPixels / steps) * factor * (1 + gaussianRandom() * 0.2),
				),
			);

			sequence.push({
				deltaY: sign * Math.max(20, pixels),
				delayMs: clamp(baseDelay + gaussianRandom() * 30, 20, 300),
			});

			remaining -= pixels;
		}

		// Si queda algo, agregarlo al último
		if (remaining > 0 && sequence.length > 0) {
			sequence[sequence.length - 1].deltaY += sign * remaining;
		}

		return sequence;
	}

	/**
	 * Genera un delay de "lectura" basado en la cantidad de contenido visible.
	 */
	generateReadingDelay(contentLength: number): number {
		// ~200 palabras por minuto, ~5 chars per word
		const estimatedWords = contentLength / 5;
		const readingTimeMs = (estimatedWords / 200) * 60_000;

		// Limitar entre 500ms y 5s, con variación
		return clamp(readingTimeMs * (0.3 + Math.random() * 0.4), 500, 5000);
	}

	/**
	 * Genera un delay de "pensamiento" antes de una acción.
	 */
	generateThinkingDelay(): number {
		return clamp(300 + gaussianRandom() * 200, 100, 1500);
	}

	/**
	 * Obtener una tecla cercana en el teclado (para simular typos realistas).
	 */
	private nearbyKey(char: string): string | null {
		const neighbors: Record<string, string[]> = {
			a: ["s", "q", "z", "w"],
			b: ["v", "n", "g", "h"],
			c: ["x", "v", "d", "f"],
			d: ["s", "f", "e", "r", "c", "x"],
			e: ["w", "r", "d", "s"],
			f: ["d", "g", "r", "t", "v", "c"],
			g: ["f", "h", "t", "y", "b", "v"],
			h: ["g", "j", "y", "u", "n", "b"],
			i: ["u", "o", "k", "j"],
			j: ["h", "k", "u", "i", "m", "n"],
			k: ["j", "l", "i", "o"],
			l: ["k", "o", "p"],
			m: ["n", "j", "k"],
			n: ["b", "m", "h", "j"],
			o: ["i", "p", "l", "k"],
			p: ["o", "l"],
			q: ["w", "a"],
			r: ["e", "t", "f", "d"],
			s: ["a", "d", "w", "e", "x", "z"],
			t: ["r", "y", "g", "f"],
			u: ["y", "i", "j", "h"],
			v: ["c", "b", "f", "g"],
			w: ["q", "e", "a", "s"],
			x: ["z", "c", "s", "d"],
			y: ["t", "u", "h", "g"],
			z: ["a", "x", "s"],
		};

		const lower = char.toLowerCase();
		const nearby = neighbors[lower];
		if (!nearby || nearby.length === 0) return null;
		const picked = nearby[Math.floor(Math.random() * nearby.length)];
		return char === char.toUpperCase() ? picked.toUpperCase() : picked;
	}

	/**
	 * Posición actual del mouse (para encadenar movimientos).
	 */
	get mousePosition(): { x: number; y: number } {
		return { x: this.lastMouseX, y: this.lastMouseY };
	}
}
