/**
 * Pipeline Automation Integration
 * 
 * Wires together the PipelineMonitor and MergeApprovalService with the webhook server
 * to provide automated CI/CD pipeline fixes and human-in-the-loop merge approvals.
 * 
 * Self-improvement guidelines:
 * - Track fix attempts and success rates
 * - Learn from past failures to improve fix suggestions
 * - Limit auto-fix attempts (max 3) before requiring human intervention
 * - Always require human approval before merging
 */

import { EventEmitter } from 'events';
import { Octokit } from '@octokit/rest';
import { pino, type Logger } from 'pino';
import { 
  PipelineMonitor, 
  type PipelineMonitorConfig, 
  type PipelineFailureAnalysis,
  type LearningServiceInterface,
} from './pipeline-monitor.js';
import { MergeApprovalService, type MergeApprovalConfig } from './merge-approval.js';
import { AIService } from './ai-service.js';
import type { WebhookServer, GitHubWebhookPayload } from './webhook-server.js';

/**
 * Pipeline Automation configuration
 */
export interface PipelineAutomationConfig {
  /** GitHub API token */
  token: string;
  
  /** GitHub organization name */
  organization: string;
  
  /** AI service for intelligent analysis */
  aiService: AIService;
  
  /** Webhook server to subscribe to events */
  webhookServer: WebhookServer;
  
  /** Learning service for self-improvement (from @xorng/core) */
  learningService?: LearningServiceInterface;
  
  /** Pipeline monitor settings */
  pipelineMonitor?: Partial<Omit<PipelineMonitorConfig, 'token' | 'organization'>>;
  
  /** Merge approval settings */
  mergeApproval?: Partial<Omit<MergeApprovalConfig, 'token' | 'organization'>>;
  
  /** Bot account name (to identify bot comments) */
  botUsername: string;
  
  /** Enable/disable auto-fix */
  enableAutoFix?: boolean;
  
  /** Enable/disable merge approval */
  enableMergeApproval?: boolean;
  
  /** Logging level */
  logLevel?: string;
}

/**
 * Pipeline event context
 */
interface PipelineEventContext {
  owner: string;
  repo: string;
  prNumber?: number;
  sha?: string;
  event: string;
  action: string;
}

/**
 * Fix attempt tracking
 */
interface FixAttemptRecord {
  prNumber: number;
  repo: string;
  attempts: number;
  lastAttempt: Date;
  lastError?: string;
  successful: boolean;
}

/**
 * Repository lock - ensures only one PR is being fixed at a time per repo
 * Prevents merge conflicts and duplicate fixes
 */
interface RepositoryLock {
  /** The PR currently being fixed */
  activePR: number;
  /** When the lock was acquired */
  lockedAt: Date;
  /** PRs waiting for the lock */
  queue: Array<{
    prNumber: number;
    owner: string;
    queuedAt: Date;
  }>;
}

/**
 * PipelineAutomation - Main integration class for CI/CD automation
 * 
 * Responsibilities:
 * - Listen to webhook events from GitHub
 * - Route events to appropriate services
 * - Coordinate between PipelineMonitor and MergeApprovalService
 * - Track fix attempts and enforce limits
 * - Emit events for external monitoring
 */
export class PipelineAutomation extends EventEmitter {
  private logger: Logger;
  private octokit: Octokit;
  private aiService: AIService;
  private webhookServer: WebhookServer;
  private pipelineMonitor: PipelineMonitor;
  private mergeApprovalService: MergeApprovalService;
  private learningService?: LearningServiceInterface;
  private botUsername: string;
  private enableAutoFix: boolean;
  private enableMergeApproval: boolean;
  
  /** Track fix attempts per PR */
  private fixAttempts: Map<string, FixAttemptRecord> = new Map();
  
  /** Track applied analyses for learning from success */
  private appliedAnalyses: Map<string, PipelineFailureAnalysis[]> = new Map();
  
  /** Repository locks - only one PR can be fixed at a time per repo */
  private repoLocks: Map<string, RepositoryLock> = new Map();
  
  /** Statistics */
  private stats = {
    pipelinesMonitored: 0,
    fixesAttempted: 0,
    fixesSuccessful: 0,
    mergesApproved: 0,
    mergesCompleted: 0,
    prsQueued: 0,
  };

  constructor(config: PipelineAutomationConfig) {
    super();
    
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'pipeline-automation',
    });
    
    this.octokit = new Octokit({ auth: config.token });
    this.aiService = config.aiService;
    this.webhookServer = config.webhookServer;
    this.botUsername = config.botUsername;
    this.enableAutoFix = config.enableAutoFix ?? true;
    this.enableMergeApproval = config.enableMergeApproval ?? true;
    this.learningService = config.learningService;
    
    // Initialize services with proper config
    this.pipelineMonitor = new PipelineMonitor({
      token: config.token,
      organization: config.organization,
      aiService: config.aiService,
      learningService: config.learningService,
      maxFixAttempts: config.pipelineMonitor?.maxFixAttempts ?? 3,
      autoFixEnabled: this.enableAutoFix,
      logLevel: config.logLevel,
    });
    
    this.mergeApprovalService = new MergeApprovalService({
      token: config.token,
      organization: config.organization,
      blockingLabels: config.mergeApproval?.blockingLabels ?? ['do-not-merge', 'wip', 'blocked'],
      defaultMergeMethod: config.mergeApproval?.defaultMergeMethod ?? 'squash',
      requireExplicitApproval: config.mergeApproval?.requireExplicitApproval ?? true,
      logLevel: config.logLevel,
    });
    
    // Setup event handlers
    this.setupWebhookHandlers();
    this.setupServiceHandlers();
    
    this.logger.info({
      enableAutoFix: this.enableAutoFix,
      enableMergeApproval: this.enableMergeApproval,
      botUsername: this.botUsername,
      learningServiceEnabled: !!config.learningService,
    }, 'Pipeline automation initialized');
  }

  /**
   * Setup webhook event handlers
   */
  private setupWebhookHandlers(): void {
    // Handle check run events (individual CI checks)
    this.webhookServer.on('github:check_run', async (event) => {
      await this.handleCheckRunEvent(event);
    });
    
    // Handle check suite events (grouped CI checks)
    this.webhookServer.on('github:check_suite', async (event) => {
      await this.handleCheckSuiteEvent(event);
    });
    
    // Handle workflow run events (GitHub Actions workflows)
    this.webhookServer.on('github:workflow_run', async (event) => {
      await this.handleWorkflowRunEvent(event);
    });
    
    // Handle issue comment events (for merge commands)
    this.webhookServer.on('github:issue_comment', async (event) => {
      await this.handleIssueCommentEvent(event);
    });
    
    // Handle pull request events
    this.webhookServer.on('github:pull_request', async (event) => {
      await this.handlePullRequestEvent(event);
    });
  }

  /**
   * Setup internal service event handlers
   */
  private setupServiceHandlers(): void {
    // Handle pipeline monitor events
    this.pipelineMonitor.on('fix:applied', (data) => {
      this.stats.fixesAttempted++;
      this.recordFixAttempt(data.repo, data.prNumber, true);
      
      // Store analyses for learning when fix succeeds
      if (data.analyses) {
        const prKey = `${data.owner}/${data.repo}#${data.prNumber}`;
        this.appliedAnalyses.set(prKey, data.analyses);
      }
      
      this.emit('fix:applied', data);
    });
    
    this.pipelineMonitor.on('fix:failed', (data) => {
      this.stats.fixesAttempted++;
      this.recordFixAttempt(data.repo, data.prNumber, false, data.error);
      // Release lock and process next queued PR when fix fails
      this.releaseRepoLock(data.repo, data.prNumber);
      this.processNextQueuedPR(data.owner, data.repo);
      this.emit('fix:failed', data);
    });
    
    // Handle analysis completion (regardless of whether fix was attempted)
    // This is emitted when:
    // 1. No auto-fixable issues are found
    // 2. Validator pre-check fails
    // 3. Auto-fix is disabled
    this.pipelineMonitor.on('analysis:complete', (data) => {
      this.logger.info({
        owner: data.owner,
        repo: data.repo,
        prNumber: data.prNumber,
        fixAttempted: data.fixAttempted,
      }, 'Analysis complete, releasing lock');
      
      // Release lock and process next queued PR
      this.releaseRepoLock(data.repo, data.prNumber);
      this.processNextQueuedPR(data.owner, data.repo);
    });
    
    // Handle fix success (pipeline passed after fix)
    this.pipelineMonitor.on('fix:successful', async (data) => {
      this.stats.fixesSuccessful++;
      const prKey = `${data.owner}/${data.repo}#${data.prNumber}`;
      
      // Learn from this success using stored analyses
      if (this.learningService) {
        const analyses = this.appliedAnalyses.get(prKey);
        if (analyses && analyses.length > 0) {
          this.logger.info({
            owner: data.owner,
            repo: data.repo,
            prNumber: data.prNumber,
            analysesCount: analyses.length,
          }, 'Learning from successful fix');
          
          // Record success for each analysis
          for (const analysis of analyses) {
            try {
              const prKeyParts = prKey.split('#');
              const attemptNumber = this.fixAttempts.get(prKeyParts[0].split('/')[1] + '#' + data.prNumber)?.attempts || 1;
              
              await this.learningService.recordFixAttempt({
                repo: `${data.owner}/${data.repo}`,
                prNumber: data.prNumber,
                failureType: analysis.failureType,
                errorPattern: analysis.errorMessages.slice(0, 5).join('\n'),
                attemptNumber,
                successful: true,
                appliedFixes: analysis.suggestedFixes.map(f => ({
                  file: f.file,
                  description: f.description,
                })),
              });
            } catch (error) {
              this.logger.error({ error, analysis: analysis.failureType }, 'Failed to record fix success');
            }
          }
        }
      }
      
      // Clean up stored analyses
      this.appliedAnalyses.delete(prKey);
      
      // Release lock and process next queued PR after successful fix
      this.releaseRepoLock(data.repo, data.prNumber);
      this.processNextQueuedPR(data.owner, data.repo);
      
      this.emit('fix:successful', data);
    });
    
    this.pipelineMonitor.on('pipeline:passed', (data) => {
      this.stats.pipelinesMonitored++;
      this.emit('pipeline:passed', data);
    });
    
    this.pipelineMonitor.on('pipeline:failed', (data) => {
      this.stats.pipelinesMonitored++;
      this.emit('pipeline:failed', data);
    });
    
    // Handle merge approval events
    this.mergeApprovalService.on('pr:approved', (data) => {
      this.stats.mergesApproved++;
      this.emit('merge:approved', data);
    });
    
    this.mergeApprovalService.on('pr:merged', (data) => {
      this.stats.mergesCompleted++;
      // Clean up fix attempts record, applied analyses, and release lock
      this.clearFixAttempts(data.repo, data.prNumber);
      this.appliedAnalyses.delete(`${data.owner}/${data.repo}#${data.prNumber}`);
      this.releaseRepoLock(data.repo, data.prNumber);
      this.emit('merge:completed', data);
      
      // Process next queued PR for this repo
      this.processNextQueuedPR(data.owner, data.repo);
    });
    
    this.mergeApprovalService.on('autofix-requested', async (data) => {
      await this.handleManualAutofixRequest(data);
    });
  }

  /**
   * Handle check_run webhook events
   */
  private async handleCheckRunEvent(event: { action: string; payload: GitHubWebhookPayload }): Promise<void> {
    const { action, payload } = event;
    
    // Only process completed check runs
    if (action !== 'completed') {
      return;
    }
    
    const checkRun = payload.check_run;
    if (!checkRun) return;
    
    const context = this.extractContext(payload, 'check_run', action);
    
    this.logger.info({
      ...context,
      checkName: checkRun.name,
      conclusion: checkRun.conclusion,
    }, 'Processing check_run event');
    
    // Only process failures
    if (checkRun.conclusion !== 'failure' && checkRun.conclusion !== 'timed_out') {
      return;
    }
    
    // Process each associated PR
    for (const pr of checkRun.pull_requests || []) {
      // Check if auto-fix is enabled and attempts available
      if (!this.enableAutoFix || !this.canAttemptFix(context.repo, pr.number)) {
        this.logger.info({
          owner: context.owner,
          repo: context.repo,
          prNumber: pr.number,
        }, 'Auto-fix limit reached or disabled, requiring human intervention');
        
        await this.requestHumanIntervention({
          owner: context.owner,
          repo: context.repo,
          prNumber: pr.number,
          reason: 'Auto-fix attempts exhausted or disabled',
          failedCheck: checkRun.name,
        });
        continue;
      }
      
      // Try to acquire lock for this repo - only one PR can be fixed at a time
      const lockAcquired = this.tryAcquireRepoLock(context.owner, context.repo, pr.number);
      
      if (!lockAcquired) {
        this.logger.info({
          owner: context.owner,
          repo: context.repo,
          prNumber: pr.number,
          activePR: this.getActiveFixPR(context.repo),
        }, 'Another PR is being fixed in this repo, queueing this PR');
        
        await this.notifyPRQueued({
          owner: context.owner,
          repo: context.repo,
          prNumber: pr.number,
          activePR: this.getActiveFixPR(context.repo)!,
        });
        continue;
      }
      
      this.logger.info({
        owner: context.owner,
        repo: context.repo,
        prNumber: pr.number,
        checkName: checkRun.name,
      }, 'Acquired repo lock, attempting to auto-fix failed check');
      
      // Pass the full payload to the monitor
      try {
        await this.pipelineMonitor.processCheckRunEvent({
          action,
          check_run: {
            id: checkRun.id,
            name: checkRun.name,
            status: checkRun.status,
            conclusion: checkRun.conclusion,
            pull_requests: checkRun.pull_requests,
          },
          repository: {
            name: payload.repository.name,
            owner: { login: payload.repository.owner.login },
          },
        });
      } catch (error) {
        this.logger.error({ error, owner: context.owner, repo: context.repo, prNumber: pr.number }, 'Failed to process check run');
        // Release lock on error so other PRs can be processed
        this.releaseRepoLock(context.repo, pr.number);
        this.processNextQueuedPR(context.owner, context.repo);
      }
    }
  }

  /**
   * Handle check_suite webhook events
   */
  private async handleCheckSuiteEvent(event: { action: string; payload: GitHubWebhookPayload }): Promise<void> {
    const { action, payload } = event;
    
    // Only process completed check suites
    if (action !== 'completed') {
      return;
    }
    
    const checkSuite = payload.check_suite;
    if (!checkSuite) return;
    
    const context = this.extractContext(payload, 'check_suite', action);
    
    this.logger.debug({
      ...context,
      conclusion: checkSuite.conclusion,
    }, 'Processing check_suite event');
    
    // If all checks passed, notify for merge approval
    if (checkSuite.conclusion === 'success' && this.enableMergeApproval) {
      for (const pr of checkSuite.pull_requests || []) {
        await this.notifyMergeReady({
          owner: context.owner,
          repo: context.repo,
          prNumber: pr.number,
        });
      }
    }
  }

  /**
   * Handle workflow_run webhook events
   */
  private async handleWorkflowRunEvent(event: { action: string; payload: GitHubWebhookPayload }): Promise<void> {
    const { action, payload } = event;
    
    // Only process completed workflow runs
    if (action !== 'completed') {
      return;
    }
    
    const workflowRun = payload.workflow_run;
    if (!workflowRun) return;
    
    const context = this.extractContext(payload, 'workflow_run', action);
    
    this.logger.info({
      ...context,
      workflowName: workflowRun.name,
      conclusion: workflowRun.conclusion,
    }, 'Processing workflow_run event');
    
    // Process each associated PR
    for (const pr of workflowRun.pull_requests || []) {
      if (workflowRun.conclusion === 'failure') {
        // Check if auto-fix is enabled and attempts available
        if (!this.enableAutoFix || !this.canAttemptFix(context.repo, pr.number)) {
          await this.requestHumanIntervention({
            owner: context.owner,
            repo: context.repo,
            prNumber: pr.number,
            reason: 'Auto-fix attempts exhausted or disabled',
            failedWorkflow: workflowRun.name,
          });
          continue;
        }
        
        // Try to acquire lock for this repo - only one PR can be fixed at a time
        const lockAcquired = this.tryAcquireRepoLock(context.owner, context.repo, pr.number);
        
        if (!lockAcquired) {
          this.logger.info({
            owner: context.owner,
            repo: context.repo,
            prNumber: pr.number,
            activePR: this.getActiveFixPR(context.repo),
          }, 'Another PR is being fixed in this repo, queueing this PR');
          
          await this.notifyPRQueued({
            owner: context.owner,
            repo: context.repo,
            prNumber: pr.number,
            activePR: this.getActiveFixPR(context.repo)!,
          });
          continue;
        }
        
        // Pass the full payload to the monitor
        try {
          await this.pipelineMonitor.processWorkflowRunEvent({
            action,
            workflow_run: {
              id: workflowRun.id,
              name: workflowRun.name,
              status: workflowRun.status,
              conclusion: workflowRun.conclusion,
              head_sha: workflowRun.head_sha,
              pull_requests: workflowRun.pull_requests,
            },
            repository: {
              name: payload.repository.name,
              owner: { login: payload.repository.owner.login },
            },
          });
        } catch (error) {
          this.logger.error({ error, owner: context.owner, repo: context.repo, prNumber: pr.number }, 'Failed to process workflow run');
          this.releaseRepoLock(context.repo, pr.number);
        }
      } else if (workflowRun.conclusion === 'success' && this.enableMergeApproval) {
        // Release lock if this PR's fix was successful
        this.releaseRepoLock(context.repo, pr.number);
        
        // Check if ALL checks are now passing
        const status = await this.pipelineMonitor.getPRPipelineStatus(
          context.owner,
          context.repo,
          pr.number
        );
        
        if (status && status.allPassed) {
          await this.notifyMergeReady({
            owner: context.owner,
            repo: context.repo,
            prNumber: pr.number,
          });
          
          // Process next queued PR now that this one is ready
          this.processNextQueuedPR(context.owner, context.repo);
        }
      }
    }
  }

  /**
   * Handle issue_comment webhook events (for merge commands)
   */
  private async handleIssueCommentEvent(event: { action: string; payload: GitHubWebhookPayload }): Promise<void> {
    const { action, payload } = event;
    
    // Only process created comments
    if (action !== 'created') {
      return;
    }
    
    const comment = payload.comment;
    const issue = payload.issue;
    
    // Only process comments on PRs
    if (!comment || !issue || !issue.pull_request) {
      return;
    }
    
    // Ignore bot's own comments
    if (comment.user.login === this.botUsername) {
      return;
    }
    
    const context = this.extractContext(payload, 'issue_comment', action);
    
    this.logger.debug({
      ...context,
      prNumber: issue.number,
      commenter: comment.user.login,
    }, 'Processing issue_comment event');
    
    // Check if comment contains a command
    const commandMatch = comment.body.match(/^\/(\w+)(?:\s+(.*))?$/m);
    if (!commandMatch) {
      return;
    }
    
    // Process command via merge approval service with full payload
    await this.mergeApprovalService.processComment({
      action,
      comment: {
        id: comment.id,
        body: comment.body,
        user: { login: comment.user.login },
      },
      issue: {
        number: issue.number,
        pull_request: issue.pull_request,
      },
      repository: {
        name: payload.repository.name,
        owner: { login: payload.repository.owner.login },
      },
    });
  }

  /**
   * Handle pull_request webhook events
   */
  private async handlePullRequestEvent(event: { action: string; payload: GitHubWebhookPayload }): Promise<void> {
    const { action, payload } = event;
    const pr = payload.pull_request;
    
    if (!pr) return;
    
    const context = this.extractContext(payload, 'pull_request', action);
    
    // Reset fix attempts when PR is synchronized (new commits pushed)
    if (action === 'synchronize') {
      this.resetFixAttempts(context.repo, pr.number);
      this.logger.info({
        ...context,
        prNumber: pr.number,
      }, 'Reset fix attempts for PR (new commits)');
    }
    
    // Clean up when PR is closed/merged
    if (action === 'closed') {
      this.clearFixAttempts(context.repo, pr.number);
      // Release lock and process next queued PR
      this.releaseRepoLock(context.repo, pr.number);
      this.processNextQueuedPR(context.owner, context.repo);
    }
  }

  /**
   * Handle manual autofix request from comment command
   */
  private async handleManualAutofixRequest(data: {
    owner: string;
    repo: string;
    prNumber: number;
    requester: string;
  }): Promise<void> {
    this.logger.info({
      ...data,
    }, 'Processing manual autofix request');
    
    // Try to acquire lock for manual request
    const lockAcquired = this.tryAcquireRepoLock(data.owner, data.repo, data.prNumber);
    
    if (!lockAcquired) {
      const activePR = this.getActiveFixPR(data.repo);
      await this.postComment(data.owner, data.repo, data.prNumber,
        `@${data.requester} Cannot start auto-fix right now. PR #${activePR} is currently being fixed in this repository.\n\nYour request has been queued and will be processed after PR #${activePR} is merged or its fix completes.`
      );
      return;
    }
    
    // Reset fix attempts for manual request
    this.resetFixAttempts(data.repo, data.prNumber);
    
    // Get current pipeline status
    const status = await this.pipelineMonitor.getPRPipelineStatus(
      data.owner,
      data.repo,
      data.prNumber
    );
    
    if (status && status.allPassed) {
      await this.postComment(data.owner, data.repo, data.prNumber,
        `@${data.requester} All checks are already passing! ✅`
      );
      return;
    }
    
    // Trigger autofix analysis
    await this.postComment(data.owner, data.repo, data.prNumber,
      `@${data.requester} Analyzing pipeline failures and attempting auto-fix... 🔧`
    );
    
    await this.pipelineMonitor.handlePRPipelineFailure(
      data.owner,
      data.repo,
      data.prNumber
    );
  }

  /**
   * Notify that a PR is ready for merge
   */
  private async notifyMergeReady(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<void> {
    const { owner, repo, prNumber } = params;
    
    // Check if we already posted a merge-ready comment
    const recentComments = await this.octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 10,
    });
    
    const hasRecentMergeComment = recentComments.data.some(c => 
      c.user?.login === this.botUsername &&
      c.body?.includes('ready to merge') &&
      Date.now() - new Date(c.created_at).getTime() < 3600000 // Within last hour
    );
    
    if (hasRecentMergeComment) {
      this.logger.debug({ owner, repo, prNumber }, 'Skipping merge-ready notification (already posted)');
      return;
    }
    
    const message = `## ✅ Pipeline Checks Passing

All CI/CD checks have passed for this pull request.

**Available commands:**
- \`/approve\` - Approve this PR for merging
- \`/merge\` - Merge using default method (squash)
- \`/merge squash\` - Squash and merge
- \`/merge merge\` - Create a merge commit
- \`/merge rebase\` - Rebase and merge

_Only users with write access can use these commands._`;

    await this.postComment(owner, repo, prNumber, message);
    this.emit('merge:ready', { owner, repo, prNumber });
  }

  /**
   * Request human intervention when auto-fix is not possible
   */
  private async requestHumanIntervention(params: {
    owner: string;
    repo: string;
    prNumber: number;
    reason: string;
    failedCheck?: string;
    failedWorkflow?: string;
  }): Promise<void> {
    const { owner, repo, prNumber, reason, failedCheck, failedWorkflow } = params;
    
    // Get fix attempt history
    const attempts = this.getFixAttempts(repo, prNumber);
    
    const message = `## 🚨 Human Intervention Required

The automated pipeline fix system was unable to resolve the failing checks.

**Reason:** ${reason}
${failedCheck ? `**Failed Check:** ${failedCheck}` : ''}
${failedWorkflow ? `**Failed Workflow:** ${failedWorkflow}` : ''}
**Auto-fix Attempts:** ${attempts?.attempts || 0}/3

**Available commands:**
- \`/autofix\` - Retry auto-fix (resets attempt counter)
- \`/hold\` - Mark this PR as blocked

Please review the failure logs and make the necessary fixes manually.`;

    await this.postComment(owner, repo, prNumber, message);
    
    // Add a label to indicate human intervention needed
    try {
      await this.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: ['needs-human-review'],
      });
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber }, 'Failed to add label');
    }
    
    this.emit('intervention:requested', { owner, repo, prNumber, reason });
  }

  /**
   * Post a comment on a PR
   */
  private async postComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    try {
      await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to post comment');
    }
  }

  /**
   * Extract context from webhook payload
   */
  private extractContext(payload: GitHubWebhookPayload, event: string, action: string): PipelineEventContext {
    return {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      event,
      action,
    };
  }

  /**
   * Check if we can attempt another fix
   */
  private canAttemptFix(repo: string, prNumber: number): boolean {
    const key = `${repo}#${prNumber}`;
    const record = this.fixAttempts.get(key);
    
    if (!record) {
      return true;
    }
    
    return record.attempts < 3;
  }

  /**
   * Get fix attempts for a PR
   */
  private getFixAttempts(repo: string, prNumber: number): FixAttemptRecord | undefined {
    const key = `${repo}#${prNumber}`;
    return this.fixAttempts.get(key);
  }

  /**
   * Record a fix attempt
   */
  private recordFixAttempt(repo: string, prNumber: number, successful: boolean, error?: string): void {
    const key = `${repo}#${prNumber}`;
    const existing = this.fixAttempts.get(key);
    
    if (existing) {
      existing.attempts++;
      existing.lastAttempt = new Date();
      existing.lastError = error;
      existing.successful = successful;
    } else {
      this.fixAttempts.set(key, {
        prNumber,
        repo,
        attempts: 1,
        lastAttempt: new Date(),
        lastError: error,
        successful,
      });
    }
    
    if (successful) {
      this.stats.fixesSuccessful++;
    }
  }

  /**
   * Reset fix attempts for a PR
   */
  private resetFixAttempts(repo: string, prNumber: number): void {
    const key = `${repo}#${prNumber}`;
    this.fixAttempts.delete(key);
  }

  /**
   * Clear fix attempts for a PR
   */
  private clearFixAttempts(repo: string, prNumber: number): void {
    const key = `${repo}#${prNumber}`;
    this.fixAttempts.delete(key);
  }

  // ==========================================================================
  // Repository Lock Management
  // ==========================================================================

  /**
   * Try to acquire a lock for auto-fixing a PR in a repository.
   * Only one PR can be fixed at a time per repository to prevent merge conflicts.
   * 
   * @returns true if lock was acquired, false if another PR is being fixed
   */
  private tryAcquireRepoLock(owner: string, repo: string, prNumber: number): boolean {
    const key = `${owner}/${repo}`;
    const existing = this.repoLocks.get(key);
    
    if (existing) {
      // Lock already held
      if (existing.activePR === prNumber) {
        // Same PR already has the lock
        return true;
      }
      
      // Add to queue if not already queued
      const alreadyQueued = existing.queue.some(q => q.prNumber === prNumber);
      if (!alreadyQueued) {
        existing.queue.push({
          prNumber,
          owner,
          queuedAt: new Date(),
        });
        this.stats.prsQueued++;
        this.logger.info({
          owner,
          repo,
          prNumber,
          activePR: existing.activePR,
          queueLength: existing.queue.length,
        }, 'PR queued for auto-fix');
      }
      return false;
    }
    
    // Acquire the lock
    this.repoLocks.set(key, {
      activePR: prNumber,
      lockedAt: new Date(),
      queue: [],
    });
    
    this.logger.info({
      owner,
      repo,
      prNumber,
    }, 'Acquired repo lock for auto-fix');
    
    return true;
  }

  /**
   * Release the lock for a repository
   */
  private releaseRepoLock(repo: string, prNumber: number): void {
    // Find the lock by repo name (may need to search)
    for (const [key, lock] of this.repoLocks.entries()) {
      if (key.endsWith(`/${repo}`) && lock.activePR === prNumber) {
        this.repoLocks.delete(key);
        this.logger.info({
          repo,
          prNumber,
          queueLength: lock.queue.length,
        }, 'Released repo lock');
        return;
      }
    }
  }

  /**
   * Get the PR currently being fixed in a repository
   */
  private getActiveFixPR(repo: string): number | null {
    for (const [key, lock] of this.repoLocks.entries()) {
      if (key.endsWith(`/${repo}`)) {
        return lock.activePR;
      }
    }
    return null;
  }

  /**
   * Process the next queued PR for a repository
   */
  private async processNextQueuedPR(owner: string, repo: string): Promise<void> {
    const key = `${owner}/${repo}`;
    const lock = this.repoLocks.get(key);
    
    if (!lock || lock.queue.length === 0) {
      // No queued PRs, remove the lock entry
      this.repoLocks.delete(key);
      return;
    }
    
    // Get the next PR from the queue
    const next = lock.queue.shift()!;
    
    this.logger.info({
      owner,
      repo,
      nextPR: next.prNumber,
      remainingQueue: lock.queue.length,
    }, 'Processing next queued PR');
    
    // Update lock to the next PR
    lock.activePR = next.prNumber;
    lock.lockedAt = new Date();
    
    // Notify the PR that it's now being processed
    await this.postComment(owner, repo, next.prNumber,
      `🔄 Your PR is now being processed for auto-fix. It was queued at ${next.queuedAt.toISOString()}.`
    );
    
    // Trigger pipeline check for this PR
    try {
      const status = await this.pipelineMonitor.getPRPipelineStatus(owner, repo, next.prNumber);
      
      if (status && !status.allPassed) {
        await this.pipelineMonitor.handlePRPipelineFailure(owner, repo, next.prNumber);
      } else {
        // PR might have been fixed manually or checks now pass
        this.releaseRepoLock(repo, next.prNumber);
        await this.postComment(owner, repo, next.prNumber,
          `✅ Pipeline checks are now passing! No auto-fix needed.`
        );
        // Process next in queue
        this.processNextQueuedPR(owner, repo);
      }
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber: next.prNumber }, 'Failed to process queued PR');
      this.releaseRepoLock(repo, next.prNumber);
      this.processNextQueuedPR(owner, repo);
    }
  }

  /**
   * Notify a PR that it has been queued
   */
  private async notifyPRQueued(params: {
    owner: string;
    repo: string;
    prNumber: number;
    activePR: number;
  }): Promise<void> {
    const { owner, repo, prNumber, activePR } = params;
    
    const message = `## ⏳ Auto-Fix Queued

Another pull request (#${activePR}) is currently being auto-fixed in this repository.

To prevent merge conflicts and duplicate fixes, only one PR can be auto-fixed at a time.

**Your PR has been queued** and will be processed automatically after PR #${activePR} is:
- Merged, or
- Has its fix completed

You can also:
- Wait for the queue to process
- Fix the issues manually
- Use \`/autofix\` later to request a new attempt

_This ensures clean git history and prevents conflicting automated changes._`;

    await this.postComment(owner, repo, prNumber, message);
  }

  /**
   * Trigger PR analysis from external sources (e.g., MultiRepoScanner)
   * 
   * This method allows programmatic triggering of the self-healing pipeline
   * for a specific PR. It's used by the MultiRepoScanner to process PRs
   * discovered during periodic scans.
   * 
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   */
  async triggerPRAnalysis(owner: string, repo: string, prNumber: number): Promise<void> {
    this.logger.info({
      owner,
      repo,
      prNumber,
      source: 'scanner',
    }, 'Triggering PR analysis from scanner');
    
    // Check if auto-fix is enabled and attempts available
    if (!this.enableAutoFix) {
      this.logger.info({ owner, repo, prNumber }, 'Auto-fix disabled, skipping scanner-triggered analysis');
      return;
    }
    
    if (!this.canAttemptFix(repo, prNumber)) {
      this.logger.info({
        owner,
        repo,
        prNumber,
      }, 'Auto-fix limit reached, skipping scanner-triggered analysis');
      return;
    }
    
    // Try to acquire lock for this repo
    const lockAcquired = this.tryAcquireRepoLock(owner, repo, prNumber);
    
    if (!lockAcquired) {
      this.logger.info({
        owner,
        repo,
        prNumber,
        activePR: this.getActiveFixPR(repo),
      }, 'Another PR is being fixed in this repo, scanner-triggered PR queued');
      return;
    }
    
    this.logger.info({
      owner,
      repo,
      prNumber,
    }, 'Acquired repo lock, triggering analysis from scanner');
    
    try {
      // Get the PR's failing checks
      const { data: checkRuns } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref: `pull/${prNumber}/head`,
      });
      
      // Find the first failed check to trigger analysis
      const failedCheck = checkRuns.check_runs.find(
        c => c.status === 'completed' && 
             (c.conclusion === 'failure' || c.conclusion === 'timed_out')
      );
      
      if (!failedCheck) {
        this.logger.info({
          owner,
          repo,
          prNumber,
        }, 'No failed checks found during scanner analysis - PR may have been fixed');
        this.releaseRepoLock(repo, prNumber);
        this.processNextQueuedPR(owner, repo);
        return;
      }
      
      // Trigger processing through the pipeline monitor
      await this.pipelineMonitor.processCheckRunEvent({
        action: 'completed',
        check_run: {
          id: failedCheck.id,
          name: failedCheck.name,
          status: failedCheck.status,
          conclusion: failedCheck.conclusion as string,
          pull_requests: [{ number: prNumber }],
        },
        repository: {
          name: repo,
          owner: { login: owner },
        },
      });
      
      this.emit('scanner:pr-analyzed', { owner, repo, prNumber, checkName: failedCheck.name });
    } catch (error) {
      this.logger.error({
        error,
        owner,
        repo,
        prNumber,
      }, 'Failed to trigger PR analysis from scanner');
      this.releaseRepoLock(repo, prNumber);
      this.processNextQueuedPR(owner, repo);
      throw error;
    }
  }

  /**
   * Get automation statistics
   */
  getStats(): {
    pipelinesMonitored: number;
    fixesAttempted: number;
    fixesSuccessful: number;
    mergesApproved: number;
    mergesCompleted: number;
    prsQueued: number;
    activeFixAttempts: number;
    lockedRepos: number;
  } {
    return {
      ...this.stats,
      activeFixAttempts: this.fixAttempts.size,
      lockedRepos: this.repoLocks.size,
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    services: {
      pipelineMonitor: boolean;
      mergeApproval: boolean;
    };
    stats: ReturnType<PipelineAutomation['getStats']>;
    locks: Array<{ repo: string; activePR: number; queueLength: number }>;
  }> {
    const locks: Array<{ repo: string; activePR: number; queueLength: number }> = [];
    for (const [key, lock] of this.repoLocks.entries()) {
      locks.push({
        repo: key,
        activePR: lock.activePR,
        queueLength: lock.queue.length,
      });
    }
    
    return {
      healthy: true,
      services: {
        pipelineMonitor: this.enableAutoFix,
        mergeApproval: this.enableMergeApproval,
      },
      stats: this.getStats(),
      locks,
    };
  }
}
