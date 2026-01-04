import { Octokit } from '@octokit/rest';
import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';

/**
 * Merge request from a human
 */
export interface MergeApprovalRequest {
  owner: string;
  repo: string;
  prNumber: number;
  requestedBy: string;
  requestedAt: string;
  mergeMethod: 'merge' | 'squash' | 'rebase';
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
}

/**
 * Configuration for Merge Approval Service
 */
export interface MergeApprovalConfig {
  token: string;
  organization: string;
  logLevel?: string;
  /** Users allowed to approve merges */
  allowedApprovers?: string[];
  /** Require explicit approval before merge */
  requireExplicitApproval?: boolean;
  /** Default merge method */
  defaultMergeMethod?: 'merge' | 'squash' | 'rebase';
  /** Labels required before merge */
  requiredLabels?: string[];
  /** Labels that block merge */
  blockingLabels?: string[];
}

/**
 * MergeApprovalService - Human-in-the-loop merge approval workflow
 * 
 * Features:
 * - Handles /approve and /merge commands from PR comments
 * - Validates that all checks are passing before merge
 * - Tracks approval requests and merge history
 * - Enforces human-in-the-loop for final merge decision
 * 
 * Commands:
 * - /approve - Approve the PR for merge
 * - /merge [method] - Merge the PR (requires prior approval or self-approval)
 * - /merge squash - Merge with squash
 * - /merge rebase - Merge with rebase
 * - /hold - Place a hold on the PR (prevent merge)
 * - /unhold - Remove the hold
 */
export class MergeApprovalService extends EventEmitter {
  private octokit: Octokit;
  private logger: Logger;
  private config: MergeApprovalConfig;
  
  // Track pending approval requests
  private pendingRequests: Map<string, MergeApprovalRequest> = new Map();

  constructor(config: MergeApprovalConfig) {
    super();
    this.config = {
      requireExplicitApproval: config.requireExplicitApproval ?? false,
      defaultMergeMethod: config.defaultMergeMethod || 'squash',
      requiredLabels: config.requiredLabels || [],
      blockingLabels: config.blockingLabels || ['do-not-merge', 'wip', 'work-in-progress'],
      ...config,
    };
    this.octokit = new Octokit({
      auth: config.token,
    });
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'merge-approval',
    });
  }

  /**
   * Process a PR comment that may contain a command
   */
  async processComment(payload: {
    action: string;
    comment: {
      id: number;
      body: string;
      user: { login: string };
    };
    issue: {
      number: number;
      pull_request?: unknown;
    };
    repository: { name: string; owner: { login: string } };
  }): Promise<void> {
    const { action, comment, issue, repository } = payload;
    
    // Only process new comments on PRs
    if (action !== 'created' || !issue.pull_request) {
      return;
    }

    const owner = repository.owner.login;
    const repo = repository.name;
    const prNumber = issue.number;
    const sender = comment.user.login;
    const body = comment.body.trim().toLowerCase();

    this.logger.info({
      owner,
      repo,
      prNumber,
      sender,
      command: body.split('\n')[0],
    }, 'Processing PR comment');

    // Parse commands
    if (body.startsWith('/approve')) {
      await this.handleApproveCommand(owner, repo, prNumber, sender);
    } else if (body.startsWith('/merge')) {
      const method = this.parseMergeMethod(body);
      await this.handleMergeCommand(owner, repo, prNumber, sender, method);
    } else if (body.startsWith('/hold')) {
      await this.handleHoldCommand(owner, repo, prNumber, sender);
    } else if (body.startsWith('/unhold')) {
      await this.handleUnholdCommand(owner, repo, prNumber, sender);
    } else if (body.startsWith('/autofix')) {
      // Emit event for pipeline monitor to handle
      this.emit('autofix-requested', { owner, repo, prNumber, sender });
    }
  }

  /**
   * Parse merge method from command
   */
  private parseMergeMethod(body: string): 'merge' | 'squash' | 'rebase' {
    if (body.includes('squash')) return 'squash';
    if (body.includes('rebase')) return 'rebase';
    if (body.includes('merge')) {
      // If explicit 'merge' is mentioned after /merge, use regular merge
      const parts = body.split(/\s+/);
      if (parts.length > 1 && parts[1] === 'merge') return 'merge';
    }
    return this.config.defaultMergeMethod!;
  }

  /**
   * Handle /approve command
   */
  async handleApproveCommand(owner: string, repo: string, prNumber: number, sender: string): Promise<void> {
    const prKey = `${owner}/${repo}#${prNumber}`;

    // Check if sender is allowed to approve
    if (this.config.allowedApprovers && this.config.allowedApprovers.length > 0) {
      if (!this.config.allowedApprovers.includes(sender)) {
        await this.postComment(owner, repo, prNumber,
          `❌ @${sender} is not authorized to approve merges.\n\n` +
          `Authorized approvers: ${this.config.allowedApprovers.map(u => `@${u}`).join(', ')}`
        );
        return;
      }
    }

    // Check PR status
    const validation = await this.validatePRForMerge(owner, repo, prNumber);
    
    if (!validation.checksPass) {
      await this.postComment(owner, repo, prNumber,
        `⚠️ Cannot approve - some checks are failing or pending.\n\n` +
        `Please wait for all checks to pass before approving.`
      );
      return;
    }

    if (validation.blockingLabels.length > 0) {
      await this.postComment(owner, repo, prNumber,
        `⚠️ Cannot approve - PR has blocking labels:\n` +
        validation.blockingLabels.map(l => `- \`${l}\``).join('\n')
      );
      return;
    }

    // Create approval request
    const request: MergeApprovalRequest = {
      owner,
      repo,
      prNumber,
      requestedBy: sender,
      requestedAt: new Date().toISOString(),
      mergeMethod: this.config.defaultMergeMethod!,
      approved: true,
      approvedBy: sender,
      approvedAt: new Date().toISOString(),
    };

    this.pendingRequests.set(prKey, request);

    // Add approval label
    await this.addLabel(owner, repo, prNumber, 'approved');

    // Create GitHub PR review approval
    await this.createApprovalReview(owner, repo, prNumber, sender);

    await this.postComment(owner, repo, prNumber,
      `## ✅ PR Approved\n\n` +
      `Approved by @${sender} at ${new Date().toISOString()}\n\n` +
      `**Ready to merge!** Use \`/merge\` or \`/merge squash\` to merge this PR.`
    );

    this.emit('pr:approved', { owner, repo, prNumber, approvedBy: sender });
  }

  /**
   * Handle /merge command
   */
  async handleMergeCommand(
    owner: string,
    repo: string,
    prNumber: number,
    sender: string,
    method: 'merge' | 'squash' | 'rebase'
  ): Promise<void> {
    const prKey = `${owner}/${repo}#${prNumber}`;

    // Validate PR can be merged
    const validation = await this.validatePRForMerge(owner, repo, prNumber);

    if (!validation.checksPass) {
      await this.postComment(owner, repo, prNumber,
        `❌ Cannot merge - some checks are failing or pending.\n\n` +
        `**Status:**\n` +
        `- Passed: ${validation.passedChecks}\n` +
        `- Failed: ${validation.failedChecks}\n` +
        `- Pending: ${validation.pendingChecks}\n\n` +
        `Please wait for all checks to pass.`
      );
      return;
    }

    if (validation.blockingLabels.length > 0) {
      await this.postComment(owner, repo, prNumber,
        `❌ Cannot merge - PR has blocking labels:\n` +
        validation.blockingLabels.map(l => `- \`${l}\``).join('\n') + '\n\n' +
        `Remove blocking labels with \`/unhold\` or manually.`
      );
      return;
    }

    if (!validation.mergeable) {
      await this.postComment(owner, repo, prNumber,
        `❌ Cannot merge - PR is not mergeable.\n\n` +
        `**Reason:** ${validation.mergeableState || 'Unknown'}\n\n` +
        `This may be due to merge conflicts or branch protection rules.`
      );
      return;
    }

    // Check for required approval
    if (this.config.requireExplicitApproval) {
      const request = this.pendingRequests.get(prKey);
      if (!request?.approved) {
        await this.postComment(owner, repo, prNumber,
          `⚠️ PR requires explicit approval before merge.\n\n` +
          `Use \`/approve\` first, then \`/merge\`.`
        );
        return;
      }
    }

    // Perform the merge
    try {
      const { data: pr } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      const { data: result } = await this.octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        commit_title: `${pr.title} (#${prNumber})`,
        commit_message: this.generateMergeMessage(pr, sender, method),
        merge_method: method,
      });

      // Clean up
      this.pendingRequests.delete(prKey);

      await this.postComment(owner, repo, prNumber,
        `## 🎉 PR Merged!\n\n` +
        `**Merge Method:** ${method}\n` +
        `**Commit SHA:** \`${result.sha}\`\n` +
        `**Merged by:** @${sender}\n\n` +
        `*Thank you for your contribution!*`
      );

      this.emit('pr:merged', { owner, repo, prNumber, mergedBy: sender, sha: result.sha, method });

    } catch (error: any) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to merge PR');
      await this.postComment(owner, repo, prNumber,
        `❌ Merge failed: ${error.message || 'Unknown error'}\n\n` +
        `Please check branch protection rules and try again.`
      );
    }
  }

  /**
   * Handle /hold command
   */
  async handleHoldCommand(owner: string, repo: string, prNumber: number, sender: string): Promise<void> {
    await this.addLabel(owner, repo, prNumber, 'do-not-merge');
    await this.postComment(owner, repo, prNumber,
      `## 🛑 Hold Placed\n\n` +
      `@${sender} has placed a hold on this PR.\n\n` +
      `Use \`/unhold\` to remove the hold when ready to merge.`
    );
  }

  /**
   * Handle /unhold command  
   */
  async handleUnholdCommand(owner: string, repo: string, prNumber: number, sender: string): Promise<void> {
    await this.removeLabel(owner, repo, prNumber, 'do-not-merge');
    await this.postComment(owner, repo, prNumber,
      `## ✅ Hold Removed\n\n` +
      `@${sender} has removed the hold on this PR.\n\n` +
      `This PR can now be merged if all checks pass.`
    );
  }

  /**
   * Validate if a PR can be merged
   */
  async validatePRForMerge(owner: string, repo: string, prNumber: number): Promise<{
    checksPass: boolean;
    passedChecks: number;
    failedChecks: number;
    pendingChecks: number;
    mergeable: boolean;
    mergeableState: string | null;
    blockingLabels: string[];
    missingLabels: string[];
  }> {
    const result = {
      checksPass: false,
      passedChecks: 0,
      failedChecks: 0,
      pendingChecks: 0,
      mergeable: false,
      mergeableState: null as string | null,
      blockingLabels: [] as string[],
      missingLabels: [] as string[],
    };

    try {
      // Get PR details
      const { data: pr } = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });

      result.mergeable = pr.mergeable ?? false;
      result.mergeableState = pr.mergeable_state;

      // Check labels
      const labels = (pr.labels as Array<{ name: string }>).map(l => l.name.toLowerCase());
      
      for (const blocking of this.config.blockingLabels || []) {
        if (labels.includes(blocking.toLowerCase())) {
          result.blockingLabels.push(blocking);
        }
      }

      for (const required of this.config.requiredLabels || []) {
        if (!labels.includes(required.toLowerCase())) {
          result.missingLabels.push(required);
        }
      }

      // Get check runs
      const { data: checkRuns } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref: pr.head.sha,
      });

      for (const run of checkRuns.check_runs) {
        if (run.status !== 'completed') {
          result.pendingChecks++;
        } else if (run.conclusion === 'success' || run.conclusion === 'skipped') {
          result.passedChecks++;
        } else {
          result.failedChecks++;
        }
      }

      result.checksPass = result.failedChecks === 0 && result.pendingChecks === 0;

    } catch (error) {
      this.logger.error({ error, owner, repo, prNumber }, 'Failed to validate PR');
    }

    return result;
  }

  /**
   * Generate merge commit message
   */
  private generateMergeMessage(
    pr: { title: string; body: string | null; user: { login: string } | null },
    mergedBy: string,
    method: string
  ): string {
    const parts = [];
    
    if (pr.body) {
      parts.push(pr.body);
    }
    
    parts.push('');
    parts.push('---');
    parts.push(`Merged by: @${mergedBy}`);
    parts.push(`Method: ${method}`);
    parts.push(`Author: @${pr.user?.login || 'unknown'}`);
    parts.push('');
    parts.push('*Automated merge via XORNG Automation*');
    
    return parts.join('\n');
  }

  /**
   * Create an approval review on the PR
   */
  private async createApprovalReview(owner: string, repo: string, prNumber: number, approver: string): Promise<void> {
    try {
      await this.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: `✅ Approved via XORNG automation command by @${approver}`,
        event: 'APPROVE',
      });
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber }, 'Failed to create approval review (may lack permissions)');
    }
  }

  /**
   * Comment markers for upsert pattern
   */
  private static readonly COMMENT_MARKERS = {
    APPROVAL_STATUS: '<!-- XORNG-APPROVAL-STATUS -->',
    MERGE_STATUS: '<!-- XORNG-MERGE-STATUS -->',
    HOLD_STATUS: '<!-- XORNG-HOLD-STATUS -->',
  } as const;

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
   * Post a comment on the PR
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
   * Add a label to the PR
   */
  private async addLabel(owner: string, repo: string, prNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [label],
      });
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber, label }, 'Failed to add label');
    }
  }

  /**
   * Remove a label from the PR
   */
  private async removeLabel(owner: string, repo: string, prNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: prNumber,
        name: label,
      });
    } catch (error) {
      this.logger.warn({ error, owner, repo, prNumber, label }, 'Failed to remove label (may not exist)');
    }
  }
}
