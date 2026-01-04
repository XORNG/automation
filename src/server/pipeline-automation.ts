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
 * Cross-repository learning issue - tracks issues that may need fixes in other repositories
 * Example: Bad recommendation in knowledge-best-practices causing failures in core
 */
interface CrossRepoLearningIssue {
  /** Repository where the symptom appeared (e.g., core) */
  sourceRepo: {
    owner: string;
    repo: string;
    prNumber: number;
  };
  /** Repository where the root cause is (e.g., knowledge-best-practices) */
  targetRepo: {
    owner: string;
    repo: string;
  };
  /** Type of cross-repo issue */
  issueType: 'knowledge-correction' | 'template-update' | 'dependency-fix' | 'config-change';
  /** Detailed analysis of the root cause */
  rootCauseAnalysis: string;
  /** Suggested fix for the target repository */
  suggestedFix?: string;
}

/**
 * Root cause analysis result from AI
 */
interface RootCauseAnalysis {
  /** Whether the issue is in the current repository */
  isLocalIssue: boolean;
  /** If cross-repo, which repository contains the root cause */
  targetRepository?: {
    owner: string;
    repo: string;
  };
  /** Type of issue if cross-repo */
  crossRepoIssueType?: CrossRepoLearningIssue['issueType'];
  /** Detailed explanation of the root cause */
  explanation: string;
  /** Suggested fix description */
  suggestedFix?: string;
  /** Confidence level 0-1 */
  confidence: number;
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
      await this.upsertComment(data.owner, data.repo, data.prNumber,
        `@${data.requester} Cannot start auto-fix right now. PR #${activePR} is currently being fixed in this repository.\n\nYour request has been queued and will be processed after PR #${activePR} is merged or its fix completes.`,
        PipelineAutomation.COMMENT_MARKERS.QUEUE_STATUS
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
      await this.upsertComment(data.owner, data.repo, data.prNumber,
        `@${data.requester} All checks are already passing! ✅`,
        PipelineAutomation.COMMENT_MARKERS.AUTO_FIX
      );
      return;
    }
    
    // Trigger autofix analysis
    await this.upsertComment(data.owner, data.repo, data.prNumber,
      `@${data.requester} Analyzing pipeline failures and attempting auto-fix... 🔧`,
      PipelineAutomation.COMMENT_MARKERS.AUTO_FIX
    );
    
    await this.pipelineMonitor.handlePRPipelineFailure(
      data.owner,
      data.repo,
      data.prNumber
    );
  }

  /**
   * Notify that a PR is ready for merge
   * Uses upsert pattern to avoid spamming merge-ready comments
   */
  private async notifyMergeReady(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<void> {
    const { owner, repo, prNumber } = params;
    
    const message = `## ✅ Pipeline Checks Passing

All CI/CD checks have passed for this pull request.

**Available commands:**
- \`/approve\` - Approve this PR for merging
- \`/merge\` - Merge using default method (squash)
- \`/merge squash\` - Squash and merge
- \`/merge merge\` - Create a merge commit
- \`/merge rebase\` - Rebase and merge

_Only users with write access can use these commands._`;

    // Use upsert to update existing merge-ready comment instead of creating new ones
    await this.upsertComment(owner, repo, prNumber, message, PipelineAutomation.COMMENT_MARKERS.MERGE_READY);
    this.emit('merge:ready', { owner, repo, prNumber });
  }

  /**
 * Request human intervention when auto-fix is not possible
 * Follows learning-first approach: create tracking issue before requesting intervention
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
    
    // Create a learning issue to track this failure for future improvement
    const learningIssueUrl = await this.createLearningIssue(params);
    
    const message = `## 🚨 Human Intervention Required

The automated pipeline fix system was unable to resolve the failing checks.

**Reason:** ${reason}
${failedCheck ? `**Failed Check:** ${failedCheck}` : ''}
${failedWorkflow ? `**Failed Workflow:** ${failedWorkflow}` : ''}
**Auto-fix Attempts:** ${attempts?.attempts || 0}/3
${learningIssueUrl ? `\n**Tracking Issue:** ${learningIssueUrl}` : ''}

**Available commands:**
- \`/autofix\` - Retry auto-fix (resets attempt counter)
- \`/hold\` - Mark this PR as blocked

Please review the failure logs and make the necessary fixes manually.`;

    // Use upsert to avoid comment spam
    await this.upsertComment(owner, repo, prNumber, message, PipelineAutomation.COMMENT_MARKERS.INTERVENTION);
    
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
   * Comment marker types for upsert operations (matching pipeline-monitor.ts)
   */
  private static readonly COMMENT_MARKERS = {
    PIPELINE_ANALYSIS: '<!-- XORNG-PIPELINE-ANALYSIS -->',
    AUTO_FIX: '<!-- XORNG-AUTO-FIX -->',
    MERGE_REQUEST: '<!-- XORNG-MERGE-REQUEST -->',
    MERGE_READY: '<!-- XORNG-MERGE-READY -->',
    INTERVENTION: '<!-- XORNG-INTERVENTION -->',
    QUEUE_STATUS: '<!-- XORNG-QUEUE-STATUS -->',
  } as const;

  /**
   * Create a learning issue to track fix failures for future improvement
   * Learning-first workflow: Issues are created to track problems, then PRs reference them
   * 
   * Enhanced with cross-repository root cause analysis:
   * - Analyzes if the issue originates from another repository (e.g., knowledge-best-practices)
   * - Creates issues in the appropriate target repository
   * - Links issues across repositories for tracking
   */
  private async createLearningIssue(params: {
    owner: string;
    repo: string;
    prNumber: number;
    reason: string;
    failedCheck?: string;
    failedWorkflow?: string;
  }): Promise<string | null> {
    const { owner, repo, prNumber, reason, failedCheck, failedWorkflow } = params;
    
    try {
      // Check if a learning issue already exists for this PR
      const existingIssue = await this.findLearningIssueForPR(owner, repo, prNumber);
      if (existingIssue) {
        // Update the existing issue with new failure info
        await this.updateLearningIssue(owner, repo, existingIssue, {
          failedCheck,
          failedWorkflow,
          reason,
        });
        return existingIssue.html_url;
      }

      // Analyze root cause to determine if issue is cross-repository
      const rootCauseAnalysis = await this.analyzeRootCause({
        owner,
        repo,
        prNumber,
        reason,
        failedCheck,
        failedWorkflow,
      });

      // Determine target repository for the learning issue
      let targetOwner = owner;
      let targetRepo = repo;
      let isCrossRepo = false;

      if (rootCauseAnalysis && !rootCauseAnalysis.isLocalIssue && rootCauseAnalysis.targetRepository) {
        targetOwner = rootCauseAnalysis.targetRepository.owner;
        targetRepo = rootCauseAnalysis.targetRepository.repo;
        isCrossRepo = true;
        
        this.logger.info({
          sourceRepo: `${owner}/${repo}`,
          targetRepo: `${targetOwner}/${targetRepo}`,
          issueType: rootCauseAnalysis.crossRepoIssueType,
        }, 'Detected cross-repository root cause');
      }

      // Build issue body with cross-repo context
      const issueBody = this.buildLearningIssueBody({
        owner,
        repo,
        prNumber,
        reason,
        failedCheck,
        failedWorkflow,
        isCrossRepo,
        targetOwner,
        targetRepo,
        rootCauseAnalysis,
      });

      // Create learning issue in target repository
      const { data: issue } = await this.octokit.issues.create({
        owner: targetOwner,
        repo: targetRepo,
        title: isCrossRepo
          ? `[Learning][Cross-Repo] Fix needed for ${owner}/${repo}#${prNumber}`
          : `[Learning] Auto-fix failure analysis for PR #${prNumber}`,
        body: issueBody,
        labels: isCrossRepo 
          ? ['learning', 'automation-feedback', 'cross-repo', rootCauseAnalysis?.crossRepoIssueType || 'investigation']
          : ['learning', 'automation-feedback'],
      });

      this.logger.info({
        targetOwner,
        targetRepo,
        prNumber,
        issueNumber: issue.number,
        isCrossRepo,
      }, 'Created learning issue for fix failure');

      // If cross-repo, also add a reference comment on the original PR
      if (isCrossRepo) {
        await this.upsertComment(owner, repo, prNumber,
          `## 🔗 Cross-Repository Issue Identified

The root cause of this failure appears to be in **${targetOwner}/${targetRepo}**.

**Analysis:** ${rootCauseAnalysis?.explanation || 'Further investigation needed'}
**Tracking Issue:** ${issue.html_url}

The fix should be applied to ${targetOwner}/${targetRepo}, not this repository.`,
          PipelineAutomation.COMMENT_MARKERS.INTERVENTION
        );
      }

      // Emit event for learning service
      this.emit('learning:issue-created', {
        owner: targetOwner,
        repo: targetRepo,
        prNumber,
        issueNumber: issue.number,
        reason,
        failedCheck,
        failedWorkflow,
        isCrossRepo,
        sourceRepo: isCrossRepo ? { owner, repo } : undefined,
      });

      return issue.html_url;
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber }, 'Failed to create learning issue');
      return null;
    }
  }

  /**
   * Analyze root cause to determine if issue is in another repository
   * Uses AI to identify cross-repo issues like bad recommendations in knowledge bases
   */
  private async analyzeRootCause(params: {
    owner: string;
    repo: string;
    prNumber: number;
    reason: string;
    failedCheck?: string;
    failedWorkflow?: string;
  }): Promise<RootCauseAnalysis | null> {
    if (!this.aiService.isEnabled()) {
      return null;
    }

    const { owner, repo, prNumber, reason, failedCheck, failedWorkflow } = params;

    try {
      // Build context about the XORNG ecosystem for AI analysis
      const ecosystemContext = `
XORNG Ecosystem Repositories:
- knowledge-best-practices: Contains best practice recommendations and coding guidelines
- knowledge-documentation: Documentation sources and templates
- validator-security: Security validation rules and checks
- validator-code-review: Code review validation rules
- core: Core functionality and learning service
- automation: CI/CD automation and pipeline monitoring
- template-*: Template repositories for creating new components
- node: Node management and model registry

Cross-Repository Issue Types:
- knowledge-correction: Wrong or outdated recommendation in knowledge-* repos
- template-update: Template needs updating based on learned patterns
- dependency-fix: Issue in a shared dependency
- config-change: Configuration needs updating in another repo
`;

      const prompt = `Analyze this pipeline failure and determine if the root cause is in the current repository or another repository.

**Current Repository:** ${owner}/${repo}
**PR Number:** #${prNumber}
**Failure Reason:** ${reason}
${failedCheck ? `**Failed Check:** ${failedCheck}` : ''}
${failedWorkflow ? `**Failed Workflow:** ${failedWorkflow}` : ''}

${ecosystemContext}

Respond with JSON:
{
  "isLocalIssue": true/false,
  "targetRepository": { "owner": "string", "repo": "string" } | null,
  "crossRepoIssueType": "knowledge-correction" | "template-update" | "dependency-fix" | "config-change" | null,
  "explanation": "Detailed explanation of the root cause",
  "suggestedFix": "Description of how to fix the issue",
  "confidence": 0.0-1.0
}

Examples of cross-repo issues:
- If the failure mentions "following best practice X" but X is wrong → knowledge-correction in knowledge-best-practices
- If the failure is due to an outdated template pattern → template-update in template-*
- If a validator is too strict or has bugs → dependency-fix in validator-*

Be conservative: only identify cross-repo issues when you're confident (>0.7).`;

      const response = await this.aiService.chatCompletion([
        {
          role: 'system',
          content: 'You are an expert at analyzing CI/CD failures and identifying root causes across a monorepo ecosystem. Respond only with valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], {
        maxTokens: 1000,
        temperature: 0.3,
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const analysis: RootCauseAnalysis = JSON.parse(jsonMatch[0]);
      
      // Only accept cross-repo analysis if confidence is high enough
      if (!analysis.isLocalIssue && analysis.confidence < 0.7) {
        this.logger.debug({
          analysis,
        }, 'Cross-repo analysis confidence too low, treating as local issue');
        return { ...analysis, isLocalIssue: true, targetRepository: undefined };
      }

      return analysis;
    } catch (error) {
      this.logger.warn({ error }, 'Failed to analyze root cause');
      return null;
    }
  }

  /**
   * Build learning issue body with cross-repo context
   */
  private buildLearningIssueBody(params: {
    owner: string;
    repo: string;
    prNumber: number;
    reason: string;
    failedCheck?: string;
    failedWorkflow?: string;
    isCrossRepo: boolean;
    targetOwner: string;
    targetRepo: string;
    rootCauseAnalysis: RootCauseAnalysis | null;
  }): string {
    const { owner, repo, prNumber, reason, failedCheck, failedWorkflow, isCrossRepo, rootCauseAnalysis } = params;

    if (isCrossRepo && rootCauseAnalysis) {
      return `## 🧠 Cross-Repository Learning Opportunity

This issue tracks a fix needed in this repository due to a failure in another repository.

### Source Context
- **Affected Repository:** ${owner}/${repo}
- **Related PR:** ${owner}/${repo}#${prNumber}
- **Failure Reason:** ${reason}
${failedCheck ? `- **Failed Check:** ${failedCheck}` : ''}
${failedWorkflow ? `- **Failed Workflow:** ${failedWorkflow}` : ''}
- **Created:** ${new Date().toISOString()}

### Root Cause Analysis
**Issue Type:** ${rootCauseAnalysis.crossRepoIssueType}
**Confidence:** ${Math.round(rootCauseAnalysis.confidence * 100)}%

${rootCauseAnalysis.explanation}

### Suggested Fix
${rootCauseAnalysis.suggestedFix || 'Further investigation needed.'}

### Actions
- [ ] Review the root cause analysis
- [ ] Implement the fix in this repository
- [ ] Verify fix resolves the issue in ${owner}/${repo}#${prNumber}
- [ ] Update knowledge base with this pattern

### Impact
Fixing this issue will improve automation for the ${owner}/${repo} repository and potentially other repositories using the same patterns.

---
*This issue was automatically created by the XORNG Pipeline Automation system.*
*It tracks a cross-repository dependency where a fix here will resolve issues elsewhere.*

<!-- XORNG-LEARNING-ISSUE -->
<!-- CROSS_REPO: true -->
<!-- SOURCE_REPO: ${owner}/${repo} -->
<!-- SOURCE_PR: ${prNumber} -->`;
    }

    // Standard local learning issue
    return `## 🧠 Learning Opportunity

This issue tracks an auto-fix failure to improve future fix suggestions.

### Context
- **Related PR:** #${prNumber}
- **Failure Reason:** ${reason}
${failedCheck ? `- **Failed Check:** ${failedCheck}` : ''}
${failedWorkflow ? `- **Failed Workflow:** ${failedWorkflow}` : ''}
- **Created:** ${new Date().toISOString()}

### What Happened
The automation system attempted to fix pipeline failures but was unable to resolve them automatically.

### Learning Goals
1. Analyze what caused the fix to fail
2. Determine if the failure pattern can be recognized in the future
3. Add new fix patterns to the knowledge base

### Actions
- [ ] Review the failing check logs
- [ ] Identify the root cause
- [ ] Document fix patterns for similar issues
- [ ] Update automation knowledge base

---
*This issue was automatically created by the XORNG Pipeline Automation system to track learning opportunities.*
*When the related PR is resolved, please update this issue with learnings.*

<!-- XORNG-LEARNING-ISSUE -->
<!-- PR_NUMBER: ${prNumber} -->`;
  }

  /**
   * Find existing learning issue for a PR
   */
  private async findLearningIssueForPR(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<{ number: number; html_url: string } | null> {
    try {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner,
        repo,
        labels: 'learning',
        state: 'open',
        per_page: 100,
      });

      const learningIssue = issues.find(issue =>
        issue.body?.includes(`<!-- PR_NUMBER: ${prNumber} -->`)
      );

      return learningIssue ? { number: learningIssue.number, html_url: learningIssue.html_url } : null;
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber }, 'Failed to search for learning issue');
      return null;
    }
  }

  /**
   * Update an existing learning issue with new failure information
   */
  private async updateLearningIssue(
    owner: string,
    repo: string,
    issue: { number: number; html_url: string },
    newInfo: { failedCheck?: string; failedWorkflow?: string; reason: string }
  ): Promise<void> {
    try {
      await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `### New Fix Attempt Failed

- **Timestamp:** ${new Date().toISOString()}
- **Reason:** ${newInfo.reason}
${newInfo.failedCheck ? `- **Failed Check:** ${newInfo.failedCheck}` : ''}
${newInfo.failedWorkflow ? `- **Failed Workflow:** ${newInfo.failedWorkflow}` : ''}

*The automation system attempted to fix the related PR again but was unable to resolve the issues.*`,
      });
    } catch (error) {
      this.logger.warn({ error, owner, repo, issueNumber: issue.number }, 'Failed to update learning issue');
    }
  }

  /**
   * Find an existing comment by marker
   */
  private async findCommentByMarker(
    owner: string,
    repo: string,
    prNumber: number,
    marker: string
  ): Promise<number | null> {
    try {
      const { data: comments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });

      const existingComment = comments.find(comment =>
        comment.body?.includes(marker)
      );

      return existingComment?.id ?? null;
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber, marker }, 'Failed to list comments for marker search');
      return null;
    }
  }

  /**
   * Create or update a comment (upsert pattern)
   * Best practice: Use markers to identify bot comments and update them instead of creating spam
   */
  private async upsertComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    marker: string
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const bodyWithMarker = `${marker}\n${body}\n\n<sub>Last updated: ${timestamp}</sub>`;

    try {
      const existingCommentId = await this.findCommentByMarker(owner, repo, prNumber, marker);

      if (existingCommentId) {
        await this.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: existingCommentId,
          body: bodyWithMarker,
        });
        this.logger.debug({ owner, repo, prNumber, marker }, 'Updated existing comment');
      } else {
        await this.octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: bodyWithMarker,
        });
        this.logger.debug({ owner, repo, prNumber, marker }, 'Created new comment');
      }
    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber, marker }, 'Failed to upsert comment');
    }
  }

  /**
   * Post a comment on a PR (creates a new comment)
   * Use upsertComment for bot status updates to avoid comment spam
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
    await this.upsertComment(owner, repo, next.prNumber,
      `🔄 Your PR is now being processed for auto-fix. It was queued at ${next.queuedAt.toISOString()}.`,
      PipelineAutomation.COMMENT_MARKERS.QUEUE_STATUS
    );
    
    // Trigger pipeline check for this PR
    try {
      const status = await this.pipelineMonitor.getPRPipelineStatus(owner, repo, next.prNumber);
      
      if (status && !status.allPassed) {
        await this.pipelineMonitor.handlePRPipelineFailure(owner, repo, next.prNumber);
      } else {
        // PR might have been fixed manually or checks now pass
        this.releaseRepoLock(repo, next.prNumber);
        await this.upsertComment(owner, repo, next.prNumber,
          `✅ Pipeline checks are now passing! No auto-fix needed.`,
          PipelineAutomation.COMMENT_MARKERS.AUTO_FIX
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
   * Uses upsert pattern to avoid spam
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

    await this.upsertComment(owner, repo, prNumber, message, PipelineAutomation.COMMENT_MARKERS.QUEUE_STATUS);
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

  // ==========================================================================
  // Repository Creation from Learnings
  // ==========================================================================

  /**
   * Create a new repository based on learned patterns
   * 
   * This method allows the automation to create new repositories when learnings
   * suggest a new component, validator, or knowledge source is needed.
   * 
   * Uses GitHub's template repository feature for consistent structure.
   * 
   * @param params Configuration for the new repository
   * @returns URL of the created repository or null if failed
   */
  async createRepositoryFromLearning(params: {
    /** Name for the new repository */
    name: string;
    /** Description of the repository */
    description: string;
    /** Template repository to use (e.g., template-validator, template-knowledge) */
    templateRepo: 'template-base' | 'template-knowledge' | 'template-task' | 'template-validator';
    /** Organization to create the repo in (defaults to config organization) */
    organization?: string;
    /** Whether the repository should be private */
    isPrivate?: boolean;
    /** Learning issue that triggered this creation */
    learningIssue?: {
      owner: string;
      repo: string;
      number: number;
    };
    /** Initial configuration or customization for the new repo */
    customization?: {
      /** Files to create or modify after cloning */
      files?: Array<{
        path: string;
        content: string;
      }>;
      /** Topics/tags to add */
      topics?: string[];
    };
  }): Promise<string | null> {
    const {
      name,
      description,
      templateRepo,
      organization,
      isPrivate = false,
      learningIssue,
      customization,
    } = params;

    try {
      // Get organization from config if not specified
      const targetOrg = organization || this.pipelineMonitor['config'].organization;
      
      this.logger.info({
        name,
        templateRepo,
        targetOrg,
        hasLearningIssue: !!learningIssue,
      }, 'Creating new repository from learning');

      // Step 1: Create repository from template
      const { data: newRepo } = await this.octokit.repos.createUsingTemplate({
        template_owner: targetOrg,
        template_repo: templateRepo,
        owner: targetOrg,
        name,
        description,
        private: isPrivate,
        include_all_branches: false,
      });

      this.logger.info({
        repoUrl: newRepo.html_url,
        name: newRepo.name,
      }, 'Repository created from template');

      // Step 2: Apply customizations if any
      if (customization?.files && customization.files.length > 0) {
        // Wait a moment for repo to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        for (const file of customization.files) {
          try {
            await this.octokit.repos.createOrUpdateFileContents({
              owner: targetOrg,
              repo: name,
              path: file.path,
              message: `chore: Initialize ${file.path} from learning`,
              content: Buffer.from(file.content).toString('base64'),
            });
          } catch (error) {
            this.logger.warn({ error, file: file.path }, 'Failed to create customization file');
          }
        }
      }

      // Step 3: Add topics if specified
      if (customization?.topics && customization.topics.length > 0) {
        try {
          await this.octokit.repos.replaceAllTopics({
            owner: targetOrg,
            repo: name,
            names: ['xorng', 'automation', ...customization.topics],
          });
        } catch (error) {
          this.logger.warn({ error }, 'Failed to set repository topics');
        }
      }

      // Step 4: If triggered by learning issue, update the issue
      if (learningIssue) {
        await this.octokit.issues.createComment({
          owner: learningIssue.owner,
          repo: learningIssue.repo,
          issue_number: learningIssue.number,
          body: `## 🚀 New Repository Created

A new repository has been created based on this learning:

**Repository:** [${targetOrg}/${name}](${newRepo.html_url})
**Template:** ${templateRepo}
**Description:** ${description}

### Next Steps
- [ ] Review the generated repository structure
- [ ] Customize implementation based on learning goals
- [ ] Add tests and documentation
- [ ] Set up CI/CD pipeline
- [ ] Create initial PR with implementation

---
*Repository automatically created by XORNG Learning System*`,
        });

        // Also update issue labels
        try {
          await this.octokit.issues.addLabels({
            owner: learningIssue.owner,
            repo: learningIssue.repo,
            issue_number: learningIssue.number,
            labels: ['repo-created'],
          });
        } catch {
          // Label may not exist
        }
      }

      // Emit event for tracking
      this.emit('learning:repo-created', {
        name,
        url: newRepo.html_url,
        templateRepo,
        learningIssue,
      });

      return newRepo.html_url;
    } catch (error) {
      this.logger.error({ error, name, templateRepo }, 'Failed to create repository from learning');
      
      // If we have a learning issue, comment about the failure
      if (learningIssue) {
        try {
          await this.octokit.issues.createComment({
            owner: learningIssue.owner,
            repo: learningIssue.repo,
            issue_number: learningIssue.number,
            body: `## ❌ Repository Creation Failed

Failed to create repository **${name}** from template **${templateRepo}**.

**Error:** ${error instanceof Error ? error.message : 'Unknown error'}

Please create the repository manually.`,
          });
        } catch {
          // Ignore comment failure
        }
      }
      
      return null;
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
