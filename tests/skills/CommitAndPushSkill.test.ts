import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/azure-devops/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext, makeWorkItem } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
    })),
  },
}));

import axios from 'axios';

const mockAxiosInstance = { post: vi.fn(), get: vi.fn(), patch: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(axios.create).mockReturnValue(mockAxiosInstance as never);
});

const adoCfg = { organization: 'my-org', project: 'my-proj', personalAccessToken: 'pat-123' };

const makeRepoListResponse = (repos: Array<{ id: string; name: string }>) => ({
  data: { value: repos },
});

const makePrResponse = (id: number, title: string) => ({
  data: { pullRequestId: id, title, url: `https://dev.azure.com/pr/${id}` },
});

describe('azure-devops skill – create pull requests', () => {
  it('creates a PR for each pushed branch and stores results in state', async () => {
    mockAxiosInstance.get.mockResolvedValue(
      makeRepoListResponse([{ id: 'repo-1', name: 'auth-service' }]),
    );
    mockAxiosInstance.post.mockResolvedValue(makePrResponse(42, 'feat: Add login feature'));

    const workItem = makeWorkItem({ id: 'WI-1', title: 'Add login feature' });
    const branch = { name: 'feature/WI-1-add-login', repositoryName: 'auth-service', baseBranch: 'main', workItemId: 'WI-1' };
    const ctx = makeContext({ workItems: [workItem], pushedBranches: [branch] }, { azureDevOps: adoCfg });

    await registry.resolve('create pull requests in Azure DevOps')(ctx);

    const prs = ctx.state['pullRequests'] as Array<{ id: string; title: string }>;
    expect(prs).toHaveLength(1);
    expect(prs[0]!.id).toBe('42');
    expect(prs[0]!.title).toBe('feat: Add login feature');
  });

  it('skips PR creation when there are no pushed branches', async () => {
    const ctx = makeContext({ pushedBranches: [] }, { azureDevOps: adoCfg });

    await registry.resolve('create pull requests in Azure DevOps')(ctx);

    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    expect(ctx.state['pullRequests']).toEqual([]);
  });

  it('skips branches whose repository is not found in ADO', async () => {
    mockAxiosInstance.get.mockResolvedValue(makeRepoListResponse([]));

    const branch = { name: 'feature/WI-1', repositoryName: 'unknown-repo', baseBranch: 'main', workItemId: 'WI-1' };
    const ctx = makeContext({ workItems: [makeWorkItem()], pushedBranches: [branch] }, { azureDevOps: adoCfg });

    await registry.resolve('create pull requests in Azure DevOps')(ctx);

    const prs = ctx.state['pullRequests'] as unknown[];
    expect(prs).toHaveLength(0);
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  it('creates multiple PRs across different repositories', async () => {
    mockAxiosInstance.get.mockResolvedValue(
      makeRepoListResponse([
        { id: 'repo-api', name: 'api-service' },
        { id: 'repo-ui', name: 'ui-service' },
      ]),
    );
    mockAxiosInstance.post
      .mockResolvedValueOnce(makePrResponse(10, 'feat: task'))
      .mockResolvedValueOnce(makePrResponse(11, 'feat: task'));

    const branches = [
      { name: 'feature/WI-1', repositoryName: 'api-service', baseBranch: 'main', workItemId: 'WI-1' },
      { name: 'feature/WI-1', repositoryName: 'ui-service', baseBranch: 'main', workItemId: 'WI-1' },
    ];
    const ctx = makeContext({ workItems: [makeWorkItem()], pushedBranches: branches }, { azureDevOps: adoCfg });

    await registry.resolve('create pull requests in Azure DevOps')(ctx);

    const prs = ctx.state['pullRequests'] as unknown[];
    expect(prs).toHaveLength(2);
    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
  });

  it('throws when azureDevOps config is missing', async () => {
    const branch = { name: 'feature/WI-1', repositoryName: 'auth-service', baseBranch: 'main', workItemId: 'WI-1' };
    const ctx = makeContext({ pushedBranches: [branch] }, {});
    await expect(registry.resolve('create pull requests in Azure DevOps')(ctx)).rejects.toThrow(
      'Missing required azureDevOps config',
    );
  });

  it('skips PR creation when dryRun is true', async () => {
    const branch = { name: 'feature/WI-1', repositoryName: 'auth-service', baseBranch: 'main', workItemId: 'WI-1' };
    const ctx = makeContext({ pushedBranches: [branch] }, { azureDevOps: adoCfg, dryRun: true });

    await registry.resolve('create pull requests in Azure DevOps')(ctx);

    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });
});

describe('azure-devops skill – update work item state', () => {
  it('transitions to inProgressState when no pull requests exist', async () => {
    mockAxiosInstance.patch.mockResolvedValue({});

    const ctx = makeContext(
      { workItems: [makeWorkItem({ id: '1' })] },
      { azureDevOps: { ...adoCfg, inProgressState: 'In Progress', completedState: 'Done' } },
    );

    await registry.resolve('update work item state in Azure DevOps')(ctx);

    expect(mockAxiosInstance.patch).toHaveBeenCalledOnce();
    const [url, body, config] = mockAxiosInstance.patch.mock.calls[0] as [string, unknown[], { headers: Record<string, string> }];
    expect(url).toContain('/workItems/1');
    expect(body).toEqual([{ op: 'add', path: '/fields/System.State', value: 'In Progress' }]);
    expect(config.headers['Content-Type']).toBe('application/json-patch+json');
  });

  it('transitions to completedState when pull requests exist', async () => {
    mockAxiosInstance.patch.mockResolvedValue({});

    const ctx = makeContext(
      { workItems: [makeWorkItem({ id: '2' })], pullRequests: [{ id: 'pr-1' }] },
      { azureDevOps: { ...adoCfg, inProgressState: 'In Progress', completedState: 'Done' } },
    );

    await registry.resolve('update work item state in Azure DevOps')(ctx);

    const [, body] = mockAxiosInstance.patch.mock.calls[0] as [string, unknown[]];
    expect(body).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Done' }]);
  });

  it('defaults to "In Progress" and "Done" when config values are absent', async () => {
    mockAxiosInstance.patch.mockResolvedValue({});

    const ctxNoState = makeContext({ workItems: [makeWorkItem({ id: '3' })] }, { azureDevOps: adoCfg });
    await registry.resolve('update work item state in Azure DevOps')(ctxNoState);
    const [, bodyNoState] = mockAxiosInstance.patch.mock.calls[0] as [string, unknown[]];
    expect((bodyNoState[0] as { value: string }).value).toBe('In Progress');

    vi.clearAllMocks();
    mockAxiosInstance.patch.mockResolvedValue({});

    const ctxWithPRs = makeContext(
      { workItems: [makeWorkItem({ id: '4' })], pullRequests: [{ id: 'pr-1' }] },
      { azureDevOps: adoCfg },
    );
    await registry.resolve('update work item state in Azure DevOps')(ctxWithPRs);
    const [, bodyWithPRs] = mockAxiosInstance.patch.mock.calls[0] as [string, unknown[]];
    expect((bodyWithPRs[0] as { value: string }).value).toBe('Done');
  });

  it('updates all work items in the current mission', async () => {
    mockAxiosInstance.patch.mockResolvedValue({});

    const ctx = makeContext(
      { workItems: [makeWorkItem({ id: '10' }), makeWorkItem({ id: '11' })] },
      { azureDevOps: adoCfg },
    );

    await registry.resolve('update work item state in Azure DevOps')(ctx);

    expect(mockAxiosInstance.patch).toHaveBeenCalledTimes(2);
  });

  it('skips PATCH calls and logs when workItems is empty', async () => {
    const ctx = makeContext({ workItems: [] }, { azureDevOps: adoCfg });
    await registry.resolve('update work item state in Azure DevOps')(ctx);
    expect(mockAxiosInstance.patch).not.toHaveBeenCalled();
  });

  it('throws when azureDevOps config is missing', async () => {
    const ctx = makeContext({ workItems: [makeWorkItem()] }, {});
    await expect(registry.resolve('update work item state in Azure DevOps')(ctx)).rejects.toThrow(
      'Missing required azureDevOps config',
    );
  });

  it('skips PATCH calls when dryRun is true', async () => {
    const ctx = makeContext(
      { workItems: [makeWorkItem({ id: '1' })] },
      { azureDevOps: adoCfg, dryRun: true },
    );

    await registry.resolve('update work item state in Azure DevOps')(ctx);

    expect(mockAxiosInstance.patch).not.toHaveBeenCalled();
  });
});

