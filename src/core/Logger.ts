import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ILogger } from './interfaces/ILogger.js';
import type { LogLevel } from './types/index.js';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Journal logger that writes structured, timestamped lines to both the console and a log file.
 * File logging is optional; when logFilePath is omitted only the console receives output.
 * The log file is appended to across runs so the full history is preserved.
 */
export class JournalLogger implements ILogger {
  readonly level: LogLevel;
  private readonly logFilePath: string | undefined;

  constructor(level: LogLevel = 'info', logFilePath?: string) {
    this.level = level;
    this.logFilePath = logFilePath;

    if (logFilePath) {
      mkdirSync(path.dirname(logFilePath), { recursive: true });
    }
  }

  debug(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.write('error', message, meta);
  }

  private write(
    level: LogLevel,
    message: string,
    meta?: Readonly<Record<string, unknown>>,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;

    const timestamp = new Date().toISOString();
    const metaStr = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;

    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }

    if (this.logFilePath) {
      try {
        appendFileSync(this.logFilePath, line + '\n');
      } catch {
        // Swallow file-write errors to avoid crashing the agent
      }
    }
  }
}

/** @deprecated Use {@link JournalLogger} instead. */
export const ConsoleLogger = JournalLogger;

