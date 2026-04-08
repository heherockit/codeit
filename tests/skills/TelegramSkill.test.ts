import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/telegram/index.js';
import { sendStatusViaTelegram } from '../../src/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext, makeMockLogger } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

import axios from 'axios';

const telegramCfg = { botToken: 'bot-token-123', chatId: 'chat-456' };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── notify job status ────────────────────────────────────────────────────────

describe('telegram skill – notify job status', () => {
  it('sends the success message when lastError is absent', async () => {
    vi.mocked(axios.post).mockResolvedValue({});

    const ctx = makeContext({ jobName: 'mission' }, { telegram: telegramCfg });
    await registry.resolve('notify job status')(ctx);

    expect(axios.post).toHaveBeenCalledOnce();
    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('https://api.telegram.org/botbot-token-123/sendMessage');
    expect(body).toEqual({ chat_id: 'chat-456', text: "✅ Job 'mission' completed successfully." });
  });

  it('sends the failure message when lastError is present', async () => {
    vi.mocked(axios.post).mockResolvedValue({});

    const ctx = makeContext({ jobName: 'mission', lastError: 'git push failed' }, { telegram: telegramCfg });
    await registry.resolve('notify job status')(ctx);

    expect(axios.post).toHaveBeenCalledOnce();
    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('https://api.telegram.org/botbot-token-123/sendMessage');
    expect(body).toEqual({ chat_id: 'chat-456', text: "❌ Job 'mission' failed: git push failed" });
  });

  it('falls back to "unknown" job name when jobName is absent from state', async () => {
    vi.mocked(axios.post).mockResolvedValue({});

    const ctx = makeContext({}, { telegram: telegramCfg });
    await registry.resolve('notify job status')(ctx);

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, Record<string, string>];
    expect(body.text).toBe("✅ Job 'unknown' completed successfully.");
  });

  it('throws when telegram config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('notify job status')(ctx)).rejects.toThrow(
      'Missing required telegram config',
    );
  });
});

// ─── await telegram command ───────────────────────────────────────────────────

describe('telegram skill – await telegram command', () => {
  it('stores the command and command name in state when a bot command is received', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { ok: true, result: [{ update_id: 1, message: { message_id: 10, text: '/run-mission' } }] },
    });

    const ctx = makeContext({}, { telegram: telegramCfg });
    await registry.resolve('await telegram command')(ctx);

    expect(ctx.state['telegramCommand']).toBe('/run-mission');
    expect(ctx.state['telegramCommandName']).toBe('run-mission');
  });

  it('GETs getUpdates with the configured poll timeout', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { ok: true, result: [] } });

    const ctx = makeContext({}, { telegram: { ...telegramCfg, pollTimeoutSeconds: 60 } });
    await registry.resolve('await telegram command')(ctx);

    const [url, options] = vi.mocked(axios.get).mock.calls[0] as [string, { params: Record<string, unknown> }];
    expect(url).toBe('https://api.telegram.org/botbot-token-123/getUpdates');
    expect(options.params['timeout']).toBe(60);
  });

  it('ignores non-command messages and leaves state unset', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { ok: true, result: [{ update_id: 2, message: { message_id: 11, text: 'hello there' } }] },
    });

    const ctx = makeContext({}, { telegram: telegramCfg });
    await registry.resolve('await telegram command')(ctx);

    expect(ctx.state['telegramCommand']).toBeUndefined();
    expect(ctx.state['telegramCommandName']).toBeUndefined();
  });

  it('throws when telegram config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('await telegram command')(ctx)).rejects.toThrow(
      'Missing required telegram config',
    );
  });
});

// ─── /status command ──────────────────────────────────────────────────────────

describe('sendStatusViaTelegram', () => {
  it('POSTs a success status message with jobName and lastTechnique', async () => {
    vi.mocked(axios.post).mockResolvedValue({});

    const state = { jobName: 'mission', lastTechnique: 'commit and push changes' };
    await sendStatusViaTelegram({ telegram: telegramCfg }, state, makeMockLogger());

    expect(axios.post).toHaveBeenCalledOnce();
    const [url, body] = vi.mocked(axios.post).mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('https://api.telegram.org/botbot-token-123/sendMessage');
    expect(body).toEqual({
      chat_id: 'chat-456',
      text: '📋 Status\nJob: mission\nLast technique: commit and push changes',
    });
  });

  it('appends Last error line when lastError is present', async () => {
    vi.mocked(axios.post).mockResolvedValue({});

    const state = { jobName: 'mission', lastTechnique: 'commit and push changes', lastError: 'git push failed' };
    await sendStatusViaTelegram({ telegram: telegramCfg }, state, makeMockLogger());

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, Record<string, string>];
    expect(body.text).toBe(
      '📋 Status\nJob: mission\nLast technique: commit and push changes\nLast error: git push failed',
    );
  });

  it('defaults jobName and lastTechnique to "none" when state is empty', async () => {
    vi.mocked(axios.post).mockResolvedValue({});

    await sendStatusViaTelegram({ telegram: telegramCfg }, {}, makeMockLogger());

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, Record<string, string>];
    expect(body.text).toBe('📋 Status\nJob: none\nLast technique: none');
  });

  it('logs a warning and does not POST when telegram config is missing', async () => {
    const logger = makeMockLogger();
    await sendStatusViaTelegram({}, { jobName: 'mission' }, logger);

    expect(axios.post).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[interactive] Telegram config missing — cannot send status.',
    );
  });

  it('uses chatIdOverride instead of configured chatId when provided', async () => {
    vi.mocked(axios.post).mockResolvedValue({});

    const state = { jobName: 'mission', lastTechnique: 'step one' };
    await sendStatusViaTelegram({ telegram: telegramCfg }, state, makeMockLogger(), 99999);

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, Record<string, unknown>];
    expect(body['chat_id']).toBe(99999);
  });

  it('logs a warning and does not POST when no chatId is available', async () => {
    const logger = makeMockLogger();
    await sendStatusViaTelegram({ telegram: { botToken: 'tok', chatId: '' } }, {}, logger);

    expect(axios.post).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[interactive] No chatId available — cannot send status.',
    );
  });
});

