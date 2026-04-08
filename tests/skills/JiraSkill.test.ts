import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/jira/index.js';
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

const jiraCfg = {
  baseUrl: 'https://test.atlassian.net',
  email: 'test@example.com',
  apiToken: 'tok-123',
  projectKey: 'ITM',
  inProgressState: 'In Progress',
  completedState: 'Done',
};

const makeIssue = (key: string, summary: string, statusName = 'In Progress') => ({
  key,
  fields: {
    summary,
    description: null,
    issuetype: { name: 'Task' },
    status: { name: statusName },
    labels: ['label-a'],
    components: [{ name: 'comp-1' }],
  },
});

describe('jira skill – fetch jira tickets', () => {
  it('populates state.workItems from search results', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: { issues: [makeIssue('ITM-1', 'First task'), makeIssue('ITM-2', 'Second task')] },
    });

    const ctx = makeContext({}, { jira: jiraCfg });
    await registry.resolve('fetch jira tickets')(ctx);

    const items = ctx.state['workItems'] as Array<{ id: string; title: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe('ITM-1');
    expect(items[0]!.title).toBe('First task');
    expect(items[1]!.id).toBe('ITM-2');
  });

  it('constructs JQL with projectKey and inProgressState', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { issues: [] } });

    const ctx = makeContext({}, { jira: jiraCfg });
    await registry.resolve('fetch jira tickets')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain(encodeURIComponent('project = "ITM"'));
    expect(url).toContain(encodeURIComponent('status = "In Progress"'));
  });

  it('includes filterAssignedTo from state in JQL', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { issues: [] } });

    const ctx = makeContext({ filterAssignedTo: 'dev@example.com' }, { jira: jiraCfg });
    await registry.resolve('fetch jira tickets')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain(encodeURIComponent('assignee = "dev@example.com"'));
  });

  it('stores empty array when no issues returned', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { issues: [] } });

    const ctx = makeContext({}, { jira: jiraCfg });
    await registry.resolve('fetch jira tickets')(ctx);

    expect(ctx.state['workItems']).toEqual([]);
  });

  it('throws when jira config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch jira tickets')(ctx)).rejects.toThrow(
      'Missing required jira config',
    );
  });
});

describe('jira skill – fetch jira tickets with state {state}', () => {
  it('overrides filterWorkItemState with the param and fetches', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { issues: [makeIssue('ITM-5', 'Done task', 'Done')] } });

    const ctx = makeContext({}, { jira: jiraCfg });
    await registry.resolve('fetch jira tickets with state Done')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain(encodeURIComponent('status = "Done"'));

    const items = ctx.state['workItems'] as Array<{ id: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('ITM-5');
  });

  it('uses the state param even when inProgressState is configured', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { issues: [] } });

    const ctx = makeContext({}, { jira: jiraCfg });
    await registry.resolve('fetch jira tickets with state Backlog')(ctx);

    const url = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(url).toContain(encodeURIComponent('status = "Backlog"'));
    expect(url).not.toContain(encodeURIComponent('status = "In Progress"'));
  });

  it('throws when jira config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch jira tickets with state Done')(ctx)).rejects.toThrow(
      'Missing required jira config',
    );
  });
});

describe('jira skill – fetch jira ticket {id} details', () => {
  it('fetches issue and populates comments', async () => {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: makeIssue('ITM-10', 'Detail task') })
      .mockResolvedValueOnce({ data: { comments: [{ body: 'note A' }, { body: 'note B' }] } });

    const ctx = makeContext({}, { jira: jiraCfg });
    await registry.resolve('fetch jira ticket ITM-10 details')(ctx);

    const items = ctx.state['workItems'] as Array<{ id: string; comments: unknown[] }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('ITM-10');
    expect(items[0]!.comments).toHaveLength(2);
  });

  it('throws when jira config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch jira ticket ITM-5 details')(ctx)).rejects.toThrow(
      'Missing required jira config',
    );
  });
});

describe('jira skill – update jira ticket {id} state', () => {
  it('resolves transition by name and posts it', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: { transitions: [{ id: '31', name: 'In Progress' }, { id: '41', name: 'Done' }] },
    });
    mockAxiosInstance.post.mockResolvedValueOnce({});

    const ctx = makeContext({}, { jira: jiraCfg });
    await registry.resolve('update jira ticket ITM-3 state')(ctx);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/rest/api/3/issue/ITM-3/transitions',
      { transition: { id: '31' } },
    );
  });

  it('transitions to Done when pullRequests are present', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: { transitions: [{ id: '31', name: 'In Progress' }, { id: '41', name: 'Done' }] },
    });
    mockAxiosInstance.post.mockResolvedValueOnce({});

    const ctx = makeContext({ pullRequests: [{ id: 'PR-1' }] }, { jira: jiraCfg });
    await registry.resolve('update jira ticket ITM-3 state')(ctx);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/rest/api/3/issue/ITM-3/transitions',
      { transition: { id: '41' } },
    );
  });

  it('throws when the target transition is not in available list', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: { transitions: [{ id: '11', name: 'To Do' }] },
    });

    const ctx = makeContext({}, { jira: jiraCfg });
    await expect(registry.resolve('update jira ticket ITM-3 state')(ctx)).rejects.toThrow(
      'Jira transition "In Progress" not found',
    );
  });

  it('skips API call when dryRun is true', async () => {
    const ctx = makeContext({}, { jira: jiraCfg, dryRun: true });
    await registry.resolve('update jira ticket ITM-3 state')(ctx);

    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  it('throws when jira config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('update jira ticket ITM-3 state')(ctx)).rejects.toThrow(
      'Missing required jira config',
    );
  });
});

