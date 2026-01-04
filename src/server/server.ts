#!/usr/bin/env node

/**
 * XORNG Automation Server
 * 
 * Main entry point for the automation web service.
 * Handles:
 * - GitHub webhooks for all organization repositories
 * - VS Code extension feedback loop
 * - Issue processing without label filtering (testing phase)
 * - Automatic repository discovery
 */

import { WebhookServer, type WebhookServerConfig } from './webhook-server.js';
import { GitHubOrgService } from './github-org-service.js';
import { IssueProcessor } from './issue-processor.js';
import { FeedbackService } from './feedback-service.js';
import { ServiceOrchestrator } from './service-orchestrator.js';
import { pino } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  name: 'xorng-automation-server',
});

/**
 * Server configuration from environment
 */
interface ServerConfig {
  port: number;
  host: string;
  githubToken: string;
  githubOrganization: string;
  webhookSecret?: string;
  webhookUrl?: string;
  logLevel: string;
  // Dynamic service orchestration
  serviceDiscoveryEnabled: boolean;
  registryUrl: string;
  autoDeployServices: boolean;
}

/**
 * Load configuration from environment
 */
function loadConfig(): ServerConfig {
  const config: ServerConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    githubToken: process.env.GITHUB_TOKEN || '',
    githubOrganization: process.env.GH_ORG || 'XORNG',
    webhookSecret: process.env.WEBHOOK_SECRET,
    webhookUrl: process.env.WEBHOOK_URL,
    logLevel: process.env.LOG_LEVEL || 'info',
    // Dynamic service orchestration
    serviceDiscoveryEnabled: process.env.SERVICE_DISCOVERY_ENABLED === 'true',
    registryUrl: process.env.REGISTRY_URL || 'ghcr.io',
    autoDeployServices: process.env.AUTO_DEPLOY_SERVICES === 'true',
  };

  if (!config.githubToken) {
    logger.error('GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  return config;
}

/**
 * Main server class
 */
export class AutomationServer {
  private config: ServerConfig;
  private webhookServer: WebhookServer;
  private githubOrgService: GitHubOrgService;
  private issueProcessor: IssueProcessor;
  private feedbackService: FeedbackService;
  private serviceOrchestrator?: ServiceOrchestrator;

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize services
    this.webhookServer = new WebhookServer({
      port: config.port,
      host: config.host,
      webhookSecret: config.webhookSecret,
      logLevel: config.logLevel,
      corsOrigins: ['*'], // Allow VS Code extension from anywhere
    });

    this.githubOrgService = new GitHubOrgService({
      token: config.githubToken,
      organization: config.githubOrganization,
      logLevel: config.logLevel,
      includePrivate: true, // Include private repos
    });

    this.issueProcessor = new IssueProcessor({
      token: config.githubToken,
      organization: config.githubOrganization,
      logLevel: config.logLevel,
    });

    this.feedbackService = new FeedbackService({
      logLevel: config.logLevel,
    });

    // Initialize service orchestrator if enabled
    if (config.serviceDiscoveryEnabled) {
      this.serviceOrchestrator = new ServiceOrchestrator({
        githubToken: config.githubToken,
        organization: config.githubOrganization,
        registryUrl: config.registryUrl,
        registryPassword: config.githubToken, // Use same token for GHCR
        networkName: 'xorng-network',
        autoDeployEnabled: config.autoDeployServices,
        logLevel: config.logLevel,
      });
    }

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers between services
   */
  private setupEventHandlers(): void {
    // Handle GitHub issue events (ALL issues - no label filtering)
    this.webhookServer.on('github:issues', async ({ action, payload }) => {
      logger.info({
        action,
        issue: payload.issue?.number,
        repo: payload.repository?.name,
      }, 'Received issue webhook - processing ALL issues (no label filtering)');

      if (payload.issue) {
        await this.issueProcessor.processIssueEvent({
          action,
          issue: {
            id: payload.issue.id,
            number: payload.issue.number,
            title: payload.issue.title,
            body: payload.issue.body,
            state: payload.issue.state,
            labels: payload.issue.labels,
            author: payload.issue.user.login,
            repository: payload.repository.name,
            repositoryOwner: payload.repository.owner.login,
            htmlUrl: payload.issue.html_url,
            createdAt: payload.issue.created_at,
            updatedAt: payload.issue.updated_at,
          },
          repository: payload.repository,
        });
      }
    });

    // Handle GitHub PR events
    this.webhookServer.on('github:pull_request', async ({ action, payload }) => {
      logger.info({
        action,
        pr: payload.pull_request?.number,
        repo: payload.repository?.name,
      }, 'Received pull request webhook');

      if (payload.pull_request) {
        await this.issueProcessor.processPullRequestEvent({
          action,
          pull_request: payload.pull_request,
          repository: payload.repository,
        });
      }
    });

    // Handle new repository events (auto-register webhook)
    this.webhookServer.on('github:repository:created', async ({ payload }) => {
      logger.info({
        repo: payload.repository?.name,
      }, 'New repository created - registering webhook');

      if (this.config.webhookUrl && payload.repository) {
        try {
          await this.githubOrgService.registerWebhook(
            payload.repository.name,
            this.config.webhookUrl,
            ['issues', 'issue_comment', 'pull_request', 'pull_request_review'],
            this.config.webhookSecret
          );
        } catch (error) {
          logger.error({ error, repo: payload.repository.name }, 'Failed to register webhook for new repo');
        }
      }
    });

    // Handle VS Code extension feedback
    this.webhookServer.on('feedback', (data) => {
      this.feedbackService.submitFeedback({
        type: data.type,
        source: data.source,
        extensionVersion: data.extensionVersion,
        data: data.data,
      });
    });

    // Handle VS Code extension telemetry
    this.webhookServer.on('telemetry', (data) => {
      this.feedbackService.submitTelemetry(data);
    });

    // Handle pending tasks request
    this.webhookServer.on('tasks:pending:request', ({ workspaceId, capabilities, respond }) => {
      const tasks = this.issueProcessor.getPendingTasks({ limit: 10 });
      respond(tasks);
    });

    // Handle task result from VS Code extension
    this.webhookServer.on('task:result', ({ taskId, status, result, error }) => {
      if (status === 'completed') {
        this.issueProcessor.completeTask(taskId, result);
      } else if (status === 'failed') {
        this.issueProcessor.failTask(taskId, error || 'Unknown error');
      }
    });

    // Log task lifecycle events
    this.issueProcessor.on('task:created', (task) => {
      logger.info({ taskId: task.id, type: task.type }, 'Task created');
    });

    this.issueProcessor.on('task:completed', (task) => {
      logger.info({ taskId: task.id, type: task.type }, 'Task completed');
    });

    this.issueProcessor.on('task:failed', (task) => {
      logger.error({ taskId: task.id, type: task.type, error: task.error }, 'Task failed');
    });

    // Log feedback events
    this.feedbackService.on('feedback:received', (feedback) => {
      logger.info({ 
        feedbackId: feedback.id, 
        type: feedback.type,
      }, 'Feedback received');
    });
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    logger.info({
      port: this.config.port,
      host: this.config.host,
      organization: this.config.githubOrganization,
    }, 'Starting XORNG Automation Server');

    // Start webhook server
    await this.webhookServer.start();

    // Discover all repositories
    logger.info('Discovering organization repositories...');
    const repos = await this.githubOrgService.listRepositories();
    logger.info({ count: repos.length }, 'Discovered repositories');

    // Register webhooks for all repositories if webhook URL is configured
    if (this.config.webhookUrl) {
      logger.info({ webhookUrl: this.config.webhookUrl }, 'Registering webhooks for all repositories');
      const results = await this.githubOrgService.registerWebhooksForAll(
        this.config.webhookUrl,
        ['issues', 'issue_comment', 'pull_request', 'pull_request_review'],
        this.config.webhookSecret
      );

      const successful = results.filter(r => r.hookId).length;
      const failed = results.filter(r => r.error).length;
      logger.info({ successful, failed }, 'Webhook registration complete');
    }

    // Sync open issues from all repositories
    logger.info('Syncing open issues from all repositories...');
    const allTasks = await this.issueProcessor.syncAllOpenIssues(
      repos.map(r => ({ name: r.name, owner: r.owner }))
    );
    logger.info({ taskCount: allTasks.length }, 'Initial sync complete');

    // Start periodic cleanup
    setInterval(() => {
      this.issueProcessor.cleanupOldTasks(24);
      this.feedbackService.cleanup(30);
    }, 60 * 60 * 1000); // Every hour

    // Start periodic repository check for new repos
    setInterval(async () => {
      const newRepos = await this.githubOrgService.checkForNewRepositories();
      if (newRepos.length > 0 && this.config.webhookUrl) {
        for (const repo of newRepos) {
          try {
            await this.githubOrgService.registerWebhook(
              repo.name,
              this.config.webhookUrl,
              ['issues', 'issue_comment', 'pull_request', 'pull_request_review'],
              this.config.webhookSecret
            );
            logger.info({ repo: repo.name }, 'Registered webhook for new repository');
          } catch (error) {
            logger.error({ error, repo: repo.name }, 'Failed to register webhook');
          }
        }
      }
    }, 5 * 60 * 1000); // Every 5 minutes

    // Start service orchestrator if enabled
    if (this.serviceOrchestrator) {
      logger.info('Starting dynamic service orchestrator...');
      await this.serviceOrchestrator.start(5 * 60 * 1000); // Poll every 5 minutes
      
      const status = await this.serviceOrchestrator.getStatus();
      logger.info({
        discovered: status.discovered.length,
        running: status.running.length,
        pending: status.pending.length,
      }, 'Service orchestrator started');
    }

    logger.info('XORNG Automation Server started successfully');
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    logger.info('Stopping XORNG Automation Server');
    if (this.serviceOrchestrator) {
      this.serviceOrchestrator.stop();
    }
    await this.webhookServer.stop();
    logger.info('XORNG Automation Server stopped');
  }

  /**
   * Get service instances (for testing/debugging)
   */
  getServices() {
    return {
      webhookServer: this.webhookServer,
      githubOrgService: this.githubOrgService,
      issueProcessor: this.issueProcessor,
      feedbackService: this.feedbackService,
      serviceOrchestrator: this.serviceOrchestrator,
    };
  }

  /**
   * Get service orchestrator status
   */
  async getServiceStatus() {
    if (!this.serviceOrchestrator) {
      return { enabled: false, message: 'Service orchestrator not enabled' };
    }
    return {
      enabled: true,
      ...(await this.serviceOrchestrator.getStatus()),
    };
  }

  /**
   * Manually trigger service sync
   */
  async syncServices(removeOrphans: boolean = false) {
    if (!this.serviceOrchestrator) {
      throw new Error('Service orchestrator not enabled');
    }
    await this.serviceOrchestrator.syncServices(removeOrphans);
  }

  /**
   * Redeploy a specific service
   */
  async redeployService(serviceName: string) {
    if (!this.serviceOrchestrator) {
      throw new Error('Service orchestrator not enabled');
    }
    await this.serviceOrchestrator.redeployService(serviceName);
  }
}

// Start server if run directly
if (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server.ts')) {
  const config = loadConfig();
  const server = new AutomationServer(config);

  // Handle shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT');
    await server.stop();
    process.exit(0);
  });

  // Start server
  server.start().catch((error) => {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  });
}

export { loadConfig };
