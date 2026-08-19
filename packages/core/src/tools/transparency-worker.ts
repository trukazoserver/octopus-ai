/**
 * Worker del algoritmo de transparencia: corre computeTransparencyAlpha
 * fuera del event loop del servidor y devuelve el buffer RGBA transfiriéndolo
 * (sin copia). El algoritmo puede tardar varios segundos en imágenes grandes;
 * correrlo en el hilo principal congelaba descargas, WS y cron.
 */
import { parentPort, workerData } from "node:worker_threads";
import {
	type TransparencyInput,
	computeTransparencyAlpha,
} from "./transparency-algorithm.js";

const input = workerData as TransparencyInput;
const result = computeTransparencyAlpha(input);
if (result.kind === "rgba") {
	// rgba siempre se crea con new Uint8Array(n) aquí, así que su buffer es
	// un ArrayBuffer plano y transferible.
	parentPort?.postMessage(result, [result.rgba.buffer as ArrayBuffer]);
} else {
	parentPort?.postMessage(result);
}
