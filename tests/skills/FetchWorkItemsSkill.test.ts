import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register } from '../../src/skills/azure-devops/index.js';
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

const adoCfg = { organization: 'my-org', project: 'my-proj', personalAccessToken: 'pat-123' };

const makeRawItem = (id: number, title: string, relations?: object[]) => ({
  id,
  fields: {
    'System.Title': title,
    'System.WorkItemType': 'Task',
    'System.State': 'Active',
    'System.Description': `Description of ${title}`,
    'System.Tags': '',
  },
  ...(relations ? { relations } : {}),
});

const withComments = (texts: string[]) => ({ data: { comments: texts.map((text) => ({ text })) } });

describe('azure-devops skill – fetch work items', () => {
  it('fetches only the first work item returned by WIQL', async () => {
    mockAxiosInstance.post.mockResolvedValue({ data: { workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { value: [makeRawItem(1, 'Task A')] } });

    const ctx = makeContext({}, { azureDevOps: adoCfg });
    await registry.resolve('fetch work items from Azure DevOps')(ctx);

    const workItems = ctx.state['workItems'] as Array<{ title: string }>;
    expect(workItems).toHaveLength(1);
    expect(workItems[0]!.title).toBe('Task A');

    const detailUrl = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(detailUrl).toContain('ids=1');
    expect(detailUrl).not.toContain('2');
  });

  it('does not perform deep fetch (no comments or parent calls)', async () => {
    mockAxiosInstance.post.mockResolvedValue({ data: { workItems: [{ id: 1 }] } });
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { value: [makeRawItem(1, 'Task A')] } });

    const ctx = makeContext({}, { azureDevOps: adoCfg });
    await registry.resolve('fetch work items from Azure DevOps')(ctx);

    // Only one GET call for basic details; no comments or parent calls.
    expect(mockAxiosInstance.get).toHaveBeenCalledOnce();
  });

  it('applies WIQL filter from config when workItemType is set', async () => {
    mockAxiosInstance.post.mockResolvedValue({ data: { workItems: [] } });

    const ctx = makeContext({}, { azureDevOps: { ...adoCfg, workItemType: 'Bug', workItemState: 'Active' } });
    await registry.resolve('fetch work items from Azure DevOps')(ctx);

    const wiqlBody = mockAxiosInstance.post.mock.calls[0]![1] as { query: string };
    expect(wiqlBody.query).toContain("[System.WorkItemType] = 'Bug'");
    expect(wiqlBody.query).toContain("[System.State] = 'Active'");
    expect(wiqlBody.query).toContain('ORDER BY [Microsoft.VSTS.Common.Priority] DESC');
  });

  it('applies WIQL filter from state overrides', async () => {
    mockAxiosInstance.post.mockResolvedValue({ data: { workItems: [] } });

    const ctx = makeContext(
      { filterWorkItemType: 'User Story', filterAssignedTo: 'dev@example.com' },
      { azureDevOps: adoCfg },
    );
    await registry.resolve('fetch work items from Azure DevOps')(ctx);

    const wiqlBody = mockAxiosInstance.post.mock.calls[0]![1] as { query: string };
    expect(wiqlBody.query).toContain("[System.WorkItemType] = 'User Story'");
    expect(wiqlBody.query).toContain("[System.AssignedTo] = 'dev@example.com'");
  });

  it('stores an empty array when no work items are returned', async () => {
    mockAxiosInstance.post.mockResolvedValue({ data: { workItems: [] } });

    const ctx = makeContext({}, { azureDevOps: adoCfg });
    await registry.resolve('fetch work items from Azure DevOps')(ctx);

    expect(ctx.state['workItems']).toEqual([]);
  });

  it('throws when azureDevOps config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(registry.resolve('fetch work items from Azure DevOps')(ctx)).rejects.toThrow(
      'Missing required azureDevOps config',
    );
  });
});

describe('azure-devops skill – fetch work item details', () => {
  it('enriches work items with comments', async () => {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { value: [makeRawItem(1, 'Task A')] } }) // expand details
      .mockResolvedValueOnce(withComments(['First comment', 'Second comment'])); // comments

    const ctx = makeContext({ workItems: [{ id: '1', title: 'Task A' }] }, { azureDevOps: adoCfg });
    await registry.resolve('fetch work item details from Azure DevOps')(ctx);

    const workItems = ctx.state['workItems'] as Array<{ title: string; comments: string[] }>;
    expect(workItems[0]!.comments).toEqual(['First comment', 'Second comment']);
  });

  it('fetches parent description and comments when a parent relation exists', async () => {
    const parentRelation = { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/.../100' };
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { value: [makeRawItem(1, 'Child Task', [parentRelation])] } }) // expand details
      .mockResolvedValueOnce(withComments(['child note']))                                            // child comments
      .mockResolvedValueOnce({ data: { value: [makeRawItem(100, 'Parent Epic')] } })                 // parent details
      .mockResolvedValueOnce(withComments(['parent note']));                                          // parent comments

    const ctx = makeContext({ workItems: [{ id: '1', title: 'Child Task' }] }, { azureDevOps: adoCfg });
    await registry.resolve('fetch work item details from Azure DevOps')(ctx);

    const workItems = ctx.state['workItems'] as Array<{
      parentId: string; parentTitle: string; parentDescription: string; parentComments: string[];
    }>;
    expect(workItems[0]!.parentId).toBe('100');
    expect(workItems[0]!.parentTitle).toBe('Parent Epic');
    expect(workItems[0]!.parentDescription).toBe('Description of Parent Epic');
    expect(workItems[0]!.parentComments).toEqual(['parent note']);
  });

  it('skips fetching when workItems state is empty', async () => {
    const ctx = makeContext({ workItems: [] }, { azureDevOps: adoCfg });
    await registry.resolve('fetch work item details from Azure DevOps')(ctx);
    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
  });

  it('throws when azureDevOps config is missing', async () => {
    const ctx = makeContext({ workItems: [{ id: '1' }] }, {});
    await expect(registry.resolve('fetch work item details from Azure DevOps')(ctx)).rejects.toThrow(
      'Missing required azureDevOps config',
    );
  });
});

describe('azure-devops skill – fetch work item {id} details from Azure DevOps', () => {
  it('fetches and stores the correct work item when a valid id is provided', async () => {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { value: [makeRawItem(42, 'My Task')] } }) // expand details
      .mockResolvedValueOnce(withComments([]));                                   // comments

    const ctx = makeContext({}, { azureDevOps: adoCfg });
    await registry.resolve('fetch work item 42 details from Azure DevOps')(ctx);

    const workItems = ctx.state['workItems'] as Array<{ id: string; title: string }>;
    expect(workItems).toHaveLength(1);
    expect(workItems[0]!.id).toBe('42');
    expect(workItems[0]!.title).toBe('My Task');

    const detailUrl = mockAxiosInstance.get.mock.calls[0]![0] as string;
    expect(detailUrl).toContain('ids=42');
    expect(detailUrl).toContain('$expand=all');
  });

  it('includes comments in the result', async () => {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { value: [makeRawItem(7, 'Commented Task')] } })
      .mockResolvedValueOnce(withComments(['First comment', 'Second comment']));

    const ctx = makeContext({}, { azureDevOps: adoCfg });
    await registry.resolve('fetch work item 7 details from Azure DevOps')(ctx);

    const workItems = ctx.state['workItems'] as Array<{ comments: string[] }>;
    expect(workItems[0]!.comments).toEqual(['First comment', 'Second comment']);
  });

  it('includes parent context when a parent relation exists', async () => {
    const parentRelation = { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/.../200' };
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { value: [makeRawItem(5, 'Child Task', [parentRelation])] } }) // expand details
      .mockResolvedValueOnce(withComments(['child note']))                                            // child comments
      .mockResolvedValueOnce({ data: { value: [makeRawItem(200, 'Parent Feature')] } })              // parent details
      .mockResolvedValueOnce(withComments(['parent note']));                                          // parent comments

    const ctx = makeContext({}, { azureDevOps: adoCfg });
    await registry.resolve('fetch work item 5 details from Azure DevOps')(ctx);

    const workItems = ctx.state['workItems'] as Array<{
      parentId: string; parentTitle: string; parentDescription: string; parentComments: string[];
    }>;
    expect(workItems[0]!.parentId).toBe('200');
    expect(workItems[0]!.parentTitle).toBe('Parent Feature');
    expect(workItems[0]!.parentDescription).toBe('Description of Parent Feature');
    expect(workItems[0]!.parentComments).toEqual(['parent note']);
  });

  it('throws when azureDevOps config is missing', async () => {
    const ctx = makeContext({}, {});
    await expect(
      registry.resolve('fetch work item 1 details from Azure DevOps')(ctx),
    ).rejects.toThrow('Missing required azureDevOps config');
  });
});
