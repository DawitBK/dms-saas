import pino from "pino";
import path from "node:path";
import fs from "node:fs";

const loggerOptions: pino.LoggerOptions = {
  name: "dms-api",
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["req.headers.authorization", "password", "passwordHash", "mfaSecret"],
  // Pino only auto-serializes a key literally named `err` (message/stack are
  // non-enumerable on Error instances, so a plain object spread of one is
  // `{}`). This codebase overwhelmingly logs errors under the key `error`
  // instead (`logger.error({ error }, ...)`), which silently printed `{}` for
  // every real Error thrown that way — turned "unhandled error" log lines
  // into dead ends with no message or stack. Serialize both keys the same
  // way rather than rewriting every call site.
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
};

// In production this process runs as a bare `node dist/src/main.js` in a
// console window (no Docker, no PM2 — see SERVER-INFRASTRUCTURE-AUDIT.md),
// not inside a container where a log driver captures stdout. Without an
// explicit file destination, every production log line only ever existed in
// that window's scrollback and was lost the moment it closed. Mirrors GMS's
// existing logger.ts file-transport pattern (logs/gms.log + error.log).
export const logger =
  process.env.NODE_ENV === "production"
    ? (() => {
        const logDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        // pino-roll rotates from inside the process — this box has no
        // process supervisor (no PM2/Docker/NSSM) to signal a reopen after
        // an external rename, so plain pino/file would just grow forever.
        // 20MB/file, daily, 14 kept.
        return pino(
          loggerOptions,
          pino.transport({
            targets: [
              { target: "pino-roll", level: "info", options: { file: path.join(logDir, "dms"), size: "20m", frequency: "daily", limit: { count: 14 }, mkdir: true } },
              { target: "pino-roll", level: "error", options: { file: path.join(logDir, "error"), size: "20m", frequency: "daily", limit: { count: 14 }, mkdir: true } },
            ],
          }),
        );
      })()
    : pino(loggerOptions);

export function setupLogger() {
  logger.info("logger ready");
  return logger;
}
