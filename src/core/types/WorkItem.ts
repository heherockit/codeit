/**
 * Represents a work item retrieved from a project management system.
 */
export interface WorkItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly type: WorkItemType;
  readonly state: WorkItemState;
  readonly tags: readonly string[];
  readonly repositoryHints: readonly string[];
  /** Acceptance criteria for the work item. Populated by deep fetch. */
  readonly acceptanceCriteria?: string;
  /** All comments posted on this work item. Populated by deep fetch. */
  readonly comments?: readonly string[];
  /** ID of the parent work item, if any. Populated by deep fetch. */
  readonly parentId?: string;
  /** Title of the parent work item. Populated by deep fetch. */
  readonly parentTitle?: string;
  /** Description of the parent work item. Populated by deep fetch. */
  readonly parentDescription?: string;
  /** All comments posted on the parent work item. Populated by deep fetch. */
  readonly parentComments?: readonly string[];
}

export type WorkItemType = 'bug' | 'feature' | 'task' | 'story' | 'epic';

export type WorkItemState = 'new' | 'active' | 'resolved' | 'closed';

/**
 * Represents a repository that needs to be modified for a work item.
 */
export interface AffectedRepository {
  readonly name: string;
  readonly localPath: string;
  readonly defaultBranch: string;
}

/**
 * Represents the result of an AI analysis on a repository.
 */
export interface AnalysisResult {
  readonly repositoryName: string;
  readonly summary: string;
  readonly suggestedChanges: readonly string[];
  readonly estimatedComplexity: 'low' | 'medium' | 'high';
}

/**
 * Represents a created feature branch.
 */
export interface FeatureBranch {
  readonly name: string;
  readonly repositoryName: string;
  readonly baseBranch: string;
}

/**
 * Represents a pull request created after implementing changes.
 */
export interface PullRequest {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly repositoryName: string;
}

