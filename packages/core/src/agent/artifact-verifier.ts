import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseAdapter } from "../storage/database.js";

export interface ArtifactVerificationResult {
	artifactId: string;
	exists: boolean;
	verifiedAt: string;
	error: string | null;
}

interface ArtifactRecord {
	id: string;
	url: string | null;
	path: string | null;
	artifact_type: string;
	artifact_key?: string | null;
	exists_verified: number;
}

const MEDIA_DIR = join(homedir(), ".octopus", "media");

export class ArtifactVerifier {
	constructor(
		private db: DatabaseAdapter,
		private mediaDir: string = MEDIA_DIR,
	) {}

	async verifyArtifact(
		artifactId: string,
	): Promise<ArtifactVerificationResult> {
		const artifact = await this.db.get<ArtifactRecord>(
			"SELECT id, url, path, artifact_type, artifact_key, exists_verified FROM agent_workflow_artifacts WHERE id = ?",
			[artifactId],
		);
		if (!artifact) {
			return {
				artifactId,
				exists: false,
				verifiedAt: new Date().toISOString(),
				error: "Artifact record not found in database",
			};
		}

		const { exists, error, sizeBytes } = this.checkExistence(artifact);
		const now = new Date().toISOString();

		await this.db.run(
			"UPDATE agent_workflow_artifacts SET exists_verified = ?, verified_at = ?, verification_error = ?, size_bytes = COALESCE(?, size_bytes) WHERE id = ?",
			[exists ? 1 : 0, now, error ?? null, sizeBytes ?? null, artifactId],
		);

		return { artifactId, exists, verifiedAt: now, error: error ?? null };
	}

	async verifyRunArtifacts(
		runId: string,
	): Promise<ArtifactVerificationResult[]> {
		const artifacts = await this.db.all<{ id: string }>(
			"SELECT id FROM agent_workflow_artifacts WHERE run_id = ? AND artifact_type != 'evidence_ledger_snapshot'",
			[runId],
		);
		const results: ArtifactVerificationResult[] = [];
		for (const a of artifacts) {
			results.push(await this.verifyArtifact(a.id));
		}
		return results;
	}

	async verifyTaskArtifacts(
		taskId: string,
	): Promise<ArtifactVerificationResult[]> {
		const artifacts = await this.db.all<{ id: string }>(
			"SELECT id FROM agent_workflow_artifacts WHERE task_id = ?",
			[taskId],
		);
		const results: ArtifactVerificationResult[] = [];
		for (const a of artifacts) {
			results.push(await this.verifyArtifact(a.id));
		}
		return results;
	}

	async verifyArtifactsByKey(input: {
		runId: string;
		artifactKey?: string | null;
		artifactType?: string | null;
	}): Promise<ArtifactVerificationResult[]> {
		const where = ["run_id = ?"];
		const params: unknown[] = [input.runId];
		if (input.artifactKey) {
			where.push("artifact_key = ?");
			params.push(input.artifactKey);
		}
		if (input.artifactType) {
			where.push("artifact_type = ?");
			params.push(input.artifactType);
		}
		const artifacts = await this.db.all<{ id: string }>(
			`SELECT id FROM agent_workflow_artifacts WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
			params,
		);
		const results: ArtifactVerificationResult[] = [];
		for (const artifact of artifacts) {
			results.push(await this.verifyArtifact(artifact.id));
		}
		return results;
	}

	private checkExistence(artifact: ArtifactRecord): {
		exists: boolean;
		error?: string;
		sizeBytes?: number;
	} {
		if (artifact.path) {
			if (existsSync(artifact.path)) {
				const stat = statSync(artifact.path);
				if (stat.size > 0) return { exists: true, sizeBytes: stat.size };
				return {
					exists: false,
					error: `File exists but is empty: ${artifact.path}`,
				};
			}
			return {
				exists: false,
				error: `File not found at path: ${artifact.path}`,
			};
		}

		if (artifact.url) {
			const filename = this.extractFilenameFromUrl(artifact.url);
			if (filename) {
				const filePath = join(this.mediaDir, filename);
				if (existsSync(filePath)) {
					const stat = statSync(filePath);
					if (stat.size > 0) return { exists: true, sizeBytes: stat.size };
					return {
						exists: false,
						error: `Media file exists but is empty: ${filename}`,
					};
				}
			}
			return {
				exists: false,
				error: `Media file not found for URL: ${artifact.url}`,
			};
		}

		return { exists: false, error: "Artifact has no url or path" };
	}

	private extractFilenameFromUrl(url: string): string | null {
		const match = url.match(/\/api\/media\/file\/([^/?#]+)$/);
		if (match) return match[1];
		const lastSegment = url.split("/").pop();
		return lastSegment?.includes(".") ? lastSegment : null;
	}
}
