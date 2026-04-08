import axios, { type AxiosInstance } from 'axios';
import type { SkillContext } from '../../core/interfaces/ISkill.js';
import type { SkillRegistry } from '../../core/SkillRegistry.js';
import type { WorkItem, WorkItemState, WorkItemType, PullRequest } from '../../core/types/index.js';
import type { AzureDevOpsConfig } from '../../core/types/WorkflowConfig.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function createHttpClient(cfg: AzureDevOpsConfig): AxiosInstance {
  const token = Buffer.from(`:${cfg.personalAccessToken}`).toString('base64');
  return axios.create({
    baseURL: `https://dev.azure.com/${encodeURIComponent(cfg.organization)}`,
    headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
  });
}

function requireAdoConfig(ctx: SkillContext): { http: AxiosInstance; project: string; apiVersion: string } {
  const cfg = ctx.config.azureDevOps;
  if (!cfg?.organization || !cfg?.project || !cfg?.personalAccessToken) {
    throw new Error('Missing required azureDevOps config (organization, project, personalAccessToken).');
  }
  return {
    http: createHttpClient(cfg),
    project: encodeURIComponent(cfg.project),
    apiVersion: cfg.apiVersion ?? '7.1',
  };
}

function buildWiqlFilters(cfg: AzureDevOpsConfig, state: Record<string, unknown>): string {
  const clauses: string[] = [];
  const workItemType = (state['filterWorkItemType'] as string | undefined) ?? cfg.workItemType;
  const workItemState = (state['filterWorkItemState'] as string | undefined) ?? cfg.workItemState;
  const assignedTo = (state['filterAssignedTo'] as string | undefined) ?? cfg.assignedTo;

  if (workItemType) clauses.push(`[System.WorkItemType] = '${workItemType}'`);
  if (workItemState) clauses.push(`[System.State] = '${workItemState}'`);
  if (assignedTo) clauses.push(`[System.AssignedTo] = '${assignedTo}'`);

  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
}

// ─── Deep-fetch helpers ───────────────────────────────────────────────────────

async function fetchItemComments(
  itemId: number,
  http: AxiosInstance,
  project: string,
  commentsApiVersion: string,
): Promise<string[]> {
  const res = await http.get<CommentsResponse>(
    `/${project}/_apis/wit/workItems/${itemId}/comments?api-version=${commentsApiVersion}`,
  );
  return res.data.comments.map((c) => c.text);
}

async function fetchParentContext(
  parentUrl: string,
  http: AxiosInstance,
  project: string,
  apiVersion: string,
  commentsApiVersion: string,
): Promise<{ parentId: string; parentTitle: string; parentDescription: string; parentComments: string[] }> {
  const parentId = parentUrl.split('/').pop() ?? '';

  const detailRes = await http.get<WorkItemDetailResponse>(
    `/${project}/_apis/wit/workItems?ids=${parentId}&$expand=all&api-version=${apiVersion}`,
  );
  const parentFields = detailRes.data.value[0]?.fields ?? {};
  const parentTitle = parentFields['System.Title'] ?? '';
  const parentDescription = parentFields['System.Description'] ?? '';
  const parentComments = await fetchItemComments(Number(parentId), http, project, commentsApiVersion);

  return { parentId, parentTitle, parentDescription, parentComments };
}

async function fetchDeepWorkItem(
  raw: RawWorkItem,
  http: AxiosInstance,
  project: string,
  apiVersion: string,
  commentsApiVersion: string,
): Promise<WorkItem> {
  const base = mapToWorkItem(raw);
  const comments = await fetchItemComments(raw.id, http, project, commentsApiVersion);

  const parentRelation = raw.relations?.find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
  if (!parentRelation) {
    return { ...base, comments };
  }

  const { parentId, parentTitle, parentDescription, parentComments } = await fetchParentContext(
    parentRelation.url, http, project, apiVersion, commentsApiVersion,
  );

  return { ...base, comments, parentId, parentTitle, parentDescription, parentComments };
}

// ─── Action implementations ───────────────────────────────────────────────────

async function fetchWorkItems(ctx: SkillContext): Promise<void> {
  const { http, project, apiVersion } = requireAdoConfig(ctx);
  const rawCfg = ctx.config.azureDevOps!;

  const filters = buildWiqlFilters(rawCfg, ctx.state);
  const wiql = {
    query: `SELECT [System.Id] FROM WorkItems
            WHERE [System.TeamProject] = '${rawCfg.project}'${filters}
            ORDER BY [Microsoft.VSTS.Common.Priority] DESC`,
  };

  const queryRes = await http.post<WiqlResponse>(
    `/${project}/_apis/wit/wiql?api-version=${apiVersion}`,
    wiql,
  );

  if (queryRes.data.workItems.length === 0) {
    ctx.state['workItems'] = [];
    ctx.logger.info('No work items found.');
    return;
  }

  const firstId = queryRes.data.workItems[0]!.id;
  const detailRes = await http.get<WorkItemDetailResponse>(
    `/${project}/_apis/wit/workItems?ids=${firstId}&api-version=${apiVersion}`,
  );

  ctx.state['workItems'] = detailRes.data.value.map(mapToWorkItem);
  ctx.logger.info('Fetched 1 work item.');
}

async function fetchWorkItemDetails(ctx: SkillContext): Promise<void> {
  const { http, project, apiVersion } = requireAdoConfig(ctx);
  const commentsApiVersion = `${apiVersion}-preview.3`;
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];

  if (workItems.length === 0) {
    ctx.logger.info('No work items to fetch details for.');
    return;
  }

  const ids = workItems.map((wi) => wi.id).join(',');
  const detailRes = await http.get<WorkItemDetailResponse>(
    `/${project}/_apis/wit/workItems?ids=${ids}&$expand=all&api-version=${apiVersion}`,
  );

  ctx.state['workItems'] = await Promise.all(
    detailRes.data.value.map((raw) => fetchDeepWorkItem(raw, http, project, apiVersion, commentsApiVersion)),
  );

  ctx.logger.info(`Fetched full details for ${workItems.length} work item(s).`);
}

async function createPullRequests(ctx: SkillContext): Promise<void> {
  if (ctx.config.dryRun) {
    ctx.logger.info('[dry-run] Skipping pull request creation.');
    return;
  }

  const { http, project, apiVersion } = requireAdoConfig(ctx);
  const branches = (ctx.state['pushedBranches'] ?? []) as FeatureBranchState[];
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];

  if (branches.length === 0) {
    ctx.logger.info('No pushed branches — skipping pull request creation.');
    ctx.state['pullRequests'] = [];
    return;
  }
  const pullRequests: PullRequest[] = [];

  const repoRes = await http.get<RepoListResponse>(
    `/${project}/_apis/git/repositories?api-version=${apiVersion}`,
  );

  for (const branch of branches) {
    const repo = repoRes.data.value.find((r) => r.name === branch.repositoryName);
    if (!repo) continue;

    const workItem = workItems.find((w) => w.id === branch.workItemId);
    const title = workItem ? `feat: ${workItem.title}` : `feat: ${branch.name}`;

    const prRes = await http.post<AzurePR>(
      `/${project}/_apis/git/repositories/${repo.id}/pullRequests?api-version=${apiVersion}`,
      {
        sourceRefName: `refs/heads/${branch.name}`,
        targetRefName: `refs/heads/${branch.baseBranch}`,
        title,
        description: workItem?.description ?? '',
        ...(workItem && { workItemRefs: [{ id: workItem.id }] }),
      },
    );

    pullRequests.push({
      id: String(prRes.data.pullRequestId),
      title: prRes.data.title,
      url: prRes.data.url,
      sourceBranch: branch.name,
      targetBranch: branch.baseBranch,
      repositoryName: repo.name,
    });
  }

  ctx.state['pullRequests'] = pullRequests;
  ctx.logger.info(`Created ${pullRequests.length} pull request(s).`);
}

async function updateWorkItemState(ctx: SkillContext): Promise<void> {
  if (ctx.config.dryRun) {
    ctx.logger.info('[dry-run] Skipping work item state update.');
    return;
  }

  const { http, project, apiVersion } = requireAdoConfig(ctx);
  const cfg = ctx.config.azureDevOps!;
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];

  if (workItems.length === 0) {
    ctx.logger.info('No work items to update.');
    return;
  }

  const hasPullRequests = Array.isArray(ctx.state['pullRequests']) && (ctx.state['pullRequests'] as unknown[]).length > 0;
  const targetState = hasPullRequests
    ? (cfg.completedState ?? 'Done')
    : (cfg.inProgressState ?? 'In Progress');

  const patch = [{ op: 'add', path: '/fields/System.State', value: targetState }];

  await Promise.all(
    workItems.map((wi) =>
      http.patch(
        `/${project}/_apis/wit/workItems/${wi.id}?api-version=${apiVersion}`,
        patch,
        { headers: { 'Content-Type': 'application/json-patch+json' } },
      ),
    ),
  );

  ctx.logger.info(`Updated ${workItems.length} work item(s) to state "${targetState}".`);
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapToWorkItem(raw: RawWorkItem): WorkItem {
  const f = raw.fields;
  return {
    id: String(raw.id),
    title: f['System.Title'] ?? '',
    description: f['System.Description'] ?? '',
    acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '',
    type: (f['System.WorkItemType']?.toLowerCase() ?? 'task') as WorkItemType,
    state: (f['System.State']?.toLowerCase() ?? 'new') as WorkItemState,
    tags: (f['System.Tags'] ?? '').split(';').map((t: string) => t.trim()).filter(Boolean),
    repositoryHints: [],
  };
}

// ─── Parameterised action implementations ─────────────────────────────────────

async function fetchWorkItemByIdDetails(id: number, ctx: SkillContext): Promise<void> {
  const { http, project, apiVersion } = requireAdoConfig(ctx);
  const commentsApiVersion = `${apiVersion}-preview.3`;

  const detailRes = await http.get<WorkItemDetailResponse>(
    `/${project}/_apis/wit/workItems?ids=${id}&$expand=all&api-version=${apiVersion}`,
  );

  const raw = detailRes.data.value[0];
  if (!raw) {
    throw new Error(`Work item ${id} not found in Azure DevOps.`);
  }

  const workItem = await fetchDeepWorkItem(raw, http, project, apiVersion, commentsApiVersion);
  ctx.state['workItems'] = [workItem];
  ctx.logger.info(`Fetched full details for work item ${id}.`);
}

// ─── Skill registration ───────────────────────────────────────────────────────

export function register(registry: SkillRegistry): void {
  registry.skill('azure-devops', (r) => {
    r.register('fetch work items from Azure DevOps', 'Fetches the highest-priority work item from Azure DevOps using WIQL.', () => fetchWorkItems);
    r.register('fetch work item details from Azure DevOps', 'Enriches work items with full details including comments and parent context.', () => fetchWorkItemDetails);
    r.register('fetch work item {id} details from Azure DevOps', 'Fetches full details for a single work item by ID, including comments and parent context.', (params: Record<string, string>) => async (ctx: SkillContext) => {
      await fetchWorkItemByIdDetails(Number(params['id']), ctx);
    });
    r.register('update work item state in Azure DevOps', 'Transitions work items to In Progress or Done based on whether pull requests exist.', () => updateWorkItemState);
    r.register('create pull requests in Azure DevOps', 'Creates a pull request for each pushed feature branch.', () => createPullRequests);
  });
}

// ─── Private API shape types ──────────────────────────────────────────────────

interface WiqlResponse { workItems: Array<{ id: number }>; }
interface WorkItemRelation { rel: string; url: string; }
interface RawWorkItem { id: number; fields: Record<string, string>; relations?: WorkItemRelation[]; }
interface WorkItemDetailResponse { value: RawWorkItem[]; }
interface CommentsResponse { comments: Array<{ text: string }>; }
interface RepoListResponse { value: Array<{ id: string; name: string }>; }
interface AzurePR { pullRequestId: number; title: string; url: string; }
interface FeatureBranchState { name: string; repositoryName: string; baseBranch: string; workItemId: string; }

