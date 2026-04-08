import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SkillContext } from '../../core/interfaces/ISkill.js';
import type { SkillRegistry } from '../../core/SkillRegistry.js';
import type { WorkItem, AffectedRepository } from '../../core/types/index.js';

const execAsync = promisify(exec);

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitExe(ctx: SkillContext): string {
  return ctx.config.git?.gitExecutable ?? 'git';
}

async function gitRun(git: string, cwd: string, subCmd: string): Promise<string> {
  try {
    await fs.access(cwd);
  } catch {
    throw new Error(`git ${subCmd} failed: directory does not exist: ${cwd}`);
  }

  const { stdout, stderr } = await execAsync(`${git} ${subCmd}`, { cwd });

  if (stderr) {
    const lower = stderr.toLowerCase();
    if (lower.includes('error') || lower.includes('fatal')) {
      throw new Error(`git ${subCmd} failed: ${stderr}`);
    }
  }

  return stdout.trim();
}

function branchName(prefix: string, workItemId: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  return `${prefix}/${workItemId}-${slug}`;
}

// ─── Action implementations ───────────────────────────────────────────────────

async function readWorkspaceDirs(basePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(basePath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function identifyRepositories(ctx: SkillContext): Promise<void> {
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];
  const basePath = ctx.config.git?.workSpacePath ?? process.cwd();

  const seen = new Set<string>();
  const repos: AffectedRepository[] = [];
  let workspaceDirs: string[] | undefined;

  for (const workItem of workItems) {
    let names: readonly string[];

    if (workItem.repositoryHints.length > 0) {
      names = workItem.repositoryHints;
    } else {
      workspaceDirs ??= await readWorkspaceDirs(basePath);
      names = workspaceDirs;
    }

    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);

      repos.push({ name, localPath: path.join(basePath, name), defaultBranch: 'main' });
    }
  }

  ctx.state['affectedRepositories'] = repos;
  ctx.logger.info(`Identified ${repos.length} affected repository/repositories.`);
}

async function findAvailableBranchName(git: string, cwd: string, base: string): Promise<string> {
  const existing = await gitRun(git, cwd, `branch --list ${base}`);
  if (!existing) return base;

  let suffix = 2;
  while (true) {
    const candidate = `${base}-${suffix}`;
    const taken = await gitRun(git, cwd, `branch --list ${candidate}`);
    if (!taken) return candidate;
    suffix++;
  }
}

async function createFeatureBranches(ctx: SkillContext): Promise<void> {
  const git = gitExe(ctx);
  const repos = (ctx.state['affectedRepositories'] ?? []) as AffectedRepository[];
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];
  const baseBranch = ctx.config.git?.baseBranch ?? 'dev-sprint';
  const branchPrefix = ctx.config.git?.branchPrefix ?? 'feature';
  const branches: FeatureBranchState[] = [];

  for (const repo of repos) {
    ctx.logger.info(`[git] Checking out '${baseBranch}' and pulling latest in '${repo.name}'…`);
    await gitRun(git, repo.localPath, `checkout ${baseBranch}`);
    await gitRun(git, repo.localPath, `pull origin ${baseBranch}`);

    for (const workItem of workItems) {
      const base = branchName(branchPrefix, workItem.id, workItem.title);

      const name = await findAvailableBranchName(git, repo.localPath, base);
      if (name !== base) {
        ctx.logger.info(`Branch '${base}' already exists in '${repo.name}' — using '${name}' instead.`);
      }

      await gitRun(git, repo.localPath, `checkout -b ${name}`);

      branches.push({ name, repositoryName: repo.name, baseBranch, workItemId: workItem.id });
      ctx.logger.info(`Created branch '${name}' from '${baseBranch}' in '${repo.name}'.`);
    }
  }

  ctx.state['featureBranches'] = branches;
}

async function commitAndPushChanges(ctx: SkillContext): Promise<void> {
  const git = gitExe(ctx);
  const repos = (ctx.state['affectedRepositories'] ?? []) as AffectedRepository[];
  const branches = (ctx.state['featureBranches'] ?? []) as FeatureBranchState[];
  const workItems = (ctx.state['workItems'] ?? []) as WorkItem[];
  const pushedBranches: FeatureBranchState[] = [];

  for (const repo of repos) {
    const repoBranches = branches.filter((b) => b.repositoryName === repo.name);

    for (const branch of repoBranches) {
      const workItem = workItems.find((w) => w.id === branch.workItemId);
      const message = workItem
        ? `feat(${workItem.id}): ${workItem.title}`
        : `feat: ${branch.name}`;

      await gitRun(git, repo.localPath, 'add -A');

      const status = await gitRun(git, repo.localPath, 'status --porcelain');
      if (!status) {
        ctx.logger.info(`No changes to commit in '${repo.name}' for branch '${branch.name}' — skipping.`);
        continue;
      }

      if (ctx.config.dryRun) {
        ctx.logger.info(`[dry-run] Skipping commit and push for '${branch.name}' in '${repo.name}'.`);
        continue;
      }

      await gitRun(git, repo.localPath, `commit -m "${message.replace(/"/g, '\\"')}"`);
      await gitRun(git, repo.localPath, `push --set-upstream origin ${branch.name}`);
      ctx.logger.info(`Committed and pushed '${branch.name}' in '${repo.name}'.`);
      pushedBranches.push(branch);
    }
  }

  ctx.state['pushedBranches'] = pushedBranches;
}

// ─── Skill registration ───────────────────────────────────────────────────────

export function register(registry: SkillRegistry): void {
  registry.skill('git', (r) => {
    r.register('identify affected repositories', 'Identifies repositories affected by the current work items.', () => identifyRepositories);
    r.register('create feature branches', 'Creates a feature branch for each work item in each affected repository.', () => createFeatureBranches);
    r.register('commit and push changes', 'Commits staged changes and pushes the feature branch to origin.', () => commitAndPushChanges);
  });
}

// ─── Private state shape ──────────────────────────────────────────────────────

interface FeatureBranchState { name: string; repositoryName: string; baseBranch: string; workItemId: string; }

