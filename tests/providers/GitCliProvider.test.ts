import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/git/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext, makeWorkItem, makeRepository } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

vi.mock('node:child_process', () => ({ exec: vi.fn() }));
vi.mock('node:fs', () => ({ promises: { readdir: vi.fn(), access: vi.fn() } }));

import * as cp from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import type { Dirent } from 'node:fs';

const mockReaddir = vi.mocked(fsPromises.readdir);
const mockAccess = vi.mocked(fsPromises.access);

const mockExec = vi.mocked(cp.exec);

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

const stubExec = (stdout = '', stderr = '') =>
  mockExec.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as ExecCallback;
    cb(null, { stdout, stderr });
    return {} as ReturnType<typeof cp.exec>;
  });

describe('git skill – create feature branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
  });

  it('creates the branch directly when the name is free', async () => {
    stubExec(); // branch --list returns empty → name is free
    const workItem = makeWorkItem({ id: 'WI-1', title: 'Add login' });
    const repo = makeRepository({ localPath: '/repo/auth' });
    const ctx = makeContext({ workItems: [workItem], affectedRepositories: [repo] });

    await registry.resolve('create feature branches')(ctx);

    const branches = ctx.state['featureBranches'] as Array<{ name: string; baseBranch: string }>;
    expect(branches).toHaveLength(1);
    expect(branches[0]!.name).toBe('feature/WI-1-add-login');
    expect(branches[0]!.baseBranch).toBe('dev-sprint');
    expect(mockExec).toHaveBeenCalledTimes(4); // checkout dev-sprint, pull, branch --list, checkout -b
    const cmds = mockExec.mock.calls.map((c) => c[0] as string);
    expect(cmds[0]).toContain('checkout dev-sprint');
    expect(cmds[1]).toContain('pull origin dev-sprint');
    expect(cmds[2]).toContain('branch --list feature/WI-1-add-login');
    expect(cmds[3]).toContain('checkout -b feature/WI-1-add-login');
  });

  it('appends -2 suffix when base name exists but suffixed name is free', async () => {
    let callIndex = 0;
    mockExec.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecCallback;
      // call index 0: checkout dev-sprint      → ok
      // call index 1: pull origin dev-sprint   → ok
      // call index 2: branch --list <base>     → exists (non-empty)
      // call index 3: branch --list <base>-2   → free (empty)
      // call index 4: checkout -b <base>-2     → ok
      const stdout = callIndex++ === 2 ? 'feature/WI-1-add-login' : '';
      cb(null, { stdout, stderr: '' });
      return {} as ReturnType<typeof cp.exec>;
    });

    const workItem = makeWorkItem({ id: 'WI-1', title: 'Add login' });
    const repo = makeRepository({ localPath: '/repo/auth' });
    const ctx = makeContext({ workItems: [workItem], affectedRepositories: [repo] });

    await registry.resolve('create feature branches')(ctx);

    // checkout dev-sprint, pull, branch --list <base>, branch --list <base>-2, checkout -b <base>-2
    expect(mockExec).toHaveBeenCalledTimes(5);
    const cmds = mockExec.mock.calls.map((c) => c[0] as string);
    expect(cmds[0]).toContain('checkout dev-sprint');
    expect(cmds[1]).toContain('pull origin dev-sprint');
    expect(cmds[2]).toContain('branch --list feature/WI-1-add-login');
    expect(cmds[3]).toContain('branch --list feature/WI-1-add-login-2');
    expect(cmds[4]).toContain('checkout -b feature/WI-1-add-login-2');
    const branches = ctx.state['featureBranches'] as Array<{ name: string; baseBranch: string }>;
    expect(branches).toHaveLength(1);
    expect(branches[0]!.name).toBe('feature/WI-1-add-login-2');
    expect(branches[0]!.baseBranch).toBe('dev-sprint');
  });
});

describe('git skill – commit and push changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
  });

  it('commits and pushes for each matching repo/branch pair', async () => {
    stubExec('M src/file.ts'); // non-empty status → changes exist
    const workItem = makeWorkItem({ id: 'WI-1' });
    const repo = makeRepository({ localPath: '/repo/auth', name: 'auth-service' });
    const branch = { name: 'feature/WI-1-add-login', repositoryName: 'auth-service', baseBranch: 'main', workItemId: 'WI-1' };
    const ctx = makeContext({
      workItems: [workItem],
      affectedRepositories: [repo],
      featureBranches: [branch],
    });

    await registry.resolve('commit and push changes')(ctx);

    expect(mockExec).toHaveBeenCalledTimes(4); // add -A, status --porcelain, commit, push
    const cmds = mockExec.mock.calls.map((c) => c[0] as string);
    expect(cmds[1]).toContain('status --porcelain');
    expect(cmds[3]).toContain('push --set-upstream origin feature/WI-1-add-login');
    expect(ctx.state['pushedBranches']).toHaveLength(1);
  });

  it('skips commit and push when there are no staged changes', async () => {
    stubExec(''); // empty status → nothing to commit
    const workItem = makeWorkItem({ id: 'WI-1' });
    const repo = makeRepository({ localPath: '/repo/auth', name: 'auth-service' });
    const branch = { name: 'feature/WI-1-add-login', repositoryName: 'auth-service', baseBranch: 'main', workItemId: 'WI-1' };
    const ctx = makeContext({
      workItems: [workItem],
      affectedRepositories: [repo],
      featureBranches: [branch],
    });

    await registry.resolve('commit and push changes')(ctx);

    expect(mockExec).toHaveBeenCalledTimes(2); // add -A, status --porcelain only
    const cmds = mockExec.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes('commit'))).toBe(false);
    expect(cmds.some((c) => c.includes('push'))).toBe(false);
    expect(ctx.state['pushedBranches']).toHaveLength(0);
  });

  it('skips commit and push when dryRun is true', async () => {
    stubExec('M src/file.ts'); // non-empty status → changes exist
    const workItem = makeWorkItem({ id: 'WI-1' });
    const repo = makeRepository({ localPath: '/repo/auth', name: 'auth-service' });
    const branch = { name: 'feature/WI-1-add-login', repositoryName: 'auth-service', baseBranch: 'main', workItemId: 'WI-1' };
    const ctx = makeContext(
      { workItems: [workItem], affectedRepositories: [repo], featureBranches: [branch] },
      { dryRun: true },
    );

    await registry.resolve('commit and push changes')(ctx);

    expect(mockExec).toHaveBeenCalledTimes(2); // add -A, status --porcelain only — no commit, no push
    const cmds = mockExec.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes('commit'))).toBe(false);
    expect(cmds.some((c) => c.includes('push'))).toBe(false);
  });

  it('throws when git returns a fatal error', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockExec.mockImplementation((_cmd: unknown, _opts: unknown, cb?: unknown) => {
      (cb as ExecCallback)(null, { stdout: '', stderr: 'fatal: not a git repository' });
      return {} as ReturnType<typeof cp.exec>;
    });

    const ctx = makeContext({
      workItems: [makeWorkItem()],
      affectedRepositories: [makeRepository()],
      featureBranches: [{ name: 'feature/WI-1', repositoryName: 'auth-service', baseBranch: 'main', workItemId: 'WI-1' }],
    });

    await expect(registry.resolve('commit and push changes')(ctx)).rejects.toThrow('fatal');
  });
});

describe('git skill – identify affected repositories', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves repos from work item hints', async () => {
    const workItem = makeWorkItem({ repositoryHints: ['my-repo'] });
    const ctx = makeContext({ workItems: [workItem] }, { git: { workSpacePath: '/ws' } });

    await registry.resolve('identify affected repositories')(ctx);

    const repos = ctx.state['affectedRepositories'] as Array<{ name: string }>;
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe('my-repo');
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('falls back to workspace directories when no hints', async () => {
    const makeDir = (name: string): Dirent => ({ name, isDirectory: () => true } as unknown as Dirent);
    mockReaddir.mockResolvedValue([makeDir('svc-a'), makeDir('svc-b')] as never);

    const workItem = makeWorkItem({ repositoryHints: [] });
    const ctx = makeContext({ workItems: [workItem] }, { git: { workSpacePath: '/ws' } });

    await registry.resolve('identify affected repositories')(ctx);

    const repos = ctx.state['affectedRepositories'] as unknown[];
    expect(repos).toHaveLength(2);
  });
});

