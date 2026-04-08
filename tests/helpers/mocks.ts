import { vi } from 'vitest';
import type { ILogger } from '../../src/core/interfaces/ILogger.js';
import type { SkillContext } from '../../src/core/interfaces/ISkill.js';
import type { WorkItem, AffectedRepository, AnalysisResult, PullRequest } from '../../src/core/types/index.js';
import type { AppConfig } from '../../src/core/types/WorkflowConfig.js';

export const makeWorkItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-1',
  title: 'Add login feature',
  description: 'Implement OAuth2 login',
  type: 'feature',
  state: 'active',
  tags: [],
  repositoryHints: [],
  ...overrides,
});

export const makeRepository = (overrides: Partial<AffectedRepository> = {}): AffectedRepository => ({
  name: 'auth-service',
  localPath: '/tmp/repos/auth-service',
  defaultBranch: 'main',
  ...overrides,
});

export const makeAnalysisResult = (overrides: Partial<AnalysisResult> = {}): AnalysisResult => ({
  repositoryName: 'auth-service',
  summary: 'Need to add OAuth2 endpoints',
  suggestedChanges: ['Add /oauth/token endpoint'],
  estimatedComplexity: 'medium',
  ...overrides,
});

export const makePullRequest = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  id: 'PR-42',
  title: '[#WI-1] Add login feature',
  url: 'https://dev.azure.com/org/project/_git/auth-service/pullrequest/42',
  sourceBranch: 'feature/WI-1-add-login-feature',
  targetBranch: 'main',
  repositoryName: 'auth-service',
  ...overrides,
});

export const makeMockLogger = (): ILogger => ({
  level: 'debug',
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

export const makeContext = (
  stateOverrides: Record<string, unknown> = {},
  configOverrides: Partial<AppConfig> = {},
): SkillContext => ({
  logger: makeMockLogger(),
  config: configOverrides,
  state: { ...stateOverrides },
});

