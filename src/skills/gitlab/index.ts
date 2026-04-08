import axios, { type AxiosInstance } from 'axios';
import type { SkillContext } from '../../core/interfaces/ISkill.js';
import type { SkillRegistry } from '../../core/SkillRegistry.js';
import type { WorkItem, WorkItemState, WorkItemType } from '../../core/types/index.js';
import type { GitLabConfig } from '../../core/types/WorkflowConfig.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function createHttpClient(cfg: GitLabConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.baseUrl.replace(/\/$/, ''),
    headers: { 'PRIVATE-TOKEN': cfg.privateToken, 'Content-Type': 'application/json' },
  });
}

function requireGitLabConfig(ctx: SkillContext): { http: AxiosInstance; cfg: GitLabConfig } {
  const cfg = ctx.config.gitlab;
  if (!cfg?.baseUrl || !cfg?.privateToken) {
    throw new Error('Missing required gitlab config (baseUrl, privateToken).');
  }
  return { http: createHttpClient(cfg), cfg };
}

// ─── Query params builder ─────────────────────────────────────────────────────

function buildIssueParams(cfg: GitLabConfig, state: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const filterState = state['filterWorkItemState'] as string | undefined;
  const assignee = state['filterAssignedTo'] as string | undefined;

  const gitlabState = resolveGitLabState(filterState ?? cfg.inProgressState);
  if (gitlabState) params.set('state', gitlabState);
  if (assignee) params.set('assignee_username', assignee);

  return params;
}

function resolveGitLabState(state: string | undefined): string | undefined {
  if (!state) return undefined;
  const lower = state.toLowerCase();
  if (lower === 'open' || lower.includes('progress') || lower === 'active') return 'opened';
  if (lower === 'closed' || lower === 'done' || lower === 'resolved') return 'closed';
  return undefined;
}

// ─── Notes fetcher ────────────────────────────────────────────────────────────

async function fetchIssueNotes(projectId: string, issueIid: string, http: AxiosInstance): Promise<string[]> {
  const res = await http.get<GitLabNote[]>(`/api/v4/projects/${encodeURIComponent(projectId)}/issues/${issueIid}/notes`);
  return res.data.map((n) => n.body).filter(Boolean);
}

// ─── Action implementations ───────────────────────────────────────────────────

async function fetchGitLabIssues(ctx: SkillContext): Promise<void> {
  const { http, cfg } = requireGitLabConfig(ctx);
  const projectId = cfg.projectId ?? '';
  const params = buildIssueParams(cfg, ctx.state);
  const query = params.toString() ? `?${params.toString()}` : '';

  const res = await http.get<GitLabIssue[]>(`/api/v4/projects/${encodeURIComponent(projectId)}/issues${query}`);
  ctx.state['workItems'] = res.data.map(mapToWorkItem);
  ctx.logger.info(`Fetched ${res.data.length} GitLab issue(s).`);
}

async function fetchGitLabIssueById(issueIid: string, ctx: SkillContext): Promise<void> {
  const { http, cfg } = requireGitLabConfig(ctx);
  const projectId = cfg.projectId ?? '';

  const res = await http.get<GitLabIssue>(`/api/v4/projects/${encodeURIComponent(projectId)}/issues/${issueIid}`);
  const comments = await fetchIssueNotes(projectId, issueIid, http);

  ctx.state['workItems'] = [{ ...mapToWorkItem(res.data), comments }];
  ctx.logger.info(`Fetched GitLab issue #${issueIid}.`);
}

async function createGitLabMergeRequest(issueIid: string, ctx: SkillContext): Promise<void> {
  if (ctx.config.dryRun) {
    ctx.logger.info(`[dry-run] Skipping merge request creation for GitLab issue #${issueIid}.`);
    return;
  }

  const { http, cfg } = requireGitLabConfig(ctx);
  const projectId = cfg.projectId ?? '';

  const branches = (ctx.state['featureBranches'] ?? []) as FeatureBranchState[];
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];

  const branch = branches.find((b) => b.workItemId === issueIid);
  const workItem = workItems.find((w) => w.id === issueIid);

  if (!branch) {
    throw new Error(`No feature branch found in state for issue #${issueIid}.`);
  }

  const title = workItem ? `Draft: [#${issueIid}] ${workItem.title}` : `Draft: issue-${issueIid}`;
  const payload = {
    source_branch: branch.name,
    target_branch: branch.baseBranch,
    title,
    remove_source_branch: true,
  };

  const res = await http.post<GitLabMergeRequest>(`/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`, payload);
  ctx.logger.info(`Created GitLab MR !${res.data.iid}: ${res.data.title}`);

  const existing = (ctx.state['mergeRequests'] ?? []) as GitLabMergeRequest[];
  ctx.state['mergeRequests'] = [...existing, res.data];
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapToWorkItem(issue: GitLabIssue): WorkItem {
  return {
    id: String(issue.iid),
    title: issue.title ?? '',
    description: issue.description ?? '',
    type: mapIssueType(issue.type ?? issue.issue_type ?? ''),
    state: mapIssueState(issue.state ?? ''),
    tags: issue.labels ?? [],
    repositoryHints: [],
  };
}

function mapIssueType(typeName: string): WorkItemType {
  const lower = typeName.toLowerCase();
  if (lower === 'bug' || lower === 'incident') return 'bug';
  if (lower === 'epic') return 'epic';
  if (lower.includes('story')) return 'story';
  if (lower.includes('feature') || lower.includes('improvement')) return 'feature';
  return 'task';
}

function mapIssueState(stateName: string): WorkItemState {
  const lower = stateName.toLowerCase();
  if (lower === 'opened') return 'active';
  if (lower === 'closed') return 'closed';
  return 'new';
}

// ─── Skill registration ───────────────────────────────────────────────────────

export function register(registry: SkillRegistry): void {
  registry.skill('gitlab', (r) => {
    r.register('fetch gitlab issues', 'Fetches GitLab issues filtered by state and assignee.', () => fetchGitLabIssues);
    r.register('fetch gitlab issues with state {state}', 'Fetches GitLab issues filtered by the given state value (e.g. "opened", "closed").', (params) => async (ctx) => {
      ctx.state['filterWorkItemState'] = params['state'] ?? '';
      await fetchGitLabIssues(ctx);
    });
    r.register('fetch gitlab issue {id} details', 'Fetches full details for a single GitLab issue by IID, including notes.', (params) => async (ctx) => {
      await fetchGitLabIssueById(params['id'] ?? '', ctx);
    });
    r.register('create gitlab merge request {id}', 'Creates a GitLab merge request for the given issue IID using the feature branch from state.', (params) => async (ctx) => {
      await createGitLabMergeRequest(params['id'] ?? '', ctx);
    });
  });
}

// ─── Private API shape types ──────────────────────────────────────────────────

interface GitLabIssue {
  iid: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  type?: string;
  issue_type?: string;
}

interface GitLabNote { body: string; }
interface GitLabMergeRequest { iid: number; title: string; web_url: string; }
interface FeatureBranchState { name: string; repositoryName: string; baseBranch: string; workItemId: string; }

