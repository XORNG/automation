import { Octokit } from '@octokit/rest';
import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';
import crypto from 'crypto';

/**
 * Issue data structure
 */
export interface IssueData {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string; color: string }>;
  author: string;
  repository: string;
  repositoryOwner: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Processing task
 */
export interface ProcessingTask {
  id: string;
  type: 'issue' | 'pr' | 'feedback';
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  priority: number;
  data: IssueData | unknown;
  createdAt: string;
  updatedAt: string;
  assignedTo?: string;  // workspaceId of assigned VS Code extension
  result?: unknown;
  error?: string;
}

/**
 * Processing configuration
 */
export interface IssueProcessorConfig {
  token: string;
  organization: string;
  logLevel?: string;
  // No label filtering - process all issues
  // No repository filtering - process all repositories
}

/**
 * IssueProcessor - Processes GitHub issues from all repositories
 * 
 * Features:
 * - Processes ALL issues regardless of labels (testing phase)
 * - Processes ALL repositories in the organization
 * - Queue-based task management for VS Code extension
 * - Event-driven architecture
 */
export class IssueProcessor extends EventEmitter {
  private octokit: Octokit;
  private logger: Logger;
  private config: IssueProcessorConfig;
  private taskQueue: Map<string, ProcessingTask> = new Map();

  constructor(config: IssueProcessorConfig) {
    super();
    this.config = config;
    this.octokit = new Octokit({
      auth: config.token,
    });
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'issue-processor',
    });
  }

  /**
   * Process an issue event from GitHub webhook
   * Note: Processes ALL issues - no label filtering for testing phase
   */
  async processIssueEvent(payload: {
    action: string;
    issue: IssueData;
    repository: { name: string; owner: { login: string } };
  }): Promise<ProcessingTask | null> {
    const { action, issue, repository } = payload;

    this.logger.info({
      action,
      issue: issue.number,
      repo: repository.name,
      labels: issue.labels.map(l => l.name),
    }, 'Processing issue event - ALL issues (no label filtering)');

    // Process all issues - no label filtering for testing phase
    // In the future, we can add filtering here when needed

    // Only process certain actions
    const processableActions = ['opened', 'reopened', 'labeled', 'edited'];
    if (!processableActions.includes(action)) {
      this.logger.debug({
        action,
        issue: issue.number,
      }, 'Skipping non-processable action');
      return null;
    }

    // Create processing task
    const task = this.createTask('issue', {
      ...issue,
      repository: repository.name,
      repositoryOwner: repository.owner.login,
    });

    // Emit event for processing
    this.emit('task:created', task);

    return task;
  }

  /**
   * Process a pull request event from GitHub webhook
   */
  async processPullRequestEvent(payload: {
    action: string;
    pull_request: {
      id: number;
      number: number;
      title: string;
      body: string | null;
      state: string;
      user: { login: string };
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string; sha: string };
    };
    repository: { name: string; owner: { login: string } };
  }): Promise<ProcessingTask | null> {
    const { action, pull_request: pr, repository } = payload;

    this.logger.info({
      action,
      pr: pr.number,
      repo: repository.name,
    }, 'Processing pull request event');

    // Only process certain actions
    const processableActions = ['opened', 'reopened', 'synchronize', 'ready_for_review'];
    if (!processableActions.includes(action)) {
      this.logger.debug({
        action,
        pr: pr.number,
      }, 'Skipping non-processable action');
      return null;
    }

    // Create processing task
    const task = this.createTask('pr', {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      author: pr.user.login,
      repository: repository.name,
      repositoryOwner: repository.owner.login,
      htmlUrl: pr.html_url,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
    });

    // Emit event for processing
    this.emit('task:created', task);

    return task;
  }

  /**
   * Create a new processing task
   */
  private createTask(type: ProcessingTask['type'], data: unknown): ProcessingTask {
    const task: ProcessingTask = {
      id: crypto.randomUUID(),
      type,
      status: 'pending',
      priority: this.calculatePriority(type, data),
      data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.taskQueue.set(task.id, task);

    this.logger.info({
      taskId: task.id,
      type: task.type,
      priority: task.priority,
    }, 'Created processing task');

    return task;
  }

  /**
   * Calculate task priority
   */
  private calculatePriority(type: string, data: any): number {
    let priority = 50; // Default priority

    // Issues with certain labels get higher priority
    if (type === 'issue' && data.labels) {
      const labels = data.labels.map((l: any) => l.name.toLowerCase());
      
      if (labels.includes('bug')) priority += 20;
      if (labels.includes('security')) priority += 30;
      if (labels.includes('critical')) priority += 40;
      if (labels.includes('enhancement')) priority += 10;
    }

    // PRs get medium priority
    if (type === 'pr') {
      priority = 60;
    }

    return Math.min(priority, 100);
  }

  /**
   * Get pending tasks (for VS Code extension to pick up)
   */
  getPendingTasks(options?: {
    limit?: number;
    capabilities?: string[];
  }): ProcessingTask[] {
    const tasks = Array.from(this.taskQueue.values())
      .filter(t => t.status === 'pending')
      .sort((a, b) => b.priority - a.priority);

    if (options?.limit) {
      return tasks.slice(0, options.limit);
    }

    return tasks;
  }

  /**
   * Assign a task to a VS Code extension instance
   */
  assignTask(taskId: string, workspaceId: string): ProcessingTask | null {
    const task = this.taskQueue.get(taskId);
    
    if (!task) {
      this.logger.warn({ taskId }, 'Task not found');
      return null;
    }

    if (task.status !== 'pending') {
      this.logger.warn({ taskId, status: task.status }, 'Task not in pending status');
      return null;
    }

    task.status = 'in-progress';
    task.assignedTo = workspaceId;
    task.updatedAt = new Date().toISOString();

    this.logger.info({
      taskId,
      workspaceId,
    }, 'Task assigned to workspace');

    this.emit('task:assigned', task);

    return task;
  }

  /**
   * Complete a task with result
   */
  completeTask(taskId: string, result: unknown): ProcessingTask | null {
    const task = this.taskQueue.get(taskId);
    
    if (!task) {
      this.logger.warn({ taskId }, 'Task not found');
      return null;
    }

    task.status = 'completed';
    task.result = result;
    task.updatedAt = new Date().toISOString();

    this.logger.info({
      taskId,
      type: task.type,
    }, 'Task completed');

    this.emit('task:completed', task);

    return task;
  }

  /**
   * Fail a task with error
   */
  failTask(taskId: string, error: string): ProcessingTask | null {
    const task = this.taskQueue.get(taskId);
    
    if (!task) {
      this.logger.warn({ taskId }, 'Task not found');
      return null;
    }

    task.status = 'failed';
    task.error = error;
    task.updatedAt = new Date().toISOString();

    this.logger.error({
      taskId,
      type: task.type,
      error,
    }, 'Task failed');

    this.emit('task:failed', task);

    return task;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): ProcessingTask | null {
    return this.taskQueue.get(taskId) || null;
  }

  /**
   * Get all tasks
   */
  getAllTasks(): ProcessingTask[] {
    return Array.from(this.taskQueue.values());
  }

  /**
   * Get task statistics
   */
  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
  } {
    const tasks = Array.from(this.taskQueue.values());
    
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      inProgress: tasks.filter(t => t.status === 'in-progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    };
  }

  /**
   * Clean up old completed/failed tasks
   */
  cleanupOldTasks(olderThanHours: number = 24): number {
    const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
    let removed = 0;

    for (const [id, task] of this.taskQueue) {
      if (
        (task.status === 'completed' || task.status === 'failed') &&
        new Date(task.updatedAt).getTime() < cutoff
      ) {
        this.taskQueue.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info({ removed }, 'Cleaned up old tasks');
    }

    return removed;
  }

  /**
   * Fetch and process all open issues from a repository
   * Used for initial sync or catching up
   */
  async syncOpenIssues(repoOwner: string, repoName: string): Promise<ProcessingTask[]> {
    this.logger.info({
      repo: `${repoOwner}/${repoName}`,
    }, 'Syncing open issues');

    const tasks: ProcessingTask[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner: repoOwner,
        repo: repoName,
        state: 'open',
        per_page: perPage,
        page,
      });

      if (issues.length === 0) break;

      for (const issue of issues) {
        // Skip pull requests (they also appear in issues API)
        if (issue.pull_request) continue;

        const task = this.createTask('issue', {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: (issue.labels as Array<{ name: string; color: string }>).map(l => ({
            name: typeof l === 'string' ? l : l.name,
            color: typeof l === 'string' ? '' : l.color || '',
          })),
          author: issue.user?.login || 'unknown',
          repository: repoName,
          repositoryOwner: repoOwner,
          htmlUrl: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
        });

        tasks.push(task);
      }

      page++;
    }

    this.logger.info({
      repo: `${repoOwner}/${repoName}`,
      count: tasks.length,
    }, 'Synced open issues');

    return tasks;
  }

  /**
   * Sync all open issues from all repositories in the organization
   */
  async syncAllOpenIssues(repos: Array<{ name: string; owner: string }>): Promise<ProcessingTask[]> {
    const allTasks: ProcessingTask[] = [];

    for (const repo of repos) {
      const tasks = await this.syncOpenIssues(repo.owner, repo.name);
      allTasks.push(...tasks);
    }

    this.logger.info({
      repoCount: repos.length,
      taskCount: allTasks.length,
    }, 'Synced all open issues');

    return allTasks;
  }
}
