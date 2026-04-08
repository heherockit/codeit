import type { LogLevel } from '../types/index.js';

/**
 * Minimal structured logger interface.
 * Concrete implementations can target the console, files, or external services.
 */
export interface ILogger {
  readonly level: LogLevel;
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void;
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
}

