import axios from 'axios';
import type { SkillContext } from '../../core/interfaces/ISkill.js';
import type { SkillRegistry } from '../../core/SkillRegistry.js';
import type { TelegramConfig } from '../../core/types/WorkflowConfig.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function requireTelegramConfig(ctx: SkillContext): TelegramConfig {
  const cfg = ctx.config.telegram;
  if (!cfg?.botToken || !cfg?.chatId) {
    throw new Error('Missing required telegram config (botToken, chatId).');
  }
  return cfg;
}

function apiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

async function sendMessage(botToken: string, chatId: string, text: string): Promise<void> {
  await axios.post(apiUrl(botToken, 'sendMessage'), { chat_id: chatId, text });
}

// ─── Action implementations ───────────────────────────────────────────────────

async function notifyJobStatus(ctx: SkillContext): Promise<void> {
  const cfg = requireTelegramConfig(ctx);
  const jobName = (ctx.state['jobName'] as string | undefined) ?? 'unknown';
  const lastError = ctx.state['lastError'] as string | undefined;

  const text = lastError
    ? `❌ Job '${jobName}' failed: ${lastError}`
    : `✅ Job '${jobName}' completed successfully.`;

  await sendMessage(cfg.botToken, cfg.chatId, text);
  ctx.logger.info(`Telegram notification sent: job '${jobName}' ${lastError ? 'failed' : 'completed'}.`);
}

async function awaitTelegramCommand(ctx: SkillContext): Promise<void> {
  const cfg = requireTelegramConfig(ctx);
  const timeout = cfg.pollTimeoutSeconds ?? 30;

  const res = await axios.get<GetUpdatesResponse>(
    apiUrl(cfg.botToken, 'getUpdates'),
    { params: { timeout, allowed_updates: ['message'] } },
  );

  for (const update of res.data.result) {
    const text = update.message?.text?.trim();
    if (!text) continue;

    if (!text.startsWith('/')) {
      ctx.logger.info(`[telegram] Ignoring non-command message: "${text}"`);
      continue;
    }

    ctx.state['telegramCommand'] = text;
    ctx.state['telegramCommandName'] = text.slice(1);
    ctx.logger.info(`[telegram] Received command: ${text}`);
    return;
  }

  ctx.logger.info('[telegram] No command received during poll window.');
}

// ─── Skill registration ───────────────────────────────────────────────────────

export function register(registry: SkillRegistry): void {
  registry.skill('telegram', (r) => {
    r.register('notify job status', 'Sends a Telegram success or failure message based on ctx.state[\'lastError\'].', () => notifyJobStatus);
    r.register('await telegram command', 'Polls the Telegram Bot API for an incoming command and stores it in state.', () => awaitTelegramCommand);
  });
}

// ─── Private API shape types ──────────────────────────────────────────────────

interface TelegramMessage { message_id: number; text?: string; }
interface TelegramUpdate { update_id: number; message?: TelegramMessage; }
interface GetUpdatesResponse { ok: boolean; result: TelegramUpdate[]; }

