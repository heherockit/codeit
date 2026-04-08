import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillContext } from '../../core/interfaces/ISkill.js';
import type { SkillRegistry } from '../../core/SkillRegistry.js';
import type { WorkItem, AffectedRepository } from '../../core/types/index.js';

const execFileAsync = promisify(execFile);

// ─── CLI helpers ──────────────────────────────────────────────────────────────

function cliExe(ctx: SkillContext): string {
  return ctx.config.augment?.cliPath ?? 'augment';
}

function timeoutMs(ctx: SkillContext): number {
  return (ctx.config.augment?.timeoutSeconds ?? 300) * 1000;
}

function cliModel(ctx: SkillContext): string | undefined {
  return ctx.config.augment?.model;
}

function logCliOutput(ctx: SkillContext, stdout: string): void {
  for (const line of stdout.split('\n')) {
    if (line.trim()) ctx.logger.info(`[augment] ${line}`);
  }
}

type ExecError = Error & { stdout?: string; stderr?: string };

/**
 * Writes the prompt to a temporary file, invokes the Augment CLI with
 * --instruction-file and --workspace-root, then removes the temp file.
 *
 * If the CLI exits non-zero but produced stdout, the output is returned
 * with a warning rather than throwing, because auggie sometimes exits 1
 * even on success. Stderr is always forwarded to the journal.
 */
async function runAuggie(
  cli: string,
  prompt: string,
  workSpacePath: string,
  timeout: number,
  ctx: SkillContext,
): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `codit-prompt-${Date.now()}.txt`);

  try {
    await fs.writeFile(tmpFile, prompt, 'utf-8');

    const model = cliModel(ctx);
    const modelArgs = model ? ['--model', model] : [];

    const { stdout } = await execFileAsync(
      cli,
      ['--instruction-file', tmpFile, '--workspace-root', workSpacePath, '--print', ...modelArgs],
      { timeout, shell: true, maxBuffer: 10 * 1024 * 1024 },
    );

    return stdout;
  } catch (err) {
    const execErr = err as ExecError;

    if (execErr.stderr?.trim()) {
      for (const line of execErr.stderr.split('\n')) {
        if (line.trim()) ctx.logger.warn(`[augment stderr] ${line}`);
      }
    }

    if (execErr.stdout?.trim()) {
      ctx.logger.warn('[augment] CLI exited with non-zero code but produced output — using stdout.');
      return execErr.stdout;
    }

    const detail = execErr.stderr?.trim() || execErr.message;
    throw new Error(`Augment CLI failed: ${detail}`);
  } finally {
    await fs.unlink(tmpFile).catch(() => undefined);
  }
}

async function readCandidateDirectories(workSpacePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(workSpacePath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function buildDiscoveryPrompt(workItem: WorkItem, candidateNames: readonly string[]): string {
  const lines: string[] = [
    'You are analyzing a work item to determine which microservice repository directories need to be modified.',
    '',
    '## Available Repositories',
    ...candidateNames.map((n) => `- ${n}`),
    '',
  ];

  if (workItem.parentId && (workItem.parentTitle ?? workItem.parentDescription)) {
    lines.push(`## Parent Context (#${workItem.parentId}: ${workItem.parentTitle ?? ''})`);
    lines.push(workItem.parentDescription ?? '');
    lines.push('');
  }

  lines.push(
    `## Work Item #${workItem.id}: ${workItem.title}`,
    `Type: ${workItem.type}`,
    '',
    '### Description',
    workItem.description,
    '',
    '### Acceptance Criteria',
    workItem.acceptanceCriteria ?? '',
    '',
    '## Task',
    'Based on the work item above, respond with ONLY the names of the repository directories that need to be modified.',
    'Rules:',
    '- One directory name per line.',
    '- Return ONLY names from the Available Repositories list above — no paths, no explanation, no markdown.',
    '- If multiple repositories need changes, list all of them.',
    '- If you are unsure, pick the most likely candidate.',
  );

  return lines.join('\n');
}

/**
 * Extracts repository names from CLI output, keeping only lines that match
 * a known candidate directory name. This guards against error messages or
 * prose leaking in when the CLI runs without a TTY.
 */
function parseRepoNames(raw: string, candidates: ReadonlySet<string>, ctx: SkillContext): string[] {
  const matched: string[] = [];

  for (const line of raw.split('\n')) {
    const name = line.trim().replace(/^[-*]\s*/, '');
    if (!name) continue;

    if (candidates.has(name)) {
      matched.push(name);
    } else {
      ctx.logger.warn(`[augment] ignoring unrecognised line from CLI output: "${name}"`);
    }
  }

  return matched;
}

// ─── Action implementations ───────────────────────────────────────────────────

async function analyzeRepositories(ctx: SkillContext): Promise<void> {
  const cli = cliExe(ctx);
  const timeout = timeoutMs(ctx);
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];
  const workSpacePath = ctx.config.git?.workSpacePath ?? process.cwd();

  const candidateList = await readCandidateDirectories(workSpacePath);
  const candidateSet = new Set(candidateList);
  const repoNameSet = new Set<string>();

  for (const workItem of workItems) {
    const prompt = buildDiscoveryPrompt(workItem, candidateList);
    const stdout = await runAuggie(cli, prompt, workSpacePath, timeout, ctx);

    logCliOutput(ctx, stdout);

    for (const name of parseRepoNames(stdout, candidateSet, ctx)) {
      repoNameSet.add(name);
    }
  }

  const repos: AffectedRepository[] = [...repoNameSet].map((name) => ({
    name,
    localPath: path.join(workSpacePath, name),
    defaultBranch: 'main',
  }));

  ctx.state['affectedRepositories'] = repos;
  ctx.logger.info(`Identified ${repos.length} affected repository/repositories via Augment.`);
}

function buildImplementationPrompt(workItem: WorkItem, repos: readonly AffectedRepository[]): string {
  const repoNames = repos.map((r) => r.name);
  const serviceNames = repoNames.length > 0 ? repoNames.join(', ') : '(unknown services)';
  const repoList = repoNames.length > 1
    ? '\n' + repoNames.map((n) => `- ${n}`).join('\n')
    : `**${serviceNames}**`;

  const lines: string[] = [
    'You are an expert software developer working inside a microservices platform.',
    '',
    '## Platform Context',
    `You are implementing changes across the following microservice repositories:`,
    repoList,
    '',
    'Each repository is a separate codebase under the current working directory.',
    'When making changes:',
    '- Work only within the listed repositories.',
    '- If you need functionality from another service, use its published API or shared contracts.',
    '- Keep cross-service coupling to a minimum.',
  ];

  if (workItem.parentId && (workItem.parentTitle ?? workItem.parentDescription)) {
    lines.push(
      '',
      `## Parent Context (#${workItem.parentId}: ${workItem.parentTitle ?? ''})`,
      'The work item below belongs to the following higher-level requirement.',
      'Use this context to understand the broader goal of the changes you are asked to make.',
      'Do NOT implement the parent item — implement only the child work item described further below.',
      '',
      workItem.parentDescription ?? '',
    );

    if (workItem.parentComments && workItem.parentComments.length > 0) {
      lines.push('', '### Parent Discussion / Comments');
      for (const comment of workItem.parentComments) {
        lines.push(comment, '');
      }
    }
  }

  lines.push(
    '',
    `## Work Item #${workItem.id}: ${workItem.title}`,
    `Type: ${workItem.type}`,
    '',
    '## Description',
    workItem.description,
    '',
    '## Acceptance Criteria',
    workItem.acceptanceCriteria ?? '',
  );

  if (workItem.comments && workItem.comments.length > 0) {
    lines.push(
      '',
      '## Discussion / Comments',
      'The following comments were left on the work item and may contain',
      'important clarifications, decisions, or additional context:',
      '',
    );
    for (const comment of workItem.comments) {
      lines.push(comment, '');
    }
  }

  lines.push(
    '',
    '## Instructions',
    '- Implement all code changes required to satisfy the acceptance criteria.',
    '- Take the discussion comments into account — they may override or refine the description.',
    '- Write or update unit tests as needed.',
    '- Follow the existing code style and conventions in this service\'s repository.',
    '- Do not commit — only write the changes to disk.',
    '- Summarize what you did at the end.',
  );

  return lines.join('\n');
}

async function implementChanges(ctx: SkillContext): Promise<void> {
  const cli = cliExe(ctx);
  const timeout = timeoutMs(ctx);
  const repos = (ctx.state['affectedRepositories'] ?? []) as AffectedRepository[];
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];
  const workSpacePath = ctx.config.git?.workSpacePath ?? process.cwd();

  for (const workItem of workItems) {
    const prompt = buildImplementationPrompt(workItem, repos);
    const stdout = await runAuggie(cli, prompt, workSpacePath, timeout, ctx);

    logCliOutput(ctx, stdout);
    ctx.logger.info(`Implementation complete for work item '${workItem.id}'.`);
  }
}

// ─── Skill registration ───────────────────────────────────────────────────────

export function register(registry: SkillRegistry): void {
  registry.skill('augment', (r) => {
    r.register('analyze repositories with Augment', 'Uses the Augment CLI to identify which repositories need changes for the current work items.', () => analyzeRepositories);
    r.register('implement changes with Augment', 'Uses the Augment CLI to implement code changes for each work item across affected repositories.', () => implementChanges);
  });
}

