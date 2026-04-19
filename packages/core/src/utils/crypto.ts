import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
	timingSafeEqual,
} from "node:crypto";

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_OPTIONS = { N: 16384 } as const;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function hashPassword(password: string): string {
	const salt = randomBytes(SALT_LENGTH);
	const derived = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
	return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, hash: string): boolean {
	const [saltHex, derivedHex] = hash.split(":");
	const salt = Buffer.from(saltHex, "hex");
	const derived = Buffer.from(derivedHex, "hex");
	const candidate = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
	if (candidate.length !== derived.length) return false;
	return timingSafeEqual(candidate, derived);
}

export function encrypt(text: string, key: string): string {
	const keyBytes = deriveKey(key);
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
	const encrypted = Buffer.concat([
		cipher.update(text, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(encrypted: string, key: string): string {
	const keyBytes = deriveKey(key);
	const data = Buffer.from(encrypted, "base64");
	const iv = data.subarray(0, IV_LENGTH);
	const tag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
	const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
	const decipher = createDecipheriv("aes-256-gcm", keyBytes, iv);
	decipher.setAuthTag(tag);
	return decipher.update(ciphertext) + decipher.final("utf8");
}

export function generateEncryptionKey(): string {
	return randomBytes(KEY_LENGTH).toString("hex");
}

function deriveKey(key: string): Buffer {
	if (Buffer.byteLength(key, "hex") === KEY_LENGTH) {
		return Buffer.from(key, "hex");
	}
	return scryptSync(key, "octopus-ai-salt", KEY_LENGTH, SCRYPT_OPTIONS);
}
