import pino from "pino";
import type { Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";

const rootLogger = pino({
  level: process.env.OCTOPUS_LOG_LEVEL ?? "info",
  ...(isDev && {
    transport: {
      target: "pino/file",
      options: { destination: 1 },
    },
    formatters: {
      level(label) {
        return { level: label.toUpperCase() };
      },
    },
  }),
});

export type { Logger };

export function createLogger(name: string): Logger {
  return rootLogger.child({ module: name });
}

export default rootLogger;
