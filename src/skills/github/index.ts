import axios, { type AxiosInstance } from 'axios';
import type { SkillContext } from '../../core/interfaces/ISkill.js';
import type { SkillRegistry } from '../../core/SkillRegistry.js';
import type { WorkItem, WorkItemState, WorkItemType } from '../../core/types/index.js';
import type { GitHubConfig } from '../../core/types/WorkflowConfig.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function createHttpClient(cfg: GitHubConfig): AxiosInstance {
  return axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

function requireGitHubConfig(ctx: SkillContext): { http: AxiosInstance; cfg: GitHubConfig } {
  const cfg = ctx.config.github;
  if (!cfg?.token || !cfg?.owner) {
    throw new Error('Missing required github config (token, owner).');
  }
  return { http: createHttpClient(cfg), cfg };
}

function repoPath(cfg: GitHubConfig, repoOverride?: string): string {
  const repo = repoOverride ?? cfg.repo ?? '';
  return `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(repo)}`;
}

// ─── Query params builder ─────────────────────────────────────────────────────

function buildIssueParams(cfg: GitHubConfig, ctxState: Record<string, unknown>, stateOverride?: string): URLSearchParams {
  const params = new URLSearchParams();
  const filterState = stateOverride ?? (ctxState['filterWorkItemState'] as string | undefined);
  const assignee = ctxState['filterAssignedTo'] as string | undefined;

  const ghState = resolveGitHubState(filterState ?? cfg.inProgressState);
  params.set('state', ghState ?? 'open');
  params.set('per_page', '50');
  if (assignee) params.set('assignee', assignee);

  return params;
}

function resolveGitHubState(state: string | undefined): 'open' | 'closed' | 'all' | undefined {
  if (!state) return undefined;
  const lower = state.toLowerCase();
  if (lower === 'open' || lower.includes('progress') || lower === 'active') return 'open';
  if (lower === 'closed' || lower === 'done' || lower === 'resolved') return 'closed';
  return 'all';
}

// ─── Comments fetcher ─────────────────────────────────────────────────────────

async function fetchIssueComments(base: string, issueNumber: string, http: AxiosInstance): Promise<string[]> {
  const res = await http.get<GitHubComment[]>(`${base}/issues/${issueNumber}/comments`);
  return res.data.map((c) => c.body).filter(Boolean);
}

// ─── Action implementations ───────────────────────────────────────────────────

async function fetchGitHubIssues(ctx: SkillContext, state?: string): Promise<void> {
  const { http, cfg } = requireGitHubConfig(ctx);
  const base = repoPath(cfg);
  const params = buildIssueParams(cfg, ctx.state, state);

  const res = await http.get<GitHubIssue[]>(`${base}/issues?${params.toString()}`);

  // GitHub returns PRs in the issues endpoint; filter them out.
  const issues = res.data.filter((i) => !i.pull_request);
  ctx.state['workItems'] = issues.map(mapToWorkItem);
  ctx.logger.info(`Fetched ${issues.length} GitHub issue(s).`);
}

async function fetchGitHubIssueById(ctx: SkillContext, id?: string): Promise<void> {
  const { http, cfg } = requireGitHubConfig(ctx);
  const issueNumber = id ?? '';
  const base = repoPath(cfg);

  const res = await http.get<GitHubIssue>(`${base}/issues/${issueNumber}`);
  const comments = await fetchIssueComments(base, issueNumber, http);

  ctx.state['workItems'] = [{ ...mapToWorkItem(res.data), comments }];
  ctx.logger.info(`Fetched GitHub issue #${issueNumber}.`);
}

async function updateGitHubIssueState(ctx: SkillContext, id?: string): Promise<void> {
  const issueNumber = id ?? '';

  if (ctx.config.dryRun) {
    ctx.logger.info(`[dry-run] Skipping state update for GitHub issue #${issueNumber}.`);
    return;
  }

  const { http, cfg } = requireGitHubConfig(ctx);
  const base = repoPath(cfg);
  const hasPrs = Array.isArray(ctx.state['pullRequests']) && (ctx.state['pullRequests'] as unknown[]).length > 0;
  const targetState = hasPrs ? (cfg.completedState ?? 'closed') : (cfg.inProgressState ?? 'open');
  const ghState = resolveGitHubState(targetState) ?? 'open';

  await http.patch(`${base}/issues/${issueNumber}`, { state: ghState });
  ctx.logger.info(`Updated GitHub issue #${issueNumber} to state "${ghState}".`);
}

async function createGitHubPullRequest(ctx: SkillContext, id?: string): Promise<void> {
  const issueNumber = id ?? '';

  if (ctx.config.dryRun) {
    ctx.logger.info(`[dry-run] Skipping pull request creation for GitHub issue #${issueNumber}.`);
    return;
  }

  const { http, cfg } = requireGitHubConfig(ctx);
  const base = repoPath(cfg);
  const branches = (ctx.state['featureBranches'] ?? []) as FeatureBranchState[];
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];

  const branch = branches.find((b) => b.workItemId === issueNumber);
  const workItem = workItems.find((w) => w.id === issueNumber);

  if (!branch) {
    throw new Error(`No feature branch found in state for GitHub issue #${issueNumber}.`);
  }

  const title = workItem ? `feat: [#${issueNumber}] ${workItem.title}` : `feat: issue-${issueNumber}`;
  const payload = {
    title,
    body: workItem?.description ?? '',
    head: branch.name,
    base: branch.baseBranch,
    draft: true,
  };

  const res = await http.post<GitHubPullRequest>(`${base}/pulls`, payload);
  ctx.logger.info(`Created GitHub PR #${res.data.number}: ${res.data.title}`);

  const existing = (ctx.state['pullRequests'] ?? []) as GitHubPullRequest[];
  ctx.state['pullRequests'] = [...existing, res.data];
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapToWorkItem(issue: GitHubIssue): WorkItem {
  return {
    id: String(issue.number),
    title: issue.title ?? '',
    description: issue.body ?? '',
    type: mapIssueType(issue.labels),
    state: mapIssueState(issue.state ?? ''),
    tags: issue.labels.map((l) => l.name),
    repositoryHints: [],
  };
}

function mapIssueType(labels: GitHubLabel[]): WorkItemType {
  const names = labels.map((l) => l.name.toLowerCase());
  if (names.some((n) => n === 'bug')) return 'bug';
  if (names.some((n) => n === 'epic')) return 'epic';
  if (names.some((n) => n.includes('story'))) return 'story';
  if (names.some((n) => n.includes('feature') || n.includes('enhancement'))) return 'feature';
  return 'task';
}

function mapIssueState(stateName: string): WorkItemState {
  if (stateName === 'open') return 'active';
  if (stateName === 'closed') return 'closed';
  return 'new';
}

// ─── Skill registration ───────────────────────────────────────────────────────

export function register(registry: SkillRegistry): void {
  registry.skill('github', (r) => {
    r.register('fetch github issues', 'Fetches GitHub issues filtered by state and assignee.', fetchGitHubIssues);
    r.register('fetch github issues with state {state}', 'Fetches GitHub issues filtered by the given state value (e.g. "open", "closed", "all").', fetchGitHubIssues);
    r.register('fetch github issue {id} details', 'Fetches full details for a single GitHub issue by number, including comments.', fetchGitHubIssueById);
    r.register('update github issue {id} state', 'Sets a GitHub issue to open or closed based on whether pull requests exist.', updateGitHubIssueState);
    r.register('create github pull request {id}', 'Creates a draft GitHub pull request for the given issue using the feature branch from state.', createGitHubPullRequest);
  });
}

// ─── Private API shape types ──────────────────────────────────────────────────

interface GitHubLabel { name: string; }
interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: GitHubLabel[];
  pull_request?: object;
}

interface GitHubComment { body: string; }
interface GitHubPullRequest { number: number; title: string; html_url: string; }
interface FeatureBranchState { name: string; repositoryName: string; baseBranch: string; workItemId: string; }

