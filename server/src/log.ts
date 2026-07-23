import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const logDir = resolve(process.cwd(), "logs");
const serverLogPath = resolve(logDir, "server.log");
const errorLogPath = resolve(logDir, "error.log");

function formatMeta(meta?: Record<string, unknown>) {
  if (!meta) return "";
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return "";
  }
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${formatMeta(meta)}`;
  writeFiles(level, line);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function writeFiles(level: LogLevel, line: string) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(serverLogPath, `${line}\n`, "utf8");
    if (level === "warn" || level === "error") {
      appendFileSync(errorLogPath, `${line}\n`, "utf8");
    }
  } catch {
    // Logging must never crash the bot.
  }
}

export const log = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta)
};
