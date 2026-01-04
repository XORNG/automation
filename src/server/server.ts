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
 * - Persistent job queue with BullMQ
 * - Prometheus metrics for observability
 * - Circuit breakers for resilience
 */

import { WebhookServer, type WebhookServerConfig } from './webhook-server.js';
import { GitHubOrgService } from './github-org-service.js';
import { IssueProcessor } from './issue-processor.js';
import { FeedbackService } from './feedback-service.js';
import { ServiceOrchestrator } from './service-orchestrator.js';
import { AIService, createAIServiceFromEnv } from './ai-service.js';
import { QueueService, createQueueServiceFromEnv, type JobData, type JobResult } from './queue-service.js';
import { metricsService, metricsRegistry } from './metrics.js';
import { CircuitBreaker, circuitBreakerRegistry } from '../utils/circuit-breaker.js';
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
  // Redis/Queue configuration
  redisUrl: string;
  queueEnabled: boolean;
  // Dynamic service orchestration
  serviceDiscoveryEnabled: boolean;
  registryUrl: string;
  autoDeployServices: boolean;
  // AI/LLM configuration (OpenRouter)
  openRouterApiKey?: string;
  openRouterModel?: string;
  aiEnabled: boolean;
  // Metrics
  metricsEnabled: boolean;
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
    // Redis/Queue configuration
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    queueEnabled: process.env.QUEUE_ENABLED !== 'false',
    // Dynamic service orchestration
    serviceDiscoveryEnabled: process.env.SERVICE_DISCOVERY_ENABLED === 'true',
    registryUrl: process.env.REGISTRY_URL || 'ghcr.io',
    autoDeployServices: process.env.AUTO_DEPLOY_SERVICES === 'true',
    // AI/LLM configuration (OpenRouter - temporary solution)
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    openRouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4',
    aiEnabled: !!process.env.OPENROUTER_API_KEY,
    // Metrics
    metricsEnabled: process.env.METRICS_ENABLED !== 'false',
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
  private aiService: AIService;
  private queueService?: QueueService;
  private isShuttingDown = false;
  private cleanupIntervals: NodeJS.Timeout[] = [];
  
  // Circuit breakers for external services
  private githubCircuitBreaker: CircuitBreaker;
  private aiCircuitBreaker: CircuitBreaker;

  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize circuit breakers
    this.githubCircuitBreaker = circuitBreakerRegistry.getBreaker({
      name: 'github-api',
      failureThreshold: 5,
      resetTimeout: 60000,
      callTimeout: 30000,
    });
    
    this.aiCircuitBreaker = circuitBreakerRegistry.getBreaker({
      name: 'openrouter-api',
      failureThreshold: 3,
      resetTimeout: 120000,
      callTimeout: 60000,
    });
    
    // Setup circuit breaker metrics
    this.setupCircuitBreakerMetrics();

    // Initialize AI service (OpenRouter)
    this.aiService = new AIService({
      apiKey: config.openRouterApiKey || '',
      model: config.openRouterModel || 'anthropic/claude-sonnet-4',
      logLevel: config.logLevel,
    });

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
      aiService: this.aiService,
      autoMergeEnabled: config.aiEnabled, // Enable auto-merge when AI is configured
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
        registryUsername: 'github', // GHCR uses 'github' as username with PAT as password
        registryPassword: config.githubToken, // Use same token for GHCR
        networkName: 'xorng-network',
        autoDeployEnabled: config.autoDeployServices,
        logLevel: config.logLevel,
      });
    }

    // Initialize queue service if enabled
    if (config.queueEnabled) {
      this.queueService = new QueueService({
        redisUrl: config.redisUrl,
        logLevel: config.logLevel,
      });
    }

    this.setupEventHandlers();
  }

  /**
   * Setup circuit breaker metrics tracking
   */
  private setupCircuitBreakerMetrics(): void {
    const breakers = [this.githubCircuitBreaker, this.aiCircuitBreaker];
    
    for (const breaker of breakers) {
      breaker.on('stateChange', (from, to) => {
        metricsService.updateCircuitBreakerState(breaker.getStats().name, to);
        metricsService.recordCircuitBreakerStateChange(breaker.getStats().name, from, to);
      });
      
      breaker.on('failure', () => {
        metricsService.recordCircuitBreakerFailure(breaker.getStats().name);
      });
    }
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
      aiEnabled: this.config.aiEnabled,
      aiModel: this.config.openRouterModel,
    }, 'Starting XORNG Automation Server');

    // Log AI service status
    if (this.config.aiEnabled) {
      logger.info({
        model: this.config.openRouterModel,
        provider: 'OpenRouter',
      }, 'AI-powered processing enabled');
    } else {
      logger.warn('AI service disabled - OPENROUTER_API_KEY not configured');
    }

    // Start webhook server
    await this.webhookServer.start();

    // Start queue service if enabled
    if (this.queueService) {
const processor = async (job: Job<JobData, any, string>): Promise<JobResult> => {
  // Process the job
  return { status: 'completed' };
};
      // Setup queue event metrics
      this.queueService.on('job:completed', () => {
        this.updateQueueMetrics();
      });
      this.queueService.on('job:failed', () => {
        this.updateQueueMetrics();
      });
      
      logger.info('Queue service started');
    }

    // Discover all repositories
    logger.info('Discovering organization repositories...');
    const repos = await this.githubCircuitBreaker.execute(async () => {
      return this.githubOrgService.listRepositories();
    });
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
    const cleanupInterval = setInterval(() => {
      this.issueProcessor.cleanupOldTasks(24);
      this.feedbackService.cleanup(30);
      if (this.queueService) {
        this.queueService.clean(7 * 24 * 60 * 60 * 1000, 1000, 'completed');
        this.queueService.clean(30 * 24 * 60 * 60 * 1000, 1000, 'failed');
      }
    }, 60 * 60 * 1000); // Every hour
    this.cleanupIntervals.push(cleanupInterval);

    // Start periodic repository check for new repos
    const repoCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;
      
      try {
        const newRepos = await this.githubCircuitBreaker.execute(async () => {
          return this.githubOrgService.checkForNewRepositories();
        });
        
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
      } catch (error) {
        logger.error({ error }, 'Failed to check for new repositories');
      }
    }, 5 * 60 * 1000); // Every 5 minutes
    this.cleanupIntervals.push(repoCheckInterval);

    // Start metrics update interval
    if (this.config.metricsEnabled) {
      const metricsInterval = setInterval(() => {
        this.updateQueueMetrics();
      }, 30000); // Every 30 seconds
      this.cleanupIntervals.push(metricsInterval);
    }

    // Start service orchestrator if enabled
    if (this.serviceOrchestrator) {
      logger.info('Starting dynamic service orchestrator...');
      try {
        await this.serviceOrchestrator.start(5 * 60 * 1000); // Poll every 5 minutes
        
        const status = await this.serviceOrchestrator.getStatus();
        logger.info({
          discovered: status.discovered.length,
          running: status.running.length,
          pending: status.pending.length,
        }, 'Service orchestrator started');
      } catch (error) {
        // Don't crash the server if orchestrator fails - log and continue
        logger.error({ error }, 'Service orchestrator failed to start, continuing without it');
      }
    }

    logger.info('XORNG Automation Server started successfully');
  }

  /**
   * Process a job from the queue
   */
  private async processQueueJob(jobData: {
    type: string;
    payload: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    const { type, payload } = jobData;
    
    switch (type) {
      case 'issue':
        return this.processIssueJob(payload as {
          repo: string;
          owner: string;
          issueNumber: number;
          action: string;
        });
      case 'pull_request':
        return this.processPullRequestJob(payload as {
          repo: string;
          owner: string;
          prNumber: number;
          action: string;
        });
      case 'feedback':
        return this.processFeedbackJob(payload as {
          taskId: string;
          rating: number;
          comments?: string;
        });
      default:
        logger.warn({ type }, 'Unknown job type');
        return null;
    }
  }

  private async processIssueJob(payload: {
    repo: string;
    owner: string;
    issueNumber: number;
    action: string;
  }) {
    const { repo, owner, issueNumber, action } = payload;
    logger.info({ repo, owner, issueNumber, action }, 'Processing issue job');
    
    // Delegate to issue processor
    const task = await this.issueProcessor.processIssue(owner, repo, issueNumber, action);
    return task;
  }

  private async processPullRequestJob(payload: {
    repo: string;
    owner: string;
    prNumber: number;
    action: string;
  }) {
    const { repo, owner, prNumber, action } = payload;
    logger.info({ repo, owner, prNumber, action }, 'Processing pull request job');
    // PR processing logic would go here
    return { processed: true };
  }

  private async processFeedbackJob(payload: {
    taskId: string;
    rating: number;
    comments?: string;
  }) {
    const { taskId, rating, comments } = payload;
    logger.info({ taskId, rating }, 'Processing feedback job');
    this.feedbackService.recordFeedback(taskId, rating, comments);
    return { recorded: true };
  }

  /**
   * Update queue metrics
   */
  private async updateQueueMetrics(): Promise<void> {
    if (!this.queueService) return;
    
    try {
      const counts = await this.queueService.getJobCounts();
      metricsService.setQueueDepth('waiting', counts.waiting);
      metricsService.setQueueDepth('active', counts.active);
      metricsService.setQueueDepth('completed', counts.completed);
      metricsService.setQueueDepth('failed', counts.failed);
      metricsService.setQueueDepth('delayed', counts.delayed);
    } catch (error) {
      logger.error({ error }, 'Failed to update queue metrics');
    }
  }

  /**
   * Stop the server with graceful shutdown
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    logger.info('Initiating graceful shutdown of XORNG Automation Server...');
    
    const shutdownTimeout = 30000; // 30 second timeout
    const shutdownPromise = this.performGracefulShutdown();
    
    try {
      await Promise.race([
        shutdownPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Shutdown timeout')), shutdownTimeout)
        ),
      ]);
      logger.info('XORNG Automation Server stopped gracefully');
    } catch (error) {
      logger.error({ error }, 'Forced shutdown due to timeout');
      // Force exit after logging
      process.exit(1);
    }
  }

  private async performGracefulShutdown(): Promise<void> {
    // 1. Stop accepting new work
    logger.info('Stopping periodic tasks...');
    for (const interval of this.cleanupIntervals) {
      clearInterval(interval);
    }
    this.cleanupIntervals = [];

    // 2. Stop service orchestrator
    if (this.serviceOrchestrator) {
      logger.info('Stopping service orchestrator...');
      this.serviceOrchestrator.stop();
    }

    // 3. Stop webhook server (stop accepting new requests)
    logger.info('Stopping webhook server...');
    await this.webhookServer.stop();

    // 4. Wait for queue to drain active jobs
    if (this.queueService) {
      logger.info('Draining job queue...');
      try {
        await this.queueService.close();
        logger.info('Job queue drained and closed');
      } catch (error) {
        logger.error({ error }, 'Error closing queue service');
      }
    }

    // 5. Final cleanup
    logger.info('Shutdown complete');
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
      aiService: this.aiService,
      queueService: this.queueService,
    };
  }

  /**
   * Get AI service status
   */
  getAIStatus() {
    return this.aiService.getStatus();
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
