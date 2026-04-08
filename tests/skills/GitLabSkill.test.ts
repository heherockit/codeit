import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/gitlab/index.js';
import { SkillRegistry } from '../../src/core/SkillRegistry.js';
import { makeContext } from '../helpers/mocks.js';

const registry = new SkillRegistry();
register(registry);

// Mock axios to avoid real HTTP calls.
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      post: vi.fn(),
      get: vi.fn(),
    })),
  },
}));

import axios from 'axios';

const mockAxiosInstance = {
  post: vi.fn(),
  get: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(axios.create).mockReturnValue(mockAxiosInstance as never);
});

const gitlabCfg = {
  baseUrl: 'https://gitlab.example.com',
  privateToken: 'glpat-test-token',
  projectId: '42',
  inProgressState: 'In Progress',
  completedState: 'Closed',
};

const makeIssue = (iid: number, title: string, state = 'opened') => ({
  iid,
  title,
  description: `Description of ${title}`,
  state,
  labels: ['backend'],
  type: 'issue',
});

describe('gitlab skill – fetch gitlab issues', () => {
  it('populates state.workItems from fetched issues', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: [makeIssue(1, 'First issue'), makeIssue(2, 'Second issue')],
    });

    const ctx = makeContext({}, { gitlab: gitlabCfg });
    await registry.resolve('fetch gitlab issues')(ctx);

    const items = ctx.state['workItems'] as Array<{ id: string; title: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('1');
    expect(items[0]!.title).toBe('First issue');
    expect(items[1]!.id).toBe('2');
  });

  it('maps opened state to "active" and closed to "closed"', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: [makeIssue(1, 'Open issue', 'opened'), makeIssue(2, 'Closed issue', 'closed')],
    });

    const ctx = makeContext({}, { gitlab: gitlabCfg });
    await registry.resolve('fetch gitlab issues')(ctx);

    const items = ctx.state['workItems'] as Array<{ state: string }>;
    expect(items[0]!.state).toBe('active');
    expect(items[1]!.state).toBe('closed');
  });

  it('sends state=opened param when inProgressState is configured', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

    const ctx = makeContext({}, { gitlab: gitlabCfg });
    await registry.resolve('fetch gitlab issues')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain('state=opened');
  });

  it('sends assignee_username param from filterAssignedTo in state', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

    const ctx = makeContext({ filterAssignedTo: 'jdoe' }, { gitlab: gitlabCfg });
    await registry.resolve('fetch gitlab issues')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain('assignee_username=jdoe');
  });

  it('stores empty array when no issues returned', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

    const ctx = makeContext({}, { gitlab: gitlabCfg });
    await registry.resolve('fetch gitlab issues')(ctx);

    expect(ctx.state['workItems']).toEqual([]);
  });

  it('throws when gitlab config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch gitlab issues')(ctx)).rejects.toThrow(
      'Missing required gitlab config',
    );
  });
});

describe('gitlab skill – fetch gitlab issue {id} details', () => {
  it('fetches issue and populates notes as comments', async () => {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: makeIssue(10, 'Detail issue') })
      .mockResolvedValueOnce({ data: [{ body: 'note one' }, { body: 'note two' }] });

    const ctx = makeContext({}, { gitlab: gitlabCfg });
    await registry.resolve('fetch gitlab issue 10 details')(ctx);

    const items = ctx.state['workItems'] as Array<{ id: string; comments: string[] }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('10');
    expect(items[0]!.comments).toEqual(['note one', 'note two']);
  });

  it('throws when gitlab config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch gitlab issue 5 details')(ctx)).rejects.toThrow(
      'Missing required gitlab config',
    );
  });
});

describe('gitlab skill – create gitlab merge request {id}', () => {
  const featureBranch = {
    name: 'feature/1-my-task',
    repositoryName: 'my-repo',
    baseBranch: 'dev-sprint',
    workItemId: '7',
  };

  it('posts the correct MR payload using the feature branch from state', async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: { iid: 99, title: 'Draft: [#7] My Task', web_url: 'https://gitlab.example.com/mr/99' } });

    const ctx = makeContext(
      { featureBranches: [featureBranch], workItems: [{ id: '7', title: 'My Task' }] },
      { gitlab: gitlabCfg },
    );
    await registry.resolve('create gitlab merge request 7')(ctx);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      expect.stringContaining('/merge_requests'),
      expect.objectContaining({
        source_branch: 'feature/1-my-task',
        target_branch: 'dev-sprint',
        title: 'Draft: [#7] My Task',
      }),
    );
  });

  it('stores the created MR in state.mergeRequests', async () => {
    const mrData = { iid: 99, title: 'Draft: [#7] My Task', web_url: 'https://gitlab.example.com/mr/99' };
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mrData });

    const ctx = makeContext(
      { featureBranches: [featureBranch], workItems: [{ id: '7', title: 'My Task' }] },
      { gitlab: gitlabCfg },
    );
    await registry.resolve('create gitlab merge request 7')(ctx);

    expect(ctx.state['mergeRequests']).toEqual([mrData]);
  });

  it('throws when no feature branch is found for the issue', async () => {
    const ctx = makeContext({ featureBranches: [] }, { gitlab: gitlabCfg });
    await expect(registry.resolve('create gitlab merge request 7')(ctx)).rejects.toThrow(
      'No feature branch found in state for issue #7',
    );
  });

  it('skips API call when dryRun is true', async () => {
    const ctx = makeContext({ featureBranches: [featureBranch] }, { gitlab: gitlabCfg, dryRun: true });
    await registry.resolve('create gitlab merge request 7')(ctx);

    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  it('throws when gitlab config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('create gitlab merge request 7')(ctx)).rejects.toThrow(
      'Missing required gitlab config',
    );
  });
});

