/**
 * Algoritmo de recuperación de transparencia (flood-fill desde bordes,
 * chroma-key opcional y feathering de bordes).
 *
 * Es CPU-bound puro (varios pases completos por píxel) y NO toca IO ni
 * sharp, así que puede correr en un worker thread sin bloquear el event
 * loop del servidor (ver transparency-worker.ts). Mantener sin imports.
 */

export interface TransparencyChromaKey {
	r: number;
	g: number;
	b: number;
}

export interface TransparencyInput {
	/** Píxeles crudos RGB o RGBA tal como los produce sharp().raw(). */
	data: Uint8Array;
	width: number;
	height: number;
	channels: number;
	chromaKey?: TransparencyChromaKey;
}

export type TransparencyResult =
	| { kind: "none"; reason: "too-small" | "no-background" | "coverage" }
	| { kind: "rgba"; rgba: Uint8Array };

export function computeTransparencyAlpha(
	input: TransparencyInput,
): TransparencyResult {
	const { data, width, height, channels, chromaKey } = input;
	if (width < 3 || height < 3 || channels < 3) {
		return { kind: "none", reason: "too-small" };
	}

	type ColorBucket = {
		count: number;
		r: number;
		g: number;
		b: number;
	};
	const buckets = new Map<number, ColorBucket>();
	let borderSamples = 0;
	const sample = (x: number, y: number) => {
		const offset = (y * width + x) * channels;
		const r = data[offset] ?? 0;
		const g = data[offset + 1] ?? 0;
		const b = data[offset + 2] ?? 0;
		const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
		const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
		bucket.count++;
		bucket.r += r;
		bucket.g += g;
		bucket.b += b;
		buckets.set(key, bucket);
		borderSamples++;
	};
	for (let x = 0; x < width; x++) {
		sample(x, 0);
		sample(x, height - 1);
	}
	for (let y = 1; y < height - 1; y++) {
		sample(0, y);
		sample(width - 1, y);
	}

	const dominant = [...buckets.values()]
		.filter((bucket) => bucket.count / borderSamples >= 0.02)
		.sort((a, b) => b.count - a.count)
		.slice(0, 6);
	if (dominant.length === 0 || dominant[0].count / borderSamples < 0.08) {
		return { kind: "none", reason: "no-background" };
	}
	const learnedColors = dominant.map((bucket) => ({
		count: bucket.count,
		r: bucket.r / bucket.count,
		g: bucket.g / bucket.count,
		b: bucket.b / bucket.count,
	}));
	const chromaColors = chromaKey
		? learnedColors.filter(
				(color) =>
					Math.max(
						Math.abs(color.r - chromaKey.r),
						Math.abs(color.g - chromaKey.g),
						Math.abs(color.b - chromaKey.b),
					) <= 96 &&
					Math.max(color.r, color.g, color.b) -
						Math.min(color.r, color.g, color.b) >=
						80,
			)
		: [];
	const chromaCoverage =
		chromaColors.reduce((sum, color) => sum + color.count, 0) / borderSamples;
	const chromaConfirmed = chromaColors.length > 0 && chromaCoverage >= 0.35;
	const colors = chromaConfirmed ? chromaColors : learnedColors;
	const tolerance = 30;
	const nearestBackground = (pixelIndex: number) => {
		const offset = pixelIndex * channels;
		const r = data[offset] ?? 0;
		const g = data[offset + 1] ?? 0;
		const b = data[offset + 2] ?? 0;
		let nearest = colors[0];
		let distance = Number.POSITIVE_INFINITY;
		for (const color of colors) {
			const candidate = Math.max(
				Math.abs(r - color.r),
				Math.abs(g - color.g),
				Math.abs(b - color.b),
			);
			if (candidate < distance) {
				distance = candidate;
				nearest = color;
			}
		}
		return { color: nearest, distance };
	};
	const matchesBackground = (pixelIndex: number): boolean => {
		return nearestBackground(pixelIndex).distance <= tolerance;
	};

	const pixelCount = width * height;
	const backgroundMask = new Uint8Array(pixelCount);
	const queue = new Int32Array(pixelCount);
	let head = 0;
	let tail = 0;
	const enqueue = (pixelIndex: number) => {
		if (backgroundMask[pixelIndex] || !matchesBackground(pixelIndex)) return;
		backgroundMask[pixelIndex] = 1;
		queue[tail++] = pixelIndex;
	};
	for (let x = 0; x < width; x++) {
		enqueue(x);
		enqueue((height - 1) * width + x);
	}
	for (let y = 1; y < height - 1; y++) {
		enqueue(y * width);
		enqueue(y * width + width - 1);
	}
	while (head < tail) {
		const pixelIndex = queue[head++];
		const x = pixelIndex % width;
		if (x > 0) enqueue(pixelIndex - 1);
		if (x + 1 < width) enqueue(pixelIndex + 1);
		if (pixelIndex >= width) enqueue(pixelIndex - width);
		if (pixelIndex + width < pixelCount) enqueue(pixelIndex + width);
	}

	let backgroundPixels = tail;
	if (chromaConfirmed) {
		const visited = new Uint8Array(pixelCount);
		for (let start = 0; start < pixelCount; start++) {
			if (
				backgroundMask[start] ||
				visited[start] ||
				!matchesBackground(start)
			) {
				continue;
			}
			head = 0;
			tail = 0;
			visited[start] = 1;
			queue[tail++] = start;
			while (head < tail) {
				const pixelIndex = queue[head++];
				const x = pixelIndex % width;
				const visit = (neighbor: number) => {
					if (
						visited[neighbor] ||
						backgroundMask[neighbor] ||
						!matchesBackground(neighbor)
					) {
						return;
					}
					visited[neighbor] = 1;
					queue[tail++] = neighbor;
				};
				if (x > 0) visit(pixelIndex - 1);
				if (x + 1 < width) visit(pixelIndex + 1);
				if (pixelIndex >= width) visit(pixelIndex - width);
				if (pixelIndex + width < pixelCount) visit(pixelIndex + width);
			}
			for (let index = 0; index < tail; index++) {
				backgroundMask[queue[index]] = 1;
			}
			backgroundPixels += tail;
		}
	}

	const foregroundPixels = pixelCount - backgroundPixels;
	if (
		backgroundPixels < pixelCount * 0.02 ||
		foregroundPixels < pixelCount * 0.005
	) {
		return { kind: "none", reason: "coverage" };
	}

	const matteRadius = 3;
	const edgeDistance = new Uint8Array(pixelCount);
	head = 0;
	tail = 0;
	const addEdgePixel = (pixelIndex: number, distance: number) => {
		if (backgroundMask[pixelIndex] || edgeDistance[pixelIndex]) return;
		edgeDistance[pixelIndex] = distance;
		queue[tail++] = pixelIndex;
	};
	for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
		if (!backgroundMask[pixelIndex]) continue;
		const x = pixelIndex % width;
		if (x > 0) addEdgePixel(pixelIndex - 1, 1);
		if (x + 1 < width) addEdgePixel(pixelIndex + 1, 1);
		if (pixelIndex >= width) addEdgePixel(pixelIndex - width, 1);
		if (pixelIndex + width < pixelCount)
			addEdgePixel(pixelIndex + width, 1);
	}
	while (head < tail) {
		const pixelIndex = queue[head++];
		const distance = edgeDistance[pixelIndex] ?? 0;
		if (distance >= matteRadius) continue;
		const x = pixelIndex % width;
		if (x > 0) addEdgePixel(pixelIndex - 1, distance + 1);
		if (x + 1 < width) addEdgePixel(pixelIndex + 1, distance + 1);
		if (pixelIndex >= width) addEdgePixel(pixelIndex - width, distance + 1);
		if (pixelIndex + width < pixelCount)
			addEdgePixel(pixelIndex + width, distance + 1);
	}

	const rgba = new Uint8Array(pixelCount * 4);
	for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
		const sourceOffset = pixelIndex * channels;
		const targetOffset = pixelIndex * 4;
		const red = data[sourceOffset] ?? 0;
		const green = data[sourceOffset + 1] ?? 0;
		const blue = data[sourceOffset + 2] ?? 0;
		let alpha = backgroundMask[pixelIndex] ? 0 : 1;
		let outputRed = red;
		let outputGreen = green;
		let outputBlue = blue;
		const chromaSpill =
			chromaConfirmed &&
			chromaKey &&
			Math.max(
				Math.abs(red - chromaKey.r),
				Math.abs(green - chromaKey.g),
				Math.abs(blue - chromaKey.b),
			) <= 150;
		const distance = (edgeDistance[pixelIndex] ?? 0) || (chromaSpill ? 1 : 0);
		if (alpha && distance) {
			const { color } = nearestBackground(pixelIndex);
			const colorDifference = Math.max(
				Math.abs(red - color.r),
				Math.abs(green - color.g),
				Math.abs(blue - color.b),
			);
			const availableRange = Math.max(
				color.r,
				255 - color.r,
				color.g,
				255 - color.g,
				color.b,
				255 - color.b,
				1,
			);
			const estimatedAlpha = Math.max(
				0,
				Math.min(1, (colorDifference - 2) / availableRange),
			);
			const layerFloor = ((distance - 1) / matteRadius) * 0.85;
			alpha = Math.max(estimatedAlpha, layerFloor);
			if (alpha < 0.02) {
				alpha = 0;
			} else {
				outputRed = color.r + (red - color.r) / alpha;
				outputGreen = color.g + (green - color.g) / alpha;
				outputBlue = color.b + (blue - color.b) / alpha;
			}
		}
		rgba[targetOffset] = Math.max(0, Math.min(255, Math.round(outputRed)));
		rgba[targetOffset + 1] = Math.max(
			0,
			Math.min(255, Math.round(outputGreen)),
		);
		rgba[targetOffset + 2] = Math.max(0, Math.min(255, Math.round(outputBlue)));
		rgba[targetOffset + 3] = Math.round(alpha * 255);
	}
	return { kind: "rgba", rgba };
}
