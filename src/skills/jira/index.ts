import axios, { type AxiosInstance } from 'axios';
import type { SkillContext } from '../../core/interfaces/ISkill.js';
import type { SkillRegistry } from '../../core/SkillRegistry.js';
import type { WorkItem, WorkItemState, WorkItemType } from '../../core/types/index.js';
import type { JiraConfig } from '../../core/types/WorkflowConfig.js';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function createHttpClient(cfg: JiraConfig): AxiosInstance {
  const token = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  return axios.create({
    baseURL: cfg.baseUrl.replace(/\/$/, ''),
    headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
  });
}

function requireJiraConfig(ctx: SkillContext): { http: AxiosInstance; cfg: JiraConfig } {
  const cfg = ctx.config.jira;
  if (!cfg?.baseUrl || !cfg?.email || !cfg?.apiToken) {
    throw new Error('Missing required jira config (baseUrl, email, apiToken).');
  }
  return { http: createHttpClient(cfg), cfg };
}

// ─── JQL builder ──────────────────────────────────────────────────────────────

function buildJql(cfg: JiraConfig, state: Record<string, unknown>): string {
  const clauses: string[] = [];
  const workItemState = (state['filterWorkItemState'] as string | undefined) ?? cfg.inProgressState;
  const assignedTo = state['filterAssignedTo'] as string | undefined;

  if (cfg.projectKey) clauses.push(`project = "${cfg.projectKey}"`);
  if (workItemState) clauses.push(`status = "${workItemState}"`);
  if (assignedTo) clauses.push(`assignee = "${assignedTo}"`);

  return clauses.length > 0 ? clauses.join(' AND ') : 'ORDER BY created DESC';
}

// ─── Comment fetcher ───────────────────────────────────────────────────────────

async function fetchIssueComments(issueKey: string, http: AxiosInstance): Promise<string[]> {
  const res = await http.get<JiraCommentsResponse>(`/rest/api/3/issue/${issueKey}/comment`);
  return res.data.comments.map((c) => extractAdfText(c.body));
}

// ─── Action implementations ───────────────────────────────────────────────────

async function fetchJiraTickets(ctx: SkillContext): Promise<void> {
  const { http, cfg } = requireJiraConfig(ctx);
  const jql = buildJql(cfg, ctx.state);
  const fields = 'summary,description,issuetype,status,labels,components';

  const res = await http.get<JiraSearchResponse>(
    `/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=${fields}`,
  );

  ctx.state['workItems'] = res.data.issues.map(mapToWorkItem);
  ctx.logger.info(`Fetched ${res.data.issues.length} Jira ticket(s).`);
}

async function fetchJiraTicketById(issueKey: string, ctx: SkillContext): Promise<void> {
  const { http } = requireJiraConfig(ctx);
  const fields = 'summary,description,issuetype,status,labels,components';

  const res = await http.get<JiraIssue>(`/rest/api/3/issue/${issueKey}?fields=${fields}`);
  const comments = await fetchIssueComments(issueKey, http);

  ctx.state['workItems'] = [{ ...mapToWorkItem(res.data), comments }];
  ctx.logger.info(`Fetched Jira ticket ${issueKey}.`);
}

async function updateJiraTicketState(issueKey: string, ctx: SkillContext): Promise<void> {
  if (ctx.config.dryRun) {
    ctx.logger.info(`[dry-run] Skipping state transition for Jira ticket ${issueKey}.`);
    return;
  }

  const { http, cfg } = requireJiraConfig(ctx);
  const hasPrs = Array.isArray(ctx.state['pullRequests']) && (ctx.state['pullRequests'] as unknown[]).length > 0;
  const targetState = hasPrs ? (cfg.completedState ?? 'Done') : (cfg.inProgressState ?? 'In Progress');

  const transRes = await http.get<JiraTransitionsResponse>(`/rest/api/3/issue/${issueKey}/transitions`);
  const transition = transRes.data.transitions.find(
    (t) => t.name.toLowerCase() === targetState.toLowerCase(),
  );

  if (!transition) {
    const available = transRes.data.transitions.map((t) => t.name).join(', ');
    throw new Error(`Jira transition "${targetState}" not found for ${issueKey}. Available: ${available}`);
  }

  await http.post(`/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: transition.id } });
  ctx.logger.info(`Transitioned Jira ticket ${issueKey} to "${targetState}".`);
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapToWorkItem(issue: JiraIssue): WorkItem {
  const f = issue.fields;
  return {
    id: issue.key,
    title: f.summary ?? '',
    description: extractAdfText(f.description),
    type: mapIssueType(f.issuetype?.name ?? ''),
    state: mapIssueState(f.status?.name ?? ''),
    tags: f.labels ?? [],
    repositoryHints: (f.components ?? []).map((c) => c.name),
  };
}

function extractAdfText(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return '';
  const node = adf as { type?: string; text?: string; content?: unknown[] };
  if (node.type === 'text' && node.text) return node.text;
  return (node.content ?? []).map(extractAdfText).join('');
}

function mapIssueType(typeName: string): WorkItemType {
  const lower = typeName.toLowerCase();
  if (lower === 'bug') return 'bug';
  if (lower === 'epic') return 'epic';
  if (lower.includes('story')) return 'story';
  if (lower.includes('feature') || lower.includes('improvement')) return 'feature';
  return 'task';
}

function mapIssueState(statusName: string): WorkItemState {
  const lower = statusName.toLowerCase();
  if (lower.includes('progress') || lower === 'active') return 'active';
  if (lower === 'done' || lower === 'resolved') return 'resolved';
  if (lower === 'closed' || lower === 'cancelled') return 'closed';
  return 'new';
}

// ─── Skill registration ───────────────────────────────────────────────────────

export function register(registry: SkillRegistry): void {
  registry.skill('jira', (r) => {
    r.register('fetch jira tickets', 'Fetches Jira issues using JQL filtered by project, assignee, and state.', () => fetchJiraTickets);
    r.register('fetch jira tickets with state {state}', 'Fetches Jira issues filtered by the given status value (e.g. "In Progress", "Done").', (params) => async (ctx) => {
      ctx.state['filterWorkItemState'] = params['state'] ?? '';
      await fetchJiraTickets(ctx);
    });
    r.register('fetch jira ticket {id} details', 'Fetches full details for a single Jira issue by key, including comments.', (params) => async (ctx) => {
      await fetchJiraTicketById(params['id'] ?? '', ctx);
    });
    r.register('update jira ticket {id} state', 'Transitions a Jira issue to In Progress or Done based on whether pull requests exist.', (params) => async (ctx) => {
      await updateJiraTicketState(params['id'] ?? '', ctx);
    });
  });
}

// ─── Private API shape types ──────────────────────────────────────────────────

interface JiraIssueFields {
  summary: string;
  description: unknown;
  issuetype: { name: string };
  status: { name: string };
  labels: string[];
  components: Array<{ name: string }>;
}

interface JiraIssue { key: string; fields: JiraIssueFields; }
interface JiraSearchResponse { issues: JiraIssue[]; }
interface JiraComment { body: unknown; }
interface JiraCommentsResponse { comments: JiraComment[]; }
interface JiraTransition { id: string; name: string; }
interface JiraTransitionsResponse { transitions: JiraTransition[]; }

