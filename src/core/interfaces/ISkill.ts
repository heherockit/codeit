import type { ILogger } from './ILogger.js';
import type { AppConfig } from '../types/WorkflowConfig.js';

/**
 * The shared execution context passed to every technique during a job run.
 * Techniques communicate state to downstream techniques by writing to `context.state`.
 */
export interface SkillContext {
  readonly logger: ILogger;
  readonly config: AppConfig;
  /** Shared mutable state bag – techniques read inputs from and write outputs to this. */
  readonly state: Record<string, unknown>;
}

/**
 * A single executable technique function. Receives the shared context and mutates
 * `context.state` as needed to pass data to downstream techniques.
 */
export type SkillFn = (context: SkillContext) => Promise<void>;

/**
 * Curried factory that accepts extracted template parameters and returns the
 * bound executable technique function. Non-parameterised techniques use `() =>`.
 */
export type SkillFnFactory = (params: Record<string, string>) => SkillFn;

/**
 * A map of natural-language technique names to their implementation functions.
 */
export type TechniqueMap = Record<string, SkillFn>;

/**
 * Scoped registrar passed to each skill's `register` callback.
 * Use it to register individual techniques under the parent skill name.
 */
export interface TechniqueRegistry {
  register(techniqueTitle: string, techniqueDescription: string, factory: SkillFnFactory): void;
}

