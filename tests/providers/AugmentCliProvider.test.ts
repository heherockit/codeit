import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dirent } from 'node:fs';
import { register } from '../../src/skills/augment/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext, makeWorkItem, makeRepository } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({
  promises: { readdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() },
}));

import * as cp from 'node:child_process';
import { promises as fsPromises } from 'node:fs';

const mockExecFile = vi.mocked(cp.execFile);
const mockReaddir = vi.mocked(fsPromises.readdir);
const mockWriteFile = vi.mocked(fsPromises.writeFile);
const mockUnlink = vi.mocked(fsPromises.unlink);

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

const stubExecFileOut = (stdout: string) => {
  mockWriteFile.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as ExecCallback;
    cb(null, { stdout, stderr: '' });
    return {} as ReturnType<typeof cp.execFile>;
  });
};

/** Returns the prompt text that was written to the temp file. */
const capturedPrompt = () => mockWriteFile.mock.calls[0]![1] as string;

const stubReaddir = (names: string[]) =>
  mockReaddir.mockResolvedValue(
    names.map((name) => ({ name, isDirectory: () => true }) as unknown as Dirent),
  );

describe('augment skill – analyze repositories (repo identification)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('populates affectedRepositories from CLI newline-separated output', async () => {
    stubReaddir(['api-service', 'auth-service', 'config-service']);
    stubExecFileOut('api-service\nauth-service\n');

    const ctx = makeContext(
      { workItems: [makeWorkItem()] },
      {
        augment: { cliPath: 'augment' },
        git: { workSpacePath: '/workspace' },
      },
    );

    await registry.resolve('analyze repositories with Augment')(ctx);

    const repos = ctx.state['affectedRepositories'] as Array<{ name: string; localPath: string }>;
    expect(repos).toHaveLength(2);
    expect(repos[0]!.name).toBe('api-service');
    expect(repos[0]!.localPath).toContain('api-service');
    expect(repos[1]!.name).toBe('auth-service');
  });

  it('deduplicates repo names when multiple work items name the same repo', async () => {
    stubReaddir(['shared-lib']);
    stubExecFileOut('shared-lib\n');

    const ctx = makeContext({
      workItems: [makeWorkItem({ id: 'WI-1' }), makeWorkItem({ id: 'WI-2' })],
    });

    await registry.resolve('analyze repositories with Augment')(ctx);

    const repos = ctx.state['affectedRepositories'] as Array<{ name: string }>;
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe('shared-lib');
  });

  it('stores an empty affectedRepositories array when CLI returns blank output', async () => {
    stubReaddir(['some-service']);
    stubExecFileOut('');

    const ctx = makeContext({ workItems: [makeWorkItem()] });
    await registry.resolve('analyze repositories with Augment')(ctx);

    expect(ctx.state['affectedRepositories']).toEqual([]);
  });

  it('passes a prompt containing the work item title and available repos to the CLI', async () => {
    stubReaddir(['api-service', 'auth-service']);
    stubExecFileOut('api-service\n');

    const ctx = makeContext(
      { workItems: [makeWorkItem({ title: 'Add login feature' })] },
      { augment: { cliPath: 'augment' }, git: { workSpacePath: '/workspace' } },
    );

    await registry.resolve('analyze repositories with Augment')(ctx);

    const prompt = capturedPrompt();
    expect(prompt).toContain('Add login feature');
    expect(prompt).toContain('- api-service');
    expect(prompt).toContain('- auth-service');
    expect(prompt).toContain('## Available Repositories');

    const [, args] = mockExecFile.mock.calls[0]! as [string, string[]];
    expect(args).toContain('--instruction-file');
    expect(args).toContain('--workspace-root');
    expect(args).toContain('--print');
  });

  it('uses "augment" as the default CLI executable', async () => {
    stubReaddir([]);
    stubExecFileOut('');

    const ctx = makeContext({ workItems: [makeWorkItem()] });
    await registry.resolve('analyze repositories with Augment')(ctx);

    const [file] = mockExecFile.mock.calls[0]! as [string, ...unknown[]];
    expect(file).toBe('augment');
  });

  it('includes parent context in the prompt when parentId and parentTitle are present', async () => {
    stubReaddir(['auth-service']);
    stubExecFileOut('auth-service\n');

    const ctx = makeContext({
      workItems: [makeWorkItem({ parentId: '42', parentTitle: 'Epic: Auth Overhaul', parentDescription: 'Overhaul authentication' })],
    });

    await registry.resolve('analyze repositories with Augment')(ctx);

    const prompt = capturedPrompt();
    expect(prompt).toContain('## Parent Context (#42: Epic: Auth Overhaul)');
    expect(prompt).toContain('Overhaul authentication');
  });

  it('ignores CLI output lines that are not valid candidate directory names', async () => {
    stubReaddir(['api-service']);
    stubExecFileOut('Interactive mode requires a terminal with raw mode support.\napi-service\n');

    const ctx = makeContext({ workItems: [makeWorkItem()] });
    await registry.resolve('analyze repositories with Augment')(ctx);

    const repos = ctx.state['affectedRepositories'] as Array<{ name: string }>;
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe('api-service');
  });
});

describe('augment skill – implement changes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes an implementation prompt containing the work item and repo list to the CLI', async () => {
    stubExecFileOut('Done.');
    const ctx = makeContext(
      {
        workItems: [makeWorkItem({ title: 'Add login feature', acceptanceCriteria: 'User can log in' })],
        affectedRepositories: [makeRepository({ name: 'auth-service' })],
      },
      { augment: { cliPath: 'augment' }, git: { workSpacePath: '/workspace' } },
    );

    await registry.resolve('implement changes with Augment')(ctx);

    expect(mockExecFile).toHaveBeenCalledOnce();
    const [file, args] = mockExecFile.mock.calls[0]! as [string, string[]];
    expect(file).toBe('augment');
    expect(args).toContain('--instruction-file');
    expect(args).toContain('--workspace-root');
    expect(args).toContain('--print');

    const prompt = capturedPrompt();
    expect(prompt).toContain('Add login feature');
    expect(prompt).toContain('auth-service');
    expect(prompt).toContain('## Acceptance Criteria');
    expect(prompt).toContain('User can log in');
    expect(prompt).toContain('## Instructions');
  });

  it('lists multiple repos and uses newline format when more than one', async () => {
    stubExecFileOut('');
    const ctx = makeContext({
      workItems: [makeWorkItem()],
      affectedRepositories: [
        makeRepository({ name: 'api-service' }),
        makeRepository({ name: 'auth-service' }),
      ],
    });

    await registry.resolve('implement changes with Augment')(ctx);

    const prompt = capturedPrompt();
    expect(prompt).toContain('- api-service');
    expect(prompt).toContain('- auth-service');
  });

  it('includes parent context and parent comments in the prompt', async () => {
    stubExecFileOut('');
    const ctx = makeContext({
      workItems: [makeWorkItem({
        parentId: '10',
        parentTitle: 'Auth Epic',
        parentDescription: 'Overhaul auth',
        parentComments: ['Clarify scope first'],
      })],
      affectedRepositories: [makeRepository()],
    });

    await registry.resolve('implement changes with Augment')(ctx);

    const prompt = capturedPrompt();
    expect(prompt).toContain('## Parent Context (#10: Auth Epic)');
    expect(prompt).toContain('Overhaul auth');
    expect(prompt).toContain('### Parent Discussion / Comments');
    expect(prompt).toContain('Clarify scope first');
  });

  it('includes work item comments in the prompt', async () => {
    stubExecFileOut('');
    const ctx = makeContext({
      workItems: [makeWorkItem({ comments: ['Fix the timeout issue', 'Also update docs'] })],
      affectedRepositories: [makeRepository()],
    });

    await registry.resolve('implement changes with Augment')(ctx);

    const prompt = capturedPrompt();
    expect(prompt).toContain('## Discussion / Comments');
    expect(prompt).toContain('Fix the timeout issue');
    expect(prompt).toContain('Also update docs');
  });

  it('runs once per work item in workSpacePath', async () => {
    stubExecFileOut('');
    const ctx = makeContext(
      {
        workItems: [makeWorkItem({ id: 'WI-1' }), makeWorkItem({ id: 'WI-2' })],
        affectedRepositories: [makeRepository()],
      },
      { git: { workSpacePath: '/workspace' } },
    );

    await registry.resolve('implement changes with Augment')(ctx);

    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

