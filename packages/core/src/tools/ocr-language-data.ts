import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import engData from "@tesseract.js-data/eng";
import spaData from "@tesseract.js-data/spa";

const OCR_LANGUAGES = [engData, spaData] as const;

export interface OcrLanguageStatus {
	code: string;
	path: string;
	present: boolean;
	size: number;
}

export function getOfflineTessdataPath(): string {
	const configured = process.env.OCTOPUS_TESSDATA_PATH?.trim();
	const targetDir = configured || join(homedir(), ".octopus", "tessdata");
	mkdirSync(targetDir, { recursive: true });
	for (const language of OCR_LANGUAGES) {
		const source = join(language.langPath, `${language.code}.traineddata.gz`);
		const target = join(targetDir, `${language.code}.traineddata.gz`);
		if (!existsSync(source)) throw new Error(`Bundled OCR model not found: ${source}`);
		const sourceSize = statSync(source).size;
		if (existsSync(target) && statSync(target).size === sourceSize) continue;
		const temporary = `${target}.${process.pid}.tmp`;
		mkdirSync(dirname(temporary), { recursive: true });
		copyFileSync(source, temporary);
		try {
			if (existsSync(target)) rmSync(target, { force: true });
			renameSync(temporary, target);
		} finally {
			if (existsSync(temporary)) rmSync(temporary, { force: true });
		}
	}
	return targetDir;
}

export function getOfflineOcrLanguageStatus(): OcrLanguageStatus[] {
	const targetDir = getOfflineTessdataPath();
	return OCR_LANGUAGES.map((language) => {
		const modelPath = join(targetDir, `${language.code}.traineddata.gz`);
		const present = existsSync(modelPath);
		return {
			code: language.code,
			path: modelPath,
			present,
			size: present ? statSync(modelPath).size : 0,
		};
	});
}
