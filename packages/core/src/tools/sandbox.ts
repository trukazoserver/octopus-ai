import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export class DockerSandbox {
  private image: string;
  private memoryLimit: string;
  private timeout: number;

  constructor(config: {
    image?: string;
    memoryLimit?: string;
    timeout?: number;
  }) {
    this.image = config.image ?? "node:20-slim";
    this.memoryLimit = config.memoryLimit ?? "512m";
    this.timeout = config.timeout ?? 30000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync("docker --version", { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    command: string,
    options?: {
      mounts?: Array<{ host: string; container: string }>;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const available = await this.isAvailable();

    if (!available) {
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: this.timeout,
          maxBuffer: 1024 * 1024 * 10,
        });
        return {
          stdout,
          stderr:
            "[WARNING] Docker not available, falling back to local execution\n" +
            stderr,
          exitCode: 0,
        };
      } catch (err) {
        const error = err as Error & {
          stdout?: string;
          stderr?: string;
          code?: number;
        };
        return {
          stdout: error.stdout ?? "",
          stderr:
            "[WARNING] Docker not available, falling back to local execution\n" +
            (error.stderr ?? "") +
            "\n" +
            error.message,
          exitCode: error.code ?? 1,
        };
      }
    }

    const mountArgs = (options?.mounts ?? [])
      .map((m) => `-v "${m.host}:${m.container}"`)
      .join(" ");

    const dockerCommand = `docker run --rm --memory="${this.memoryLimit}" --network=none ${mountArgs} "${this.image}" sh -c ${JSON.stringify(command)}`;

    try {
      const { stdout, stderr } = await execAsync(dockerCommand, {
        timeout: this.timeout,
        maxBuffer: 1024 * 1024 * 10,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const error = err as Error & {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        exitCode: error.code ?? 1,
      };
    }
  }
}
