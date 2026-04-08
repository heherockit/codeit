/**
 * A parsed representation of a `.job` file.
 */
export interface JobDefinition {
  readonly name: string;
  readonly loop: boolean;
  readonly techniques: readonly string[];
  /** Ordered list of variable names declared via the `VAR` keyword. */
  readonly varNames?: readonly string[];
}

/**
 * The shape of the global application configuration file (config.json).
 * All provider sections are optional; skills validate the presence of their
 * required config at runtime when they are invoked.
 */
export interface AppConfig {
  readonly logLevel?: LogLevel;
  /** Path to the journal log file. Directory is created automatically if it does not exist. */
  readonly logFile?: string;
  readonly dryRun?: boolean;
  readonly azureDevOps?: AzureDevOpsConfig;
  readonly git?: GitConfig;
  readonly augment?: AugmentConfig;
  readonly telegram?: TelegramConfig;
  readonly jira?: JiraConfig;
  readonly gitlab?: GitLabConfig;
  readonly github?: GitHubConfig;
}

export interface AzureDevOpsConfig {
  readonly organization: string;
  readonly project: string;
  readonly personalAccessToken: string;
  readonly apiVersion?: string;
  /** Optional WIQL filter: e.g. 'Task', 'Bug', 'User Story'. Can be overridden via ctx.state['filterWorkItemType']. */
  readonly workItemType?: string;
  /** Optional WIQL filter: e.g. 'Active', 'New'. Can be overridden via ctx.state['filterWorkItemState']. */
  readonly workItemState?: string;
  /** Optional WIQL filter: e.g. 'john@example.com'. Can be overridden via ctx.state['filterAssignedTo']. */
  readonly assignedTo?: string;
  /** State to set when work begins (e.g. 'In Progress'). Defaults to 'In Progress'. */
  readonly inProgressState?: string;
  /** State to set when work is complete (e.g. 'Done'). Defaults to 'Done'. */
  readonly completedState?: string;
}

export interface GitConfig {
  readonly gitExecutable?: string;
  readonly workSpacePath?: string;
  /** Branch to checkout and pull before creating a feature branch (default: 'dev-sprint'). */
  readonly baseBranch?: string;
  /** Prefix used when naming feature branches (default: 'feature'). */
  readonly branchPrefix?: string;
}

export interface AugmentConfig {
  readonly cliPath?: string;
  readonly timeoutSeconds?: number;
  /** Model to pass to the Augment CLI via --model (e.g. "Opus 4.6"). */
  readonly model?: string;
}

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
  readonly pollTimeoutSeconds?: number;
}

export interface JiraConfig {
  readonly baseUrl: string;          // e.g. "https://your-org.atlassian.net"
  readonly email: string;            // Atlassian account email
  readonly apiToken: string;         // Atlassian API token (not password)
  readonly projectKey?: string;      // default project key, e.g. "ITM"
  readonly inProgressState?: string; // e.g. "In Progress"
  readonly completedState?: string;  // e.g. "Done"
}

export interface GitLabConfig {
  readonly baseUrl: string;           // e.g. "https://gitlab.com" or self-hosted URL
  readonly privateToken: string;      // GitLab personal access token
  readonly projectId?: string;        // default GitLab project ID or path, e.g. "123" or "group/project"
  readonly inProgressState?: string;  // e.g. "In Progress"
  readonly completedState?: string;   // e.g. "Closed"
}

export interface GitHubConfig {
  readonly token: string;             // GitHub personal access token or fine-grained token
  readonly owner: string;             // GitHub org or user, e.g. "my-org"
  readonly repo?: string;             // Default repository name, e.g. "my-repo"
  readonly inProgressState?: string;  // e.g. "open" (maps to GitHub issue state "open")
  readonly completedState?: string;   // e.g. "closed" (maps to GitHub issue state "closed")
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

