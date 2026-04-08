import fs from 'node:fs';
import path from 'node:path';

/** Extracts a human-readable message including HTTP response bodies and URLs from axios errors. */
function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  type AxiosErr = Error & {
    response?: { status?: number; data?: unknown; headers?: unknown };
    config?: { baseURL?: string; url?: string; method?: string };
  };

  const httpErr = err as AxiosErr;
  if (httpErr.config ?? httpErr.response) {
    const url = `${httpErr.config?.baseURL ?? ''}${httpErr.config?.url ?? ''}`;
    const body = httpErr.response?.data !== undefined ? JSON.stringify(httpErr.response.data) : '';
    return `${err.message} [${httpErr.config?.method?.toUpperCase() ?? 'HTTP'} ${url}]${body ? ` — ${body}` : ''}`;
  }

  return err.message;
}
import type { JobDefinition, AppConfig } from './types/index.js';
import type { ILogger } from './interfaces/ILogger.js';
import type { SkillContext } from './interfaces/ISkill.js';
import { SkillRegistry } from './SkillRegistry.js';

/**
 * Parses and executes `.job` files against a populated SkillRegistry.
 *
 * Job file format:
 *   JOB <name>
 *   LOOP              (optional — causes the job to repeat indefinitely)
 *   <action phrase>
 *   <action phrase>
 *   ...
 */
export class WorkflowEngine {
  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly logger: ILogger,
    private readonly config: AppConfig,
  ) {}

  /**
   * Parse a `.job` file into a `JobDefinition`.
   */
  static parseJob(filePath: string): JobDefinition {
    const content = fs.readFileSync(filePath, 'utf-8');
    return WorkflowEngine.parseJobContent(content);
  }

  /**
   * Parse raw job file content into a `JobDefinition`.
   */
  static parseJobContent(content: string): JobDefinition {
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    let name = 'unnamed';
    let loop = false;
    let varNames: string[] = [];
    const techniques: string[] = [];

    for (const line of lines) {
      if (line.toUpperCase().startsWith('JOB ')) {
        name = line.slice(4).trim();
      } else if (line.toUpperCase() === 'LOOP') {
        loop = true;
      } else if (line.toUpperCase().startsWith('VAR ')) {
        varNames = line.slice(4).trim().split(',').map((v) => v.trim()).filter(Boolean);
      } else {
        techniques.push(line);
      }
    }

    return { name, loop, techniques, varNames };
  }

  /**
   * Builds a variable map from a `--var` argument string, validating against the job's `varNames`.
   * Throws a meaningful error when counts don't match or when VAR is declared but no values supplied.
   */
  static buildVars(job: JobDefinition, varArg: string | undefined): Record<string, string> {
    const names = job.varNames ?? [];
    if (names.length === 0) return {};

    if (varArg === undefined) {
      throw new Error(
        `Job '${job.name}' declares VAR [${names.join(', ')}] but no --var argument was supplied.`,
      );
    }

    const values = varArg.split(',');
    if (values.length !== names.length) {
      throw new Error(
        `Job '${job.name}': VAR declares ${names.length} variable(s) but --var supplied ${values.length} value(s).`,
      );
    }

    return Object.fromEntries(names.map((n, i) => [n, values[i]!]));
  }

  /**
   * Execute a parsed job definition end-to-end.
   * If `job.loop` is true, the execution repeats indefinitely.
   */
  async run(
    job: JobDefinition,
    externalState?: Record<string, unknown>,
    vars?: Record<string, string>,
  ): Promise<void> {
    const state: Record<string, unknown> = externalState ?? {};
    const context: SkillContext = { logger: this.logger, config: this.config, state };
    const resolvedVars = vars ?? {};

    if (job.loop) {
      this.logger.info(`Job '${job.name}' running in LOOP mode…`);
      while (true) {
        await this.runTechniques(job, context, resolvedVars);
      }
    }

    this.logger.info(`Starting job: ${job.name}`, { totalTechniques: job.techniques.length });
    await this.runTechniques(job, context, resolvedVars);
    this.logger.info(`Job '${job.name}' completed successfully.`);
  }

  /**
   * Dynamically discover and register all skills found in `skillsDir`.
   * Each subdirectory must export a `register(registry: SkillRegistry)` function.
   */
  static async discover(skillsDir: string, registry: SkillRegistry, logger: ILogger): Promise<void> {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const indexJs = path.join(skillsDir, entry.name, 'index.js');
      const indexTs = path.join(skillsDir, entry.name, 'index.ts');
      const indexPath = fs.existsSync(indexJs) ? indexJs : fs.existsSync(indexTs) ? indexTs : null;
      if (!indexPath) continue;

      const fileUrl = `file:///${indexPath.replace(/\\/g, '/')}`;
      const mod = (await import(fileUrl)) as { register?: unknown };

      if (typeof mod.register === 'function') {
        (mod.register as (r: SkillRegistry) => void)(registry);
        logger.info(`Registered skill: ${entry.name}`);
      }
    }
  }

  private static applyVarSubstitution(title: string, vars: Record<string, string>): string {
    return Object.entries(vars).reduce(
      (t, [name, value]) => t.replaceAll(`{${name}}`, value),
      title,
    );
  }

  private async runTechniques(
    job: JobDefinition,
    context: SkillContext,
    vars: Record<string, string>,
  ): Promise<void> {
    for (let i = 0; i < job.techniques.length; i++) {
      const rawTitle = job.techniques[i]!;
      const techniqueTitle = WorkflowEngine.applyVarSubstitution(rawTitle, vars);
      const label = `[${i + 1}/${job.techniques.length}] ${techniqueTitle}`;

      this.logger.info(`Executing technique ${label}`);
      const fn = this.skillRegistry.resolve(techniqueTitle);

      try {
        await fn(context);
        context.state['lastTechnique'] = techniqueTitle;
        this.logger.info(`Technique ${label} completed.`);
      } catch (err) {
        const message = extractErrorMessage(err);
        this.logger.error(`Technique ${label} failed: ${message}`);
        throw new Error(`Job '${job.name}' aborted at technique '${techniqueTitle}': ${message}`);
      }
    }
  }
}

