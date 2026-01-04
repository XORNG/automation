import { Octokit } from '@octokit/rest';
import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { AIService, type PRReviewResult, type IssueAnalysisResult } from './ai-service.js';

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
 * Pull Request data structure
 */
export interface PRData {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string;
  repository: string;
  repositoryOwner: string;
  htmlUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeable?: boolean;
  mergeableState?: string;
}

/**
 * Processing task
 */
export interface ProcessingTask {
  id: string;
  type: 'issue' | 'pr' | 'feedback';
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  priority: number;
  data: IssueData | PRData | unknown;
  createdAt: string;
  updatedAt: string;
  assignedTo?: string;  // workspaceId of assigned VS Code extension
  result?: unknown;
  error?: string;
  aiAnalysis?: IssueAnalysisResult | PRReviewResult;
}

/**
 * Processing configuration
 */
export interface IssueProcessorConfig {
  token: string;
  organization: string;
  logLevel?: string;
  // AI Service integration (optional)
  aiService?: AIService;
  // Auto-merge settings
  autoMergeEnabled?: boolean;
  autoMergeRequireApproval?: boolean;
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
 * - AI-powered issue analysis and PR review (via OpenRouter)
 * - PR merge capabilities with configurable auto-merge
 */
export class IssueProcessor extends EventEmitter {
  private octokit: Octokit;
  private logger: Logger;
  private config: IssueProcessorConfig;
  private taskQueue: Map<string, ProcessingTask> = new Map();
  private aiService?: AIService;

  constructor(config: IssueProcessorConfig) {
    super();
    this.config = config;
    this.octokit = new Octokit({
      auth: config.token,
    });
    this.aiService = config.aiService;
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'issue-processor',
    });

    if (this.aiService?.isEnabled()) {
      this.logger.info('AI-powered processing enabled');
    }
  }

  /**
   * Set or update AI service
   */
  setAIService(aiService: AIService): void {
    this.aiService = aiService;
    this.logger.info({ enabled: aiService.isEnabled() }, 'AI service configured');
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
   * Process a specific issue by owner, repo, and number
   * Used by queue-based job processing
   */
  async processIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    action: string
  ): Promise<ProcessingTask | null> {
    this.logger.info({ owner, repo, issueNumber, action }, 'Processing issue from queue');

    try {
      // Fetch issue details from GitHub
      const { data: issue } = await this.octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      // Create task from fetched issue
      return this.processIssueEvent({
        action,
        issue: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state,
          labels: (issue.labels as Array<{ name?: string; color?: string }>)
            .filter((l): l is { name: string; color: string } => typeof l.name === 'string')
            .map(l => ({ name: l.name, color: l.color ?? '' })),
          author: issue.user?.login ?? 'unknown',
          repository: repo,
          repositoryOwner: owner,
          htmlUrl: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
        },
        repository: { name: repo, owner: { login: owner } },
      });
    } catch (error) {
      this.logger.error({ error, owner, repo, issueNumber }, 'Failed to process issue');
      return null;
    }
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

  // =========================================
  // AI-Powered Processing Methods
  // =========================================

  /**
   * Analyze an issue using AI and update the task with analysis results
   */
  async analyzeIssueWithAI(taskId: string): Promise<IssueAnalysisResult | null> {
    if (!this.aiService?.isEnabled()) {
      this.logger.warn('AI service not enabled, skipping issue analysis');
      return null;
    }

    const task = this.taskQueue.get(taskId);
    if (!task || task.type !== 'issue') {
      this.logger.warn({ taskId }, 'Task not found or not an issue');
      return null;
    }

    const issueData = task.data as IssueData;

    try {
      const analysis = await this.aiService.analyzeIssue({
        title: issueData.title,
        body: issueData.body,
        labels: issueData.labels.map(l => l.name),
        repository: `${issueData.repositoryOwner}/${issueData.repository}`,
      });

      task.aiAnalysis = analysis;
      task.updatedAt = new Date().toISOString();

      this.logger.info({
        taskId,
        category: analysis.category,
        priority: analysis.priority,
        complexity: analysis.estimatedComplexity,
      }, 'Issue analyzed with AI');

      this.emit('issue:ai-analyzed', { task, analysis });
      return analysis;
    } catch (error) {
      this.logger.error({ error, taskId }, 'Failed to analyze issue with AI');
      return null;
    }
  }

  /**
   * Review a PR using AI and optionally auto-merge
   */
  async reviewPRWithAI(taskId: string): Promise<PRReviewResult | null> {
    if (!this.aiService?.isEnabled()) {
      this.logger.warn('AI service not enabled, skipping PR review');
      return null;
    }

    const task = this.taskQueue.get(taskId);
    if (!task || task.type !== 'pr') {
      this.logger.warn({ taskId }, 'Task not found or not a PR');
      return null;
    }

    const prData = task.data as PRData;

    try {
      // Get PR diff from GitHub
      const { data: diff } = await this.octokit.pulls.get({
        owner: prData.repositoryOwner,
        repo: prData.repository,
        pull_number: prData.number,
        mediaType: {
          format: 'diff',
        },
      });

      // Get list of changed files
      const { data: files } = await this.octokit.pulls.listFiles({
        owner: prData.repositoryOwner,
        repo: prData.repository,
        pull_number: prData.number,
      });

      const review = await this.aiService.reviewPullRequest({
        title: prData.title,
        body: prData.body,
        repository: `${prData.repositoryOwner}/${prData.repository}`,
        baseBranch: prData.baseRef,
        headBranch: prData.headRef,
        diff: String(diff),
        changedFiles: files.map((f: { filename: string; patch?: string }) => ({ filename: f.filename, patch: f.patch })),
      });

      task.aiAnalysis = review;
      task.updatedAt = new Date().toISOString();

      this.logger.info({
        taskId,
        prNumber: prData.number,
        approved: review.approved,
        mergeRecommendation: review.mergeRecommendation,
        concerns: review.concerns.length,
      }, 'PR reviewed with AI');

      this.emit('pr:ai-reviewed', { task, review });
      return review;
    } catch (error) {
      this.logger.error({ error, taskId }, 'Failed to review PR with AI');
      return null;
    }
  }

  // =========================================
  // PR Management Methods
  // =========================================

  /**
   * Get details of a pull request
   */
  async getPullRequestDetails(owner: string, repo: string, prNumber: number): Promise<PRData | null> {
    try {
      const { data: pr } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      return {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        author: pr.user?.login || 'unknown',
        repository: repo,
        repositoryOwner: owner,
        htmlUrl: pr.html_url,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        mergeable: pr.mergeable ?? undefined,
        mergeableState: pr.mergeable_state,
      };
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to get PR details');
      return null;
    }
  }

  /**
   * Create a review on a pull request
   */
  async createPRReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: {
      body: string;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      comments?: Array<{
        path: string;
        position?: number;
        line?: number;
        body: string;
      }>;
    }
  ): Promise<boolean> {
    try {
      await this.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: review.body,
        event: review.event,
        comments: review.comments,
      });

      this.logger.info({
        owner,
        repo,
        prNumber,
        event: review.event,
      }, 'Created PR review');

      return true;
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to create PR review');
      return false;
    }
  }

  /**
   * Merge a pull request
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    prNumber: number,
    options?: {
      commitTitle?: string;
      commitMessage?: string;
      mergeMethod?: 'merge' | 'squash' | 'rebase';
    }
  ): Promise<{ success: boolean; sha?: string; message?: string }> {
    try {
      // Check if PR is mergeable first
      const prDetails = await this.getPullRequestDetails(owner, repo, prNumber);
      
      if (!prDetails) {
        return { success: false, message: 'Failed to get PR details' };
      }

      if (prDetails.state !== 'open') {
        return { success: false, message: 'PR is not open' };
      }

      if (prDetails.mergeable === false) {
        return { success: false, message: `PR is not mergeable: ${prDetails.mergeableState}` };
      }

      const { data: result } = await this.octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        commit_title: options?.commitTitle,
        commit_message: options?.commitMessage,
        merge_method: options?.mergeMethod || 'squash',
      });

      this.logger.info({
        owner,
        repo,
        prNumber,
        sha: result.sha,
        merged: result.merged,
      }, 'Merged PR');

      this.emit('pr:merged', { owner, repo, prNumber, sha: result.sha });

      return { success: result.merged, sha: result.sha, message: result.message };
    } catch (error: any) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to merge PR');
      return { success: false, message: error.message || 'Unknown error' };
    }
  }

  /**
   * Create a comment on a PR or issue
   */
  async createComment(
    owner: string,
    repo: string,
    issueOrPRNumber: number,
    body: string
  ): Promise<boolean> {
    try {
      await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueOrPRNumber,
        body,
      });

      this.logger.info({ owner, repo, number: issueOrPRNumber }, 'Created comment');
      return true;
    } catch (error) {
      this.logger.error({ error, owner, repo, number: issueOrPRNumber }, 'Failed to create comment');
      return false;
    }
  }

  /**
   * Add labels to an issue or PR
   */
  async addLabels(
    owner: string,
    repo: string,
    issueOrPRNumber: number,
    labels: string[]
  ): Promise<boolean> {
    try {
      await this.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: issueOrPRNumber,
        labels,
      });

      this.logger.info({ owner, repo, number: issueOrPRNumber, labels }, 'Added labels');
      return true;
    } catch (error) {
      this.logger.error({ error, owner, repo, number: issueOrPRNumber }, 'Failed to add labels');
      return false;
    }
  }

  /**
   * Process a PR with AI review and optional auto-merge
   */
  async processPRWithAutoMerge(
    owner: string,
    repo: string,
    prNumber: number,
    options?: {
      requireApproval?: boolean;
      addReviewComment?: boolean;
      mergeOnApproval?: boolean;
    }
  ): Promise<{
    reviewed: boolean;
    merged: boolean;
    review?: PRReviewResult;
    error?: string;
  }> {
    const result: {
      reviewed: boolean;
      merged: boolean;
      review?: PRReviewResult;
      error?: string;
    } = { reviewed: false, merged: false };

    if (!this.aiService?.isEnabled()) {
      result.error = 'AI service not enabled';
      return result;
    }

    // Create a task for this PR
    const prDetails = await this.getPullRequestDetails(owner, repo, prNumber);
    if (!prDetails) {
      result.error = 'Failed to get PR details';
      return result;
    }

    const task = this.createTask('pr', prDetails);

    // Review with AI
    const review = await this.reviewPRWithAI(task.id);
    if (!review) {
      result.error = 'AI review failed';
      return result;
    }

    result.reviewed = true;
    result.review = review;

    // Add review comment if requested
    if (options?.addReviewComment) {
      const reviewBody = this.formatAIReviewAsComment(review);
      const reviewEvent = review.approved ? 'APPROVE' : 
        review.mergeRecommendation === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT';
      
      await this.createPRReview(owner, repo, prNumber, {
        body: reviewBody,
        event: reviewEvent,
      });
    }

    // Auto-merge if approved and enabled
    if (
      options?.mergeOnApproval &&
      review.approved &&
      review.mergeRecommendation === 'merge' &&
      (!options?.requireApproval || this.config.autoMergeEnabled)
    ) {
      const mergeResult = await this.mergePullRequest(owner, repo, prNumber, {
        commitTitle: `Merge PR #${prNumber}: ${prDetails.title}`,
        commitMessage: `AI-approved merge\n\nReview summary: ${review.summary}`,
        mergeMethod: 'squash',
      });

      result.merged = mergeResult.success;
      if (!mergeResult.success) {
        result.error = mergeResult.message;
      }
    }

    return result;
  }

  /**
   * Format AI review result as a comment
   */
  private formatAIReviewAsComment(review: PRReviewResult): string {
    let comment = `## 🤖 AI Code Review\n\n`;
    comment += `**Summary:** ${review.summary}\n\n`;
    
    if (review.approved) {
      comment += `✅ **Approved** - Ready to merge\n\n`;
    } else {
      comment += `⚠️ **Changes Requested**\n\n`;
    }

    if (review.concerns.length > 0) {
      comment += `### Concerns\n`;
      for (const concern of review.concerns) {
        comment += `- ${concern}\n`;
      }
      comment += '\n';
    }

    if (review.suggestions.length > 0) {
      comment += `### Suggestions\n`;
      for (const suggestion of review.suggestions) {
        comment += `#### ${suggestion.file}\n`;
        comment += `${suggestion.description}\n`;
        if (suggestion.suggestedCode) {
          comment += `\`\`\`\n${suggestion.suggestedCode}\n\`\`\`\n`;
        }
        comment += '\n';
      }
    }

    comment += `\n---\n*Recommendation: **${review.mergeRecommendation}***\n`;
    comment += `\n_This review was generated by XORNG AI (OpenRouter)_`;

    return comment;
  }
}
