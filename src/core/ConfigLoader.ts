import fs from 'node:fs';
import path from 'node:path';
import type {
  AppConfig, AzureDevOpsConfig, GitConfig, AugmentConfig, TraeConfig, TelegramConfig, JiraConfig, GitLabConfig, GitHubConfig, LogLevel,
} from './types/WorkflowConfig.js';

const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Loads application configuration from a `.env` file and/or `process.env`.
 */
export class ConfigLoader {
  /**
   * Parse a `.env` file and merge its values into `process.env`.
   * Lines starting with `#` and blank lines are ignored.
   * Already-set environment variables are not overridden (shell wins over file).
   */
  loadEnvFile(filePath: string): void {
    const resolved = path.resolve(filePath);
    const lines = fs.readFileSync(resolved, 'utf-8').split('\n');

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq < 1) continue;

      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

      if (process.env[key] === undefined) process.env[key] = val;
    }
  }

  /**
   * Build an `AppConfig` from environment variables.
   * Each config section is omitted when none of its env vars are present.
   * @param env - Defaults to `process.env`; pass a custom object in tests.
   */
  loadFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const logLevel = env['LOG_LEVEL'] as LogLevel | undefined;
    if (logLevel !== undefined && !VALID_LOG_LEVELS.includes(logLevel)) {
      throw new Error(`LOG_LEVEL must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
    }

    return {
      ...(logLevel !== undefined && { logLevel }),
      ...(env['LOG_FILE'] !== undefined && { logFile: env['LOG_FILE'] }),
      ...(env['DRY_RUN'] !== undefined && { dryRun: env['DRY_RUN'] === 'true' }),
      ...buildAdoSection(env),
      ...buildGitSection(env),
      ...buildAugmentSection(env),
      ...buildTraeSection(env),
      ...buildTelegramSection(env),
      ...buildJiraSection(env),
      ...buildGitLabSection(env),
      ...buildGitHubSection(env),
    } as AppConfig;
  }

  /**
   * Resolve the job file path from a job name.
   * Looks in `jobs/<name>.job` relative to `projectRoot`.
   */
  resolveJobPath(jobName: string, projectRoot: string): string {
    const candidate = path.join(projectRoot, 'jobs', `${jobName}.job`);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Job '${jobName}' not found. Expected: ${candidate}`);
    }
    return candidate;
  }
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildAdoSection(env: NodeJS.ProcessEnv): { azureDevOps: AzureDevOpsConfig } | object {
  const org = env['AZURE_DEVOPS_ORGANIZATION'];
  const project = env['AZURE_DEVOPS_PROJECT'];
  const pat = env['AZURE_DEVOPS_PAT'];
  if (!org && !project && !pat) return {};

  return {
    azureDevOps: {
      organization: org ?? '',
      project: project ?? '',
      personalAccessToken: pat ?? '',
      ...(env['AZURE_DEVOPS_API_VERSION'] !== undefined && { apiVersion: env['AZURE_DEVOPS_API_VERSION'] }),
      ...(env['AZURE_DEVOPS_WORK_ITEM_TYPE'] !== undefined && { workItemType: env['AZURE_DEVOPS_WORK_ITEM_TYPE'] }),
      ...(env['AZURE_DEVOPS_WORK_ITEM_STATE'] !== undefined && { workItemState: env['AZURE_DEVOPS_WORK_ITEM_STATE'] }),
      ...(env['AZURE_DEVOPS_ASSIGNED_TO'] !== undefined && { assignedTo: env['AZURE_DEVOPS_ASSIGNED_TO'] }),
      ...(env['AZURE_DEVOPS_IN_PROGRESS_STATE'] !== undefined && { inProgressState: env['AZURE_DEVOPS_IN_PROGRESS_STATE'] }),
      ...(env['AZURE_DEVOPS_COMPLETED_STATE'] !== undefined && { completedState: env['AZURE_DEVOPS_COMPLETED_STATE'] }),
    } as AzureDevOpsConfig,
  };
}

function buildGitSection(env: NodeJS.ProcessEnv): { git: GitConfig } | object {
  const keys = ['GIT_EXECUTABLE', 'GIT_WORKSPACE_PATH', 'GIT_BASE_BRANCH', 'GIT_BRANCH_PREFIX'];
  if (keys.every((k) => env[k] === undefined)) return {};

  return {
    git: {
      ...(env['GIT_EXECUTABLE'] !== undefined && { gitExecutable: env['GIT_EXECUTABLE'] }),
      ...(env['GIT_WORKSPACE_PATH'] !== undefined && { workSpacePath: env['GIT_WORKSPACE_PATH'] }),
      ...(env['GIT_BASE_BRANCH'] !== undefined && { baseBranch: env['GIT_BASE_BRANCH'] }),
      ...(env['GIT_BRANCH_PREFIX'] !== undefined && { branchPrefix: env['GIT_BRANCH_PREFIX'] }),
    } as GitConfig,
  };
}

function buildAugmentSection(env: NodeJS.ProcessEnv): { augment: AugmentConfig } | object {
  const keys = ['AUGMENT_CLI_PATH', 'AUGMENT_TIMEOUT_SECONDS', 'AUGMENT_MODEL'];
  if (keys.every((k) => env[k] === undefined)) return {};

  return {
    augment: {
      ...(env['AUGMENT_CLI_PATH'] !== undefined && { cliPath: env['AUGMENT_CLI_PATH'] }),
      ...(env['AUGMENT_TIMEOUT_SECONDS'] !== undefined && { timeoutSeconds: Number(env['AUGMENT_TIMEOUT_SECONDS']) }),
      ...(env['AUGMENT_MODEL'] !== undefined && { model: env['AUGMENT_MODEL'] }),
    } as AugmentConfig,
  };
}

function buildTraeSection(env: NodeJS.ProcessEnv): { trae: TraeConfig } | object {
  const keys = ['TRAE_CLI_PATH', 'TRAE_TIMEOUT_SECONDS', 'TRAE_MODEL', 'TRAE_EXTRA_ARGS'];
  if (keys.every((k) => env[k] === undefined)) return {};

  const extraArgs = env['TRAE_EXTRA_ARGS']
    ?.split(',')
    .map((value: string) => value.trim())
    .filter(Boolean);

  return {
    trae: {
      ...(env['TRAE_CLI_PATH'] !== undefined && { cliPath: env['TRAE_CLI_PATH'] }),
      ...(env['TRAE_TIMEOUT_SECONDS'] !== undefined && { timeoutSeconds: Number(env['TRAE_TIMEOUT_SECONDS']) }),
      ...(env['TRAE_MODEL'] !== undefined && { model: env['TRAE_MODEL'] }),
      ...(extraArgs !== undefined && { extraArgs }),
    } as TraeConfig,
  };
}

function buildTelegramSection(env: NodeJS.ProcessEnv): { telegram: TelegramConfig } | object {
  const botToken = env['TELEGRAM_BOT_TOKEN'];
  const chatId = env['TELEGRAM_CHAT_ID'];
  if (!botToken && !chatId) return {};

  return {
    telegram: {
      botToken: botToken ?? '',
      chatId: chatId ?? '',
      ...(env['TELEGRAM_POLL_TIMEOUT_SECONDS'] !== undefined && {
        pollTimeoutSeconds: Number(env['TELEGRAM_POLL_TIMEOUT_SECONDS']),
      }),
    } as TelegramConfig,
  };
}

function buildGitLabSection(env: NodeJS.ProcessEnv): { gitlab: GitLabConfig } | object {
  const baseUrl = env['GITLAB_BASE_URL'];
  const privateToken = env['GITLAB_PRIVATE_TOKEN'];
  if (!baseUrl && !privateToken) return {};

  return {
    gitlab: {
      baseUrl: baseUrl ?? '',
      privateToken: privateToken ?? '',
      ...(env['GITLAB_PROJECT_ID'] !== undefined && { projectId: env['GITLAB_PROJECT_ID'] }),
      ...(env['GITLAB_IN_PROGRESS_STATE'] !== undefined && { inProgressState: env['GITLAB_IN_PROGRESS_STATE'] }),
      ...(env['GITLAB_COMPLETED_STATE'] !== undefined && { completedState: env['GITLAB_COMPLETED_STATE'] }),
    } as GitLabConfig,
  };
}

function buildGitHubSection(env: NodeJS.ProcessEnv): { github: GitHubConfig } | object {
  const token = env['GITHUB_TOKEN'];
  const owner = env['GITHUB_OWNER'];
  if (!token && !owner) return {};

  return {
    github: {
      token: token ?? '',
      owner: owner ?? '',
      ...(env['GITHUB_REPO'] !== undefined && { repo: env['GITHUB_REPO'] }),
      ...(env['GITHUB_IN_PROGRESS_STATE'] !== undefined && { inProgressState: env['GITHUB_IN_PROGRESS_STATE'] }),
      ...(env['GITHUB_COMPLETED_STATE'] !== undefined && { completedState: env['GITHUB_COMPLETED_STATE'] }),
    } as GitHubConfig,
  };
}

function buildJiraSection(env: NodeJS.ProcessEnv): { jira: JiraConfig } | object {
  const baseUrl = env['JIRA_BASE_URL'];
  const email = env['JIRA_EMAIL'];
  const apiToken = env['JIRA_API_TOKEN'];
  if (!baseUrl && !email && !apiToken) return {};

  return {
    jira: {
      baseUrl: baseUrl ?? '',
      email: email ?? '',
      apiToken: apiToken ?? '',
      ...(env['JIRA_PROJECT_KEY'] !== undefined && { projectKey: env['JIRA_PROJECT_KEY'] }),
      ...(env['JIRA_IN_PROGRESS_STATE'] !== undefined && { inProgressState: env['JIRA_IN_PROGRESS_STATE'] }),
      ...(env['JIRA_COMPLETED_STATE'] !== undefined && { completedState: env['JIRA_COMPLETED_STATE'] }),
    } as JiraConfig,
  };
}
