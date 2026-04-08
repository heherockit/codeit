#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { ConfigLoader, JournalLogger, SkillRegistry, WorkflowEngine, type AppConfig } from './core/index.js';

const DEFAULT_JOB = 'main';
const DEFAULT_ENV = '.env';

async function buildRegistry(skillsDir: string, logger: JournalLogger): Promise<SkillRegistry> {
  const skillRegistry = new SkillRegistry();
  await WorkflowEngine.discover(skillsDir, skillRegistry, logger);
  return skillRegistry;
}

function printAllSkills(registry: SkillRegistry): void {
  const groups = registry.listBySkill() ?? [];
  process.stdout.write('Skills:\n');
  for (const group of groups) {
    process.stdout.write(`  ${group.skillName}\n`);
    for (const technique of group.techniques) {
      process.stdout.write(`    - ${technique}\n`);
    }
  }
}

function printSkill(registry: SkillRegistry, skillName: string): void {
  const groups = registry.listBySkill(skillName);
  if (!groups) {
    process.stderr.write(`Error: Skill '${skillName}' not found. Use --skills to list all available skills.\n`);
    process.exit(1);
  }
  const group = groups[0]!;
  process.stdout.write(`${group.skillName}:\n`);
  for (const technique of group.techniques) {
    process.stdout.write(`  - ${technique}\n`);
  }
}

// ── Interactive mode ─────────────────────────────────────────────────────────

interface CommandResult { source: 'telegram' | 'stdin'; command: string; chatId?: number; }
interface CommandChannel { push(result: CommandResult): void; next(): Promise<CommandResult>; }
interface TelegramUpdate { update_id: number; message?: { text?: string; chat?: { id?: number }; }; }

function createCommandChannel(): CommandChannel {
  const queue: CommandResult[] = [];
  let waiter: ((r: CommandResult) => void) | null = null;

  return {
    push(result) {
      if (waiter) { const w = waiter; waiter = null; w(result); }
      else queue.push(result);
    },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => { waiter = resolve; });
    },
  };
}

async function telegramPollerLoop(
  channel: CommandChannel,
  botToken: string,
  timeout: number,
  logger: JournalLogger,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
  let offset = 0;

  while (true) {
    try {
      const res = await axios.get<{ ok: boolean; result: TelegramUpdate[] }>(
        url,
        { params: { timeout, offset: offset > 0 ? offset : undefined, allowed_updates: ['message'] } },
      );

      for (const update of res.data.result) {
        offset = update.update_id + 1;
        const text = update.message?.text?.trim();
        const chatId = update.message?.chat?.id;
        if (text?.startsWith('/')) {
          channel.push({ source: 'telegram', command: text, ...(chatId !== undefined ? { chatId } : {}) });
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[telegram poller] ${message} — retrying in 5 s`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

export async function sendStatusViaTelegram(
  appConfig: AppConfig,
  state: Record<string, unknown>,
  logger: JournalLogger,
  chatIdOverride?: number,
): Promise<void> {
  const tgCfg = appConfig.telegram;
  if (!tgCfg?.botToken) {
    logger.warn('[interactive] Telegram config missing — cannot send status.');
    return;
  }

  const chatId = chatIdOverride ?? tgCfg.chatId;
  if (!chatId) {
    logger.warn('[interactive] No chatId available — cannot send status.');
    return;
  }

  const jobName = (state['jobName'] as string | undefined) ?? 'none';
  const lastTechnique = (state['lastTechnique'] as string | undefined) ?? 'none';
  const lastError = state['lastError'] as string | undefined;

  let text = `📋 Status\nJob: ${jobName}\nLast technique: ${lastTechnique}`;
  if (lastError) text += `\nLast error: ${lastError}`;

  const url = `https://api.telegram.org/bot${tgCfg.botToken}/sendMessage`;
  await axios.post(url, { chat_id: chatId, text });
  logger.info('[interactive] Status sent via Telegram.');
}

async function runInteractiveJob(
  jobName: string,
  varArg: string | undefined,
  registry: SkillRegistry,
  appConfig: AppConfig,
  logger: JournalLogger,
  projectRoot: string,
  configLoader: ConfigLoader,
  state: Record<string, unknown>,
): Promise<void> {
  try {
    logger.info(`[interactive] Starting job: ${jobName}`);
    const jobPath = configLoader.resolveJobPath(jobName, projectRoot);
    const job = WorkflowEngine.parseJob(jobPath);

    if (varArg !== undefined && (job.varNames ?? []).length === 0) {
      logger.warn(`Job '${job.name}' has no VAR declaration — ignoring --var.`);
    }

    const vars = WorkflowEngine.buildVars(job, varArg);
    state['jobName'] = jobName;
    const engine = new WorkflowEngine(registry, logger, appConfig);
    await engine.run(job, state, vars);
    logger.info(`[interactive] Job '${jobName}' finished.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state['lastError'] = message;
    logger.error(`[interactive] Job '${jobName}' failed: ${message}`);
  }
}

async function handleInteractiveCommand(
  result: CommandResult,
  registry: SkillRegistry,
  appConfig: AppConfig,
  logger: JournalLogger,
  projectRoot: string,
  configLoader: ConfigLoader,
  state: Record<string, unknown>,
): Promise<void> {
  const { source, command } = result;
  logger.info(`[interactive] Command from ${source}: ${command}`);

  if (command.startsWith('/runj ')) {
    const parts = command.slice(6).trim().split(/\s+/);
    const jobName = parts[0] ?? '';
    const varArg = parts.find((p) => p.startsWith('--var='))?.slice('--var='.length);
    await runInteractiveJob(jobName, varArg, registry, appConfig, logger, projectRoot, configLoader, state);
  } else if (command === '/status') {
    await sendStatusViaTelegram(appConfig, state, logger, result.chatId);
  } else {
    logger.warn(`[interactive] Unrecognised command: '${command}'. Supported: /runj <job>, /status`);
  }
}

async function runInteractiveMode(
  registry: SkillRegistry,
  appConfig: AppConfig,
  logger: JournalLogger,
  projectRoot: string,
  configLoader: ConfigLoader,
): Promise<void> {
  const channel = createCommandChannel();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const cmd = line.trim();
    if (cmd) channel.push({ source: 'stdin', command: cmd });
  });

  const tgCfg = appConfig.telegram;
  if (!tgCfg) {
    logger.warn('[interactive] Telegram config missing — Telegram polling disabled.');
  } else {
    void telegramPollerLoop(channel, tgCfg.botToken, tgCfg.pollTimeoutSeconds ?? 30, logger);
  }

  const sharedState: Record<string, unknown> = {};

  logger.info('[interactive] Ready. Commands: /runj <job> [--var=val1,val2], /status');

  while (true) {
    const cmd = await channel.next();
    try {
      await handleInteractiveCommand(cmd, registry, appConfig, logger, projectRoot, configLoader, sharedState);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[interactive] Command '${cmd.command}' failed: ${message}`);
    }
  }
}

async function main(): Promise<void> {
  // fileURLToPath correctly handles the Windows leading-slash issue on file:/// URLs.
  const projectRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const skillsDir = path.resolve(fileURLToPath(import.meta.url), '..', 'skills');

  const args = process.argv.slice(2);
  const envArg = args.find((a) => a.startsWith('--env='))?.split('=')[1]
    ?? path.join(projectRoot, DEFAULT_ENV);

  const configLoader = new ConfigLoader();
  if (fs.existsSync(envArg)) configLoader.loadEnvFile(envArg);
  const appConfig = configLoader.loadFromEnv();
  const logger = new JournalLogger(appConfig.logLevel ?? 'info', appConfig.logFile);

  // ── Introspection modes (do not run a job) ────────────────────────────────
  if (args.includes('--skills')) {
    const registry = await buildRegistry(skillsDir, logger);
    printAllSkills(registry);
    return;
  }

  const skillArg = args.find((a) => a.startsWith('--skill='))?.split('=')[1];
  if (skillArg !== undefined) {
    const registry = await buildRegistry(skillsDir, logger);
    printSkill(registry, skillArg);
    return;
  }

  // ── Interactive mode ──────────────────────────────────────────────────────
  if (args.includes('--it')) {
    logger.info('Codit Agent — interactive mode');
    const registry = await buildRegistry(skillsDir, logger);
    await runInteractiveMode(registry, appConfig, logger, projectRoot, configLoader);
    return;
  }

  // ── Normal job execution ──────────────────────────────────────────────────
  const jobArg = args.find((a) => a.startsWith('--job='))?.split('=')[1] ?? DEFAULT_JOB;
  logger.info('Codit Agent starting…', { job: jobArg, env: envArg });

  const registry = await buildRegistry(skillsDir, logger);

  const jobPath = configLoader.resolveJobPath(jobArg, projectRoot);
  const job = WorkflowEngine.parseJob(jobPath);

  const varArg = args.find((a) => a.startsWith('--var='))?.slice('--var='.length);
  if (varArg !== undefined && (job.varNames ?? []).length === 0) {
    logger.warn(`Job '${job.name}' has no VAR declaration — ignoring --var.`);
  }

  const vars = WorkflowEngine.buildVars(job, varArg);

  const engine = new WorkflowEngine(registry, logger, appConfig);
  await engine.run(job, undefined, vars);
}

// Only execute when this file is the entry point, not when imported by tests.
const isEntryPoint = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[FATAL] ${message}\n`);
    process.exit(1);
  });
}

