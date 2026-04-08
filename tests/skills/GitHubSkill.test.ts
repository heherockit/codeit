import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/github/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
    })),
  },
}));

import axios from 'axios';

const mockAxiosInstance = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(axios.create).mockReturnValue(mockAxiosInstance as never);
});

const githubCfg = {
  token: 'ghp_test_token',
  owner: 'my-org',
  repo: 'my-repo',
  inProgressState: 'open',
  completedState: 'closed',
};

const makeIssue = (number: number, title: string, state = 'open', labels: string[] = []) => ({
  number,
  title,
  body: `Body of ${title}`,
  state,
  labels: labels.map((name) => ({ name })),
});

// ─── fetch github issues ──────────────────────────────────────────────────────

describe('github skill – fetch github issues', () => {
  it('populates state.workItems from fetched issues', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: [makeIssue(1, 'First issue'), makeIssue(2, 'Second issue')],
    });

    const ctx = makeContext({}, { github: githubCfg });
    await registry.resolve('fetch github issues')(ctx);

    const items = ctx.state['workItems'] as Array<{ id: string; title: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('1');
    expect(items[0]!.title).toBe('First issue');
    expect(items[1]!.id).toBe('2');
  });

  it('filters out pull requests from the issues endpoint', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: [makeIssue(1, 'Real issue'), { ...makeIssue(2, 'A PR'), pull_request: {} }],
    });

    const ctx = makeContext({}, { github: githubCfg });
    await registry.resolve('fetch github issues')(ctx);

    const items = ctx.state['workItems'] as Array<{ id: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('1');
  });

  it('maps open state to "active" and closed to "closed"', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: [makeIssue(1, 'Open', 'open'), makeIssue(2, 'Closed', 'closed')],
    });

    const ctx = makeContext({}, { github: githubCfg });
    await registry.resolve('fetch github issues')(ctx);

    const items = ctx.state['workItems'] as Array<{ state: string }>;
    expect(items[0]!.state).toBe('active');
    expect(items[1]!.state).toBe('closed');
  });

  it('maps bug label to bug type and enhancement to feature', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: [makeIssue(1, 'A bug', 'open', ['bug']), makeIssue(2, 'A feature', 'open', ['enhancement'])],
    });

    const ctx = makeContext({}, { github: githubCfg });
    await registry.resolve('fetch github issues')(ctx);

    const items = ctx.state['workItems'] as Array<{ type: string }>;
    expect(items[0]!.type).toBe('bug');
    expect(items[1]!.type).toBe('feature');
  });

  it('sends assignee param from filterAssignedTo in state', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

    const ctx = makeContext({ filterAssignedTo: 'jdoe' }, { github: githubCfg });
    await registry.resolve('fetch github issues')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain('assignee=jdoe');
  });

  it('sends state=open param when inProgressState is open', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

    const ctx = makeContext({}, { github: githubCfg });
    await registry.resolve('fetch github issues')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain('state=open');
  });

  it('throws when github config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch github issues')(ctx)).rejects.toThrow(
      'Missing required github config',
    );
  });
});

// ─── fetch github issue {id} details ─────────────────────────────────────────

describe('github skill – fetch github issue {id} details', () => {
  it('fetches issue and populates comments', async () => {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: makeIssue(10, 'Detailed issue') })
      .mockResolvedValueOnce({ data: [{ body: 'comment one' }, { body: 'comment two' }] });

    const ctx = makeContext({}, { github: githubCfg });
    await registry.resolve('fetch github issue 10 details')(ctx);

    const items = ctx.state['workItems'] as Array<{ id: string; comments: string[] }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('10');
    expect(items[0]!.comments).toEqual(['comment one', 'comment two']);
  });

  it('throws when github config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch github issue 5 details')(ctx)).rejects.toThrow(
      'Missing required github config',
    );
  });
});

// ─── update github issue {id} state ──────────────────────────────────────────

describe('github skill – update github issue {id} state', () => {
  it('patches issue to "open" when no pull requests exist', async () => {
    mockAxiosInstance.patch.mockResolvedValueOnce({ data: {} });

    const ctx = makeContext({}, { github: githubCfg });
    await registry.resolve('update github issue 3 state')(ctx);

    expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
      expect.stringContaining('/issues/3'),
      { state: 'open' },
    );
  });

  it('patches issue to "closed" when pull requests are present', async () => {
    mockAxiosInstance.patch.mockResolvedValueOnce({ data: {} });

    const ctx = makeContext({ pullRequests: [{ number: 99 }] }, { github: githubCfg });
    await registry.resolve('update github issue 3 state')(ctx);

    expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
      expect.stringContaining('/issues/3'),
      { state: 'closed' },
    );
  });

  it('skips API call when dryRun is true', async () => {
    const ctx = makeContext({}, { github: githubCfg, dryRun: true });
    await registry.resolve('update github issue 3 state')(ctx);

    expect(mockAxiosInstance.patch).not.toHaveBeenCalled();
  });

  it('throws when github config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('update github issue 3 state')(ctx)).rejects.toThrow(
      'Missing required github config',
    );
  });
});

// ─── create github pull request {id} ─────────────────────────────────────────

describe('github skill – create github pull request {id}', () => {
  const featureBranch = {
    name: 'feature/7-my-task',
    repositoryName: 'my-repo',
    baseBranch: 'dev-sprint',
    workItemId: '7',
  };

  it('posts the correct PR payload using the feature branch from state', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({
      data: { number: 42, title: 'feat: [#7] My Task', html_url: 'https://github.com/my-org/my-repo/pull/42' },
    });

    const ctx = makeContext(
      { featureBranches: [featureBranch], workItems: [{ id: '7', title: 'My Task', description: 'desc' }] },
      { github: githubCfg },
    );
    await registry.resolve('create github pull request 7')(ctx);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      expect.stringContaining('/pulls'),
      expect.objectContaining({
        head: 'feature/7-my-task',
        base: 'dev-sprint',
        title: 'feat: [#7] My Task',
        draft: true,
      }),
    );
  });

  it('stores the created PR in state.pullRequests', async () => {
    const prData = { number: 42, title: 'feat: [#7] My Task', html_url: 'https://github.com/my-org/my-repo/pull/42' };
    mockAxiosInstance.post.mockResolvedValueOnce({ data: prData });

    const ctx = makeContext(
      { featureBranches: [featureBranch], workItems: [{ id: '7', title: 'My Task' }] },
      { github: githubCfg },
    );
    await registry.resolve('create github pull request 7')(ctx);

    expect(ctx.state['pullRequests']).toEqual([prData]);
  });

  it('throws when no feature branch is found for the issue', async () => {
    const ctx = makeContext({ featureBranches: [] }, { github: githubCfg });
    await expect(registry.resolve('create github pull request 7')(ctx)).rejects.toThrow(
      'No feature branch found in state for GitHub issue #7',
    );
  });

  it('skips API call when dryRun is true', async () => {
    const ctx = makeContext({ featureBranches: [featureBranch] }, { github: githubCfg, dryRun: true });
    await registry.resolve('create github pull request 7')(ctx);

    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  it('throws when github config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('create github pull request 7')(ctx)).rejects.toThrow(
      'Missing required github config',
    );
  });
});

