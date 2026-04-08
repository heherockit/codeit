import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/git/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext, makeWorkItem, makeRepository } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

vi.mock('node:child_process', () => ({ exec: vi.fn() }));
vi.mock('node:fs', () => ({ promises: { access: vi.fn() } }));

import * as cp from 'node:child_process';
import { promises as fsPromises } from 'node:fs';

const mockExec = vi.mocked(cp.exec);
const mockAccess = vi.mocked(fsPromises.access);

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

  it('generates a slugified branch name from work item id and title', async () => {
    stubExec();
    const workItem = makeWorkItem({ id: 'WI-10', title: 'Fix null pointer' });
    const ctx = makeContext({
      workItems: [workItem],
      affectedRepositories: [makeRepository()],
    });

    await registry.resolve('create feature branches')(ctx);

    const branches = ctx.state['featureBranches'] as Array<{ name: string }>;
    expect(branches[0]!.name).toBe('feature/WI-10-fix-null-pointer');
  });

  it('creates one branch per repository × work item combination', async () => {
    stubExec();
    const repos = [
      makeRepository({ name: 'api', localPath: '/repos/api' }),
      makeRepository({ name: 'ui', localPath: '/repos/ui' }),
    ];
    const ctx = makeContext({
      workItems: [makeWorkItem({ id: 'WI-1' })],
      affectedRepositories: repos,
    });

    await registry.resolve('create feature branches')(ctx);

    const branches = ctx.state['featureBranches'] as unknown[];
    expect(branches).toHaveLength(2);
    // 4 git commands per branch (checkout, pull, branch --list, checkout -b)
    expect(mockExec).toHaveBeenCalledTimes(8);
  });

  it('creates branches for multiple work items in the same repo', async () => {
    stubExec();
    const ctx = makeContext({
      workItems: [
        makeWorkItem({ id: 'WI-1', title: 'Task one' }),
        makeWorkItem({ id: 'WI-2', title: 'Task two' }),
      ],
      affectedRepositories: [makeRepository()],
    });

    await registry.resolve('create feature branches')(ctx);

    const branches = ctx.state['featureBranches'] as Array<{ name: string }>;
    expect(branches).toHaveLength(2);
    expect(branches[0]!.name).toContain('WI-1');
    expect(branches[1]!.name).toContain('WI-2');
  });

  it('stores repositoryName and workItemId on each branch entry', async () => {
    stubExec();
    const repo = makeRepository({ name: 'my-service' });
    const workItem = makeWorkItem({ id: 'WI-5' });
    const ctx = makeContext({
      workItems: [workItem],
      affectedRepositories: [repo],
    });

    await registry.resolve('create feature branches')(ctx);

    const branches = ctx.state['featureBranches'] as Array<{
      repositoryName: string;
      workItemId: string;
    }>;
    expect(branches[0]!.repositoryName).toBe('my-service');
    expect(branches[0]!.workItemId).toBe('WI-5');
  });

  it('produces an empty featureBranches array when no repos are in state', async () => {
    stubExec();
    const ctx = makeContext({
      workItems: [makeWorkItem()],
      affectedRepositories: [],
    });

    await registry.resolve('create feature branches')(ctx);

    expect(ctx.state['featureBranches']).toEqual([]);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

