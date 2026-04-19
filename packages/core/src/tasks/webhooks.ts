import cors from "@fastify/cors";
import Fastify, {
	type FastifyInstance,
	type FastifyReply,
	type FastifyRequest,
} from "fastify";

/**
 * Shape of webhook payload (generic)
 */
export type WebhookPayload = Record<string, unknown>;

/**
 * Shape of webhook response
 */
export type WebhookResponse =
	| {
			success: true;
			result: unknown;
	  }
	| {
			success: false;
			error: string;
	  };

/**
 * Webhook handler function type
 */
export type WebhookHandler<TPayload = WebhookPayload, TResult = unknown> = (
	payload: TPayload,
) => Promise<TResult>;

/**
 * Configuration for webhook server
 */
export interface WebhookServerConfig {
	port: number;
	authSecret: string;
	enableCors?: boolean;
	corsOrigin?: boolean | string | string[];
}

/**
 * Webhook Server for handling HTTP callbacks
 *
 * Provides secure webhook endpoints with Bearer token authentication.
 *
 * @example
 * ```ts
 * const server = new WebhookServer({ port: 3000, authSecret: "secret" });
 * server.registerHook("/deploy", async (payload) => {
 *   console.log("Deploying:", payload);
 *   return { status: "deployed" };
 * });
 * await server.start();
 * ```
 */
export class WebhookServer {
	private fastify: FastifyInstance;
	private port: number;
	private authSecret: string;
	private enableCors: boolean;
	private corsOrigin: boolean | string | string[];

	constructor(config: WebhookServerConfig) {
		this.port = config.port;
		this.authSecret = config.authSecret;
		this.enableCors = config.enableCors ?? true;
		this.corsOrigin = config.corsOrigin ?? true;
		this.fastify = Fastify({ logger: false });
	}

	private async setup(): Promise<void> {
		if (this.enableCors) {
			await this.fastify.register(cors, {
				origin: this.corsOrigin,
			});
		}

		this.fastify.addHook(
			"onRequest",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const authHeader = request.headers.authorization;
				if (!authHeader || authHeader !== `Bearer ${this.authSecret}`) {
					reply.status(401).send({ error: "Unauthorized" });
				}
			},
		);
	}

	async start(): Promise<void> {
		await this.setup();
		try {
			await this.fastify.listen({ port: this.port, host: "0.0.0.0" });
			console.log(`Webhook server listening on port ${this.port}`);
		} catch (err) {
			this.fastify.log.error(err);
			throw err;
		}
	}

	async stop(): Promise<void> {
		await this.fastify.close();
	}

	/**
	 * Register a webhook handler for a specific path
	 * @param path - URL path for the webhook
	 * @param handler - Async function to handle the webhook payload
	 */
	registerHook<TPayload = WebhookPayload, TResult = unknown>(
		path: string,
		handler: WebhookHandler<TPayload, TResult>,
	): void {
		this.fastify.post(
			path,
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					const result = await handler(request.body as TPayload);
					reply.send({ success: true, result });
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					reply.status(500).send({ success: false, error: message });
				}
			},
		);
	}
}
