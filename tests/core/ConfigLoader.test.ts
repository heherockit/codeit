import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigLoader } from '../../src/core/ConfigLoader.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codit-test-'));

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'jobs', 'my-job.job'), 'JOB my-job\ndo work\n');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ConfigLoader.loadFromEnv', () => {
  const loader = new ConfigLoader();

  it('returns an empty config when no env vars are set', () => {
    const cfg = loader.loadFromEnv({});
    expect(cfg.logLevel).toBeUndefined();
    expect(cfg.azureDevOps).toBeUndefined();
    expect(cfg.git).toBeUndefined();
    expect(cfg.augment).toBeUndefined();
    expect(cfg.telegram).toBeUndefined();
  });

  it('maps general env vars', () => {
    const cfg = loader.loadFromEnv({ LOG_LEVEL: 'warn', LOG_FILE: 'out.log', DRY_RUN: 'true' });
    expect(cfg.logLevel).toBe('warn');
    expect(cfg.logFile).toBe('out.log');
    expect(cfg.dryRun).toBe(true);
  });

  it('throws when LOG_LEVEL is invalid', () => {
    expect(() => loader.loadFromEnv({ LOG_LEVEL: 'verbose' })).toThrow(
      'LOG_LEVEL must be one of',
    );
  });

  it('maps Azure DevOps section when core vars are present', () => {
    const env = {
      AZURE_DEVOPS_ORGANIZATION: 'MyOrg',
      AZURE_DEVOPS_PROJECT: 'MyProj',
      AZURE_DEVOPS_PAT: 'secret',
      AZURE_DEVOPS_API_VERSION: '7.1',
      AZURE_DEVOPS_IN_PROGRESS_STATE: 'Active',
    };
    const cfg = loader.loadFromEnv(env);
    expect(cfg.azureDevOps?.organization).toBe('MyOrg');
    expect(cfg.azureDevOps?.project).toBe('MyProj');
    expect(cfg.azureDevOps?.personalAccessToken).toBe('secret');
    expect(cfg.azureDevOps?.apiVersion).toBe('7.1');
    expect(cfg.azureDevOps?.inProgressState).toBe('Active');
  });

  it('omits Azure DevOps section when no related vars are set', () => {
    const cfg = loader.loadFromEnv({ LOG_LEVEL: 'info' });
    expect(cfg.azureDevOps).toBeUndefined();
  });

  it('maps Git section', () => {
    const env = { GIT_EXECUTABLE: 'git', GIT_WORKSPACE_PATH: '/repos', GIT_BASE_BRANCH: 'main', GIT_BRANCH_PREFIX: 'feat' };
    const cfg = loader.loadFromEnv(env);
    expect(cfg.git?.gitExecutable).toBe('git');
    expect(cfg.git?.workSpacePath).toBe('/repos');
    expect(cfg.git?.baseBranch).toBe('main');
    expect(cfg.git?.branchPrefix).toBe('feat');
  });

  it('maps Augment section with numeric timeout', () => {
    const env = { AUGMENT_CLI_PATH: 'auggie.cmd', AUGMENT_TIMEOUT_SECONDS: '1800', AUGMENT_MODEL: 'claude-opus-4.6' };
    const cfg = loader.loadFromEnv(env);
    expect(cfg.augment?.cliPath).toBe('auggie.cmd');
    expect(cfg.augment?.timeoutSeconds).toBe(1800);
    expect(cfg.augment?.model).toBe('claude-opus-4.6');
  });

  it('maps Telegram section', () => {
    const env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123', TELEGRAM_POLL_TIMEOUT_SECONDS: '30' };
    const cfg = loader.loadFromEnv(env);
    expect(cfg.telegram?.botToken).toBe('tok');
    expect(cfg.telegram?.chatId).toBe('123');
    expect(cfg.telegram?.pollTimeoutSeconds).toBe(30);
  });
});

describe('ConfigLoader.loadEnvFile', () => {
  const loader = new ConfigLoader();

  it('parses key=value pairs and populates process.env', () => {
    const envFile = path.join(tmpDir, 'test.env');
    fs.writeFileSync(envFile, [
      '# comment',
      '',
      'TEST_KEY_ONE=hello',
      'TEST_KEY_TWO="world"',
      "TEST_KEY_THREE='quoted'",
    ].join('\n'));

    // Clear any pre-existing values
    delete process.env['TEST_KEY_ONE'];
    delete process.env['TEST_KEY_TWO'];
    delete process.env['TEST_KEY_THREE'];

    loader.loadEnvFile(envFile);

    expect(process.env['TEST_KEY_ONE']).toBe('hello');
    expect(process.env['TEST_KEY_TWO']).toBe('world');
    expect(process.env['TEST_KEY_THREE']).toBe('quoted');

    // Clean up
    delete process.env['TEST_KEY_ONE'];
    delete process.env['TEST_KEY_TWO'];
    delete process.env['TEST_KEY_THREE'];
  });

  it('does not override already-set shell variables', () => {
    const envFile = path.join(tmpDir, 'override.env');
    fs.writeFileSync(envFile, 'TEST_EXISTING=from-file\n');
    process.env['TEST_EXISTING'] = 'from-shell';

    loader.loadEnvFile(envFile);

    expect(process.env['TEST_EXISTING']).toBe('from-shell');
    delete process.env['TEST_EXISTING'];
  });
});

describe('ConfigLoader.resolveJobPath', () => {
  const loader = new ConfigLoader();

  it('resolves job path from name', () => {
    const resolved = loader.resolveJobPath('my-job', tmpDir);
    expect(resolved).toContain('my-job.job');
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it('throws when the job file does not exist', () => {
    expect(() => loader.resolveJobPath('nonexistent', tmpDir)).toThrow(
      "Job 'nonexistent' not found",
    );
  });

  it('resolves mission.job from the project jobs directory', () => {
    const projectRoot = process.cwd();
    const resolved = loader.resolveJobPath('mission', projectRoot);
    expect(resolved).toContain('mission.job');
    expect(fs.existsSync(resolved)).toBe(true);
  });
});

