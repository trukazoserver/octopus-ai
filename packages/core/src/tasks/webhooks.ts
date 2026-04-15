import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";

export class WebhookServer {
  private fastify: FastifyInstance;
  private port: number;
  private authSecret: string;

  constructor(port: number, authSecret: string) {
    this.port = port;
    this.authSecret = authSecret;
    this.fastify = Fastify({ logger: false });
  }

  private async setup(): Promise<void> {
    await this.fastify.register(cors, {
      origin: true,
    });

    this.fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${this.authSecret}`) {
        reply.status(401).send({ error: "Unauthorized" });
      }
    });
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

  registerHook(path: string, handler: (payload: any) => Promise<any>): void {
    this.fastify.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await handler(request.body);
        reply.send({ success: true, result });
      } catch (error: any) {
        reply.status(500).send({ success: false, error: error.message });
      }
    });
  }
}
