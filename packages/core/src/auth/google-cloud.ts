export interface GoogleBillingAccount {
	name: string;
	displayName?: string;
	open?: boolean;
}

export interface VertexProjectSetupOptions {
	accessToken: string;
	projectId?: string;
	projectName?: string;
	billingAccountName?: string;
	enableServices?: string[];
	/** Create a service account + JSON key for Vertex auth (default: true). */
	createServiceAccountKey?: boolean;
	/** Service account ID (default: "octopus"). */
	serviceAccountId?: string;
}

export interface VertexProjectSetupResult {
	projectId: string;
	projectNumber?: string;
	createdProject: boolean;
	billingAccounts: GoogleBillingAccount[];
	linkedBillingAccount?: string;
	enabledServices: string[];
	iamRolesGranted: string[];
	principalEmail?: string;
	serviceAccountEmail?: string;
	/** Raw service-account JSON key (UTF-8). Only present right after creation. */
	serviceAccountKey?: string;
	warnings: string[];
}

interface GoogleProject {
	projectId?: string;
	projectNumber?: string;
	name?: string;
}

interface GoogleOperation {
	name?: string;
	done?: boolean;
	error?: { message?: string };
	response?: unknown;
}

const DEFAULT_VERTEX_SERVICES = [
	"serviceusage.googleapis.com",
	"cloudresourcemanager.googleapis.com",
	"cloudbilling.googleapis.com",
	"iam.googleapis.com",
	"aiplatform.googleapis.com",
];

const PROJECT_IAM_ROLES = [
	"roles/aiplatform.admin",
	"roles/serviceusage.serviceUsageAdmin",
	"roles/resourcemanager.projectIamAdmin",
];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBillingAccountName(name?: string): string | undefined {
	const trimmed = name?.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("billingAccounts/")
		? trimmed
		: `billingAccounts/${trimmed}`;
}

function generateProjectId(): string {
	const suffix = Math.random().toString(36).slice(2, 8);
	const time = Date.now().toString(36).slice(-6);
	return `octopus-ai-${time}-${suffix}`.slice(0, 30);
}

async function googleJson<T>(
	url: string,
	accessToken: string,
	init: RequestInit = {},
): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (init.body) headers.set("Content-Type", "application/json");

	const response = await fetch(url, {
		...init,
		headers,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => response.statusText);
		throw new Error(`Google API ${response.status}: ${text}`);
	}

	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const profile = await googleJson<{ email?: string }>(
			"https://openidconnect.googleapis.com/v1/userinfo",
			accessToken,
		);
		return profile.email;
	} catch {
		return undefined;
	}
}

async function waitForOperation(
	operation: GoogleOperation,
	accessToken: string,
	warnings: string[],
): Promise<void> {
	if (!operation.name) return;
	const operationUrl = operation.name.startsWith("http")
		? operation.name
		: `https://cloudresourcemanager.googleapis.com/v1/${operation.name}`;

	for (let attempt = 0; attempt < 30; attempt++) {
		const current = await googleJson<GoogleOperation>(
			operationUrl,
			accessToken,
		);
		if (current.error) {
			throw new Error(current.error.message ?? "Google operation failed");
		}
		if (current.done) return;
		await sleep(2000);
	}
	warnings.push(
		"La creacion del proyecto sigue en progreso; Google Cloud puede tardar unos minutos en propagarlo.",
	);
}

async function getProject(
	projectId: string,
	accessToken: string,
): Promise<GoogleProject> {
	return googleJson<GoogleProject>(
		`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`,
		accessToken,
	);
}

async function createProject(
	projectId: string,
	projectName: string,
	accessToken: string,
	warnings: string[],
): Promise<GoogleProject> {
	const operation = await googleJson<GoogleOperation>(
		"https://cloudresourcemanager.googleapis.com/v1/projects",
		accessToken,
		{
			method: "POST",
			body: JSON.stringify({ projectId, name: projectName }),
		},
	);
	await waitForOperation(operation, accessToken, warnings);
	await sleep(2500);
	return getProject(projectId, accessToken);
}

async function listBillingAccounts(
	accessToken: string,
): Promise<GoogleBillingAccount[]> {
	const response = await googleJson<{
		billingAccounts?: GoogleBillingAccount[];
	}>(
		"https://cloudbilling.googleapis.com/v1/billingAccounts?filter=open=true",
		accessToken,
	);
	return response.billingAccounts ?? [];
}

async function linkBillingAccount(
	projectId: string,
	billingAccountName: string,
	accessToken: string,
): Promise<void> {
	await googleJson(
		`https://cloudbilling.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/billingInfo`,
		accessToken,
		{
			method: "PUT",
			body: JSON.stringify({ billingAccountName }),
		},
	);
}

async function enableService(
	projectRef: string,
	service: string,
	accessToken: string,
): Promise<void> {
	await googleJson(
		`https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectRef)}/services/${encodeURIComponent(service)}:enable`,
		accessToken,
		{ method: "POST", body: JSON.stringify({}) },
	);
}

async function grantProjectRoles(
	projectId: string,
	principalEmail: string,
	accessToken: string,
): Promise<string[]> {
	const resource = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`;
	const policy = await googleJson<{
		bindings?: Array<{ role: string; members?: string[] }>;
		etag?: string;
	}>(`${resource}:getIamPolicy`, accessToken, {
		method: "POST",
		body: JSON.stringify({}),
	});

	const bindings = policy.bindings ?? [];
	const member = `user:${principalEmail}`;
	const granted: string[] = [];

	for (const role of PROJECT_IAM_ROLES) {
		let binding = bindings.find((item) => item.role === role);
		if (!binding) {
			binding = { role, members: [] };
			bindings.push(binding);
		}
		binding.members ??= [];
		if (!binding.members.includes(member)) {
			binding.members.push(member);
			granted.push(role);
		}
	}

	if (granted.length === 0) return [];

	await googleJson(`${resource}:setIamPolicy`, accessToken, {
		method: "POST",
		body: JSON.stringify({ policy: { bindings, etag: policy.etag } }),
	});
	return granted;
}

const VERTEX_SERVICE_ACCOUNT_ROLES = ["roles/aiplatform.user"];

/**
 * Grant IAM roles on the project to an arbitrary member (e.g. a service
 * account). Returns the roles actually added (empty if already present).
 */
async function grantMemberIamRoles(
	projectId: string,
	member: string,
	roles: string[],
	accessToken: string,
): Promise<string[]> {
	const resource = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`;
	const policy = await googleJson<{
		bindings?: Array<{ role: string; members?: string[] }>;
		etag?: string;
	}>(`${resource}:getIamPolicy`, accessToken, {
		method: "POST",
		body: JSON.stringify({}),
	});

	const bindings = policy.bindings ?? [];
	const granted: string[] = [];
	for (const role of roles) {
		let binding = bindings.find((item) => item.role === role);
		if (!binding) {
			binding = { role, members: [] };
			bindings.push(binding);
		}
		binding.members ??= [];
		if (!binding.members.includes(member)) {
			binding.members.push(member);
			granted.push(role);
		}
	}
	if (granted.length === 0) return [];
	await googleJson(`${resource}:setIamPolicy`, accessToken, {
		method: "POST",
		body: JSON.stringify({ policy: { bindings, etag: policy.etag } }),
	});
	return granted;
}

/** Create a service account; returns its email (idempotent on 409/exists). */
async function createServiceAccount(
	projectId: string,
	accountId: string,
	displayName: string,
	accessToken: string,
	warnings: string[],
): Promise<string> {
	const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
	try {
		await googleJson(
			`https://iam.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					accountId,
					serviceAccount: { displayName },
				}),
			},
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!/409|already exists|alreadyexists/i.test(msg)) {
			warnings.push(`No se pudo crear la service account '${accountId}': ${msg}`);
		}
	}
	return email;
}

/** Create a JSON key for a service account; returns the raw key file JSON. */
async function createServiceAccountKey(
	projectId: string,
	saEmail: string,
	accessToken: string,
): Promise<string> {
	const result = await googleJson<{ privateKeyData?: string }>(
		`https://iam.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts/${encodeURIComponent(saEmail)}/keys`,
		accessToken,
		{ method: "POST", body: JSON.stringify({}) },
	);
	if (!result.privateKeyData) {
		throw new Error("Google no devolvió privateKeyData para la clave.");
	}
	return Buffer.from(result.privateKeyData, "base64").toString("utf8");
}

/**
 * Create a Vertex service account + grant aiplatform.user + create a JSON key.
 * Returns { email, keyJson }, or null if the key could not be created.
 */
async function createVertexServiceAccount(
	projectId: string,
	accountId: string,
	displayName: string,
	accessToken: string,
	warnings: string[],
): Promise<{ email: string; keyJson: string } | null> {
	const email = await createServiceAccount(
		projectId,
		accountId,
		displayName,
		accessToken,
		warnings,
	);
	try {
		await grantMemberIamRoles(
			projectId,
			`serviceAccount:${email}`,
			VERTEX_SERVICE_ACCOUNT_ROLES,
			accessToken,
		);
	} catch (err) {
		warnings.push(
			`No se pudo asignar rol a la service account: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		const keyJson = await createServiceAccountKey(
			projectId,
			email,
			accessToken,
		);
		return { email, keyJson };
	} catch (err) {
		warnings.push(
			`No se pudo crear la clave JSON de la service account: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

export async function prepareVertexProject(
	options: VertexProjectSetupOptions,
): Promise<VertexProjectSetupResult> {
	const accessToken = options.accessToken.trim();
	if (!accessToken) throw new Error("Google OAuth access token is required");

	const warnings: string[] = [];
	const projectId = options.projectId?.trim() || generateProjectId();
	const projectName = options.projectName?.trim() || "Octopus AI Vertex";
	let createdProject = false;
	let project: GoogleProject;

	if (options.projectId?.trim()) {
		project = await getProject(projectId, accessToken);
	} else {
		project = await createProject(
			projectId,
			projectName,
			accessToken,
			warnings,
		);
		createdProject = true;
	}

	const billingAccounts = await listBillingAccounts(accessToken).catch(
		(err) => {
			warnings.push(
				`No se pudieron listar cuentas de facturacion: ${err instanceof Error ? err.message : String(err)}`,
			);
			return [];
		},
	);

	const requestedBilling = normalizeBillingAccountName(
		options.billingAccountName,
	);
	const selectedBilling =
		requestedBilling ?? billingAccounts.find((account) => account.open)?.name;
	let linkedBillingAccount: string | undefined;
	if (selectedBilling) {
		try {
			await linkBillingAccount(projectId, selectedBilling, accessToken);
			linkedBillingAccount = selectedBilling;
		} catch (err) {
			warnings.push(
				`No se pudo vincular facturacion (${selectedBilling}): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else {
		warnings.push(
			"No hay cuentas de facturacion abiertas disponibles para vincular automaticamente.",
		);
	}

	const projectRef = project.projectNumber ?? project.projectId ?? projectId;
	const services = options.enableServices?.length
		? options.enableServices
		: DEFAULT_VERTEX_SERVICES;
	const enabledServices: string[] = [];
	for (const service of services) {
		try {
			await enableService(projectRef, service, accessToken);
			enabledServices.push(service);
		} catch (err) {
			warnings.push(
				`No se pudo activar ${service}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const principalEmail = await getUserEmail(accessToken);
	let iamRolesGranted: string[] = [];
	if (principalEmail) {
		try {
			iamRolesGranted = await grantProjectRoles(
				projectId,
				principalEmail,
				accessToken,
			);
		} catch (err) {
			warnings.push(
				`No se pudieron ajustar permisos IAM del proyecto: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else {
		warnings.push(
			"No se pudo detectar el email de la cuenta Google para ajustar IAM automaticamente.",
		);
	}

	// Create a service account + JSON key so Vertex can authenticate with a
	// stable, self-contained credential (no dependency on the user's OAuth
	// token refresh). The key JSON is only returned at creation time.
	let serviceAccountEmail: string | undefined;
	let serviceAccountKey: string | undefined;
	if (options.createServiceAccountKey !== false) {
		const sa = await createVertexServiceAccount(
			projectId,
			options.serviceAccountId?.trim() || "octopus",
			"Octopus Service Account",
			accessToken,
			warnings,
		).catch((err) => {
			warnings.push(
				`No se pudo provisionar la service account de Vertex: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		});
		if (sa) {
			serviceAccountEmail = sa.email;
			serviceAccountKey = sa.keyJson;
		}
	}

	return {
		projectId,
		projectNumber: project.projectNumber,
		createdProject,
		billingAccounts,
		linkedBillingAccount,
		enabledServices,
		iamRolesGranted,
		principalEmail,
		serviceAccountEmail,
		serviceAccountKey,
		warnings,
	};
}
