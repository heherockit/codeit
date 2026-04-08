import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/git/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext, makeWorkItem } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

vi.mock('node:fs', () => ({ promises: { readdir: vi.fn() } }));

import { promises as fsPromises } from 'node:fs';
import type { Dirent } from 'node:fs';

const mockReaddir = vi.mocked(fsPromises.readdir);

function makeDir(name: string): Dirent {
  return { name, isDirectory: () => true } as unknown as Dirent;
}

describe('git skill – identify affected repositories', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves repositories from repositoryHints', async () => {
    const workItem = makeWorkItem({ repositoryHints: ['api-service'] });
    const ctx = makeContext({ workItems: [workItem] }, { git: { workSpacePath: '/ws' } });

    await registry.resolve('identify affected repositories')(ctx);

    const repos = ctx.state['affectedRepositories'] as Array<{ name: string }>;
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe('api-service');
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('falls back to workspace directories when no hints', async () => {
    mockReaddir.mockResolvedValue([makeDir('svc-a'), makeDir('svc-b')] as never);
    const workItem = makeWorkItem({ repositoryHints: [] });
    const ctx = makeContext({ workItems: [workItem] }, { git: { workSpacePath: '/ws' } });

    await registry.resolve('identify affected repositories')(ctx);

    const repos = ctx.state['affectedRepositories'] as Array<{ name: string }>;
    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name)).toEqual(['svc-a', 'svc-b']);
  });

  it('deduplicates repositories across multiple work items', async () => {
    const wi1 = makeWorkItem({ id: 'WI-1', repositoryHints: ['auth-service'] });
    const wi2 = makeWorkItem({ id: 'WI-2', repositoryHints: ['auth-service'] });
    const ctx = makeContext({ workItems: [wi1, wi2] });

    await registry.resolve('identify affected repositories')(ctx);

    const repos = ctx.state['affectedRepositories'] as unknown[];
    expect(repos).toHaveLength(1);
  });

  it('produces an empty array when workspace has no directories', async () => {
    mockReaddir.mockResolvedValue([] as never);
    const workItem = makeWorkItem({ repositoryHints: [] });
    const ctx = makeContext({ workItems: [workItem] }, { git: { workSpacePath: '/ws' } });

    await registry.resolve('identify affected repositories')(ctx);

    const repos = ctx.state['affectedRepositories'] as unknown[];
    expect(repos).toHaveLength(0);
  });
});

