import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'http';
import crypto from 'crypto';
import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';
import { metricsRegistry, metricsService } from './metrics.js';

/**
 * Webhook server configuration
 */
export interface WebhookServerConfig {
  port: number;
  host?: string;
  webhookSecret?: string;
  corsOrigins?: string[];
  logLevel?: string;
}

/**
 * GitHub webhook event types
 */
export type GitHubEventType =
  | 'issues'
  | 'issue_comment'
  | 'pull_request'
  | 'pull_request_review'
  | 'push'
  | 'repository'
  | 'create'
  | 'delete'
  | 'ping'
  | 'check_run'
  | 'check_suite'
  | 'workflow_run'
  | 'workflow_job';

/**
 * GitHub webhook payload
 */
export interface GitHubWebhookPayload {
  action: string;
  sender: {
    login: string;
    id: number;
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
    private: boolean;
    html_url: string;
    default_branch: string;
  };
  organization?: {
    login: string;
    id: number;
  };
  issue?: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: string;
    labels: Array<{ name: string; color: string }>;
    user: {
      login: string;
      id: number;
    };
    html_url: string;
    created_at: string;
    updated_at: string;
    pull_request?: unknown;
  };
  pull_request?: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: string;
    user: {
      login: string;
      id: number;
    };
    html_url: string;
    head: {
      ref: string;
      sha: string;
    };
    base: {
      ref: string;
      sha: string;
    };
  };
  comment?: {
    id: number;
    body: string;
    user: {
      login: string;
      id: number;
    };
    created_at: string;
  };
  check_run?: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    pull_requests: Array<{ number: number }>;
    html_url: string;
  };
  check_suite?: {
    id: number;
    status: string;
    conclusion: string | null;
    pull_requests: Array<{ number: number }>;
  };
  workflow_run?: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    head_branch: string;
    pull_requests: Array<{ number: number }>;
    html_url: string;
  };
  workflow_job?: {
    id: number;
    run_id: number;
    name: string;
    status: string;
    conclusion: string | null;
  };
}

/**
 * WebhookServer - HTTP server for GitHub webhooks and VS Code extension feedback
 * 
 * Features:
 * - GitHub webhook signature verification
 * - Event-based architecture for processing
 * - REST API for VS Code extension feedback
 * - Health checks and status endpoints
 */
export class WebhookServer extends EventEmitter {
  private app: Express;
  private server: Server | null = null;
  private logger: Logger;
  private config: WebhookServerConfig;

  constructor(config: WebhookServerConfig) {
    super();
    this.config = config;
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'webhook-server',
    });
    this.app = this.createApp();
  }

  /**
   * Create Express application with routes
   */
  private createApp(): Express {
    const app = express();

    // Trust proxy for accurate IP logging (useful behind reverse proxy)
    app.set('trust proxy', 1);

    // Raw body parser for webhook signature verification
    app.use('/webhook', express.raw({ type: 'application/json' }));

    // JSON parser for other routes
    app.use(express.json());

    // CORS middleware
    app.use(this.corsMiddleware.bind(this));

    // Request logging
    app.use(this.requestLogger.bind(this));

    // Routes
    this.setupRoutes(app);

    // Error handler
    app.use(this.errorHandler.bind(this));

    return app;
  }

  /**
   * CORS middleware
   */
  private corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    const allowedOrigins = this.config.corsOrigins || ['*'];

    if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  }

  /**
   * Request logging middleware
   */
  private requestLogger(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      this.logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip,
      });
    });
    next();
  }

  /**
   * Setup routes
   */
  private setupRoutes(app: Express): void {
    // Health check
    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // Status endpoint with more details
    app.get('/status', (_req, res) => {
      res.json({
        status: 'running',
        version: process.env.npm_package_version || '0.1.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        config: {
          port: this.config.port,
          webhookConfigured: !!this.config.webhookSecret,
        },
      });
    });

    // Prometheus metrics endpoint
    app.get('/metrics', async (_req, res) => {
      try {
        res.set('Content-Type', metricsRegistry.contentType);
        const metrics = await metricsRegistry.metrics();
        res.end(metrics);
      } catch (error) {
        this.logger.error({ error }, 'Failed to collect metrics');
        res.status(500).end('Error collecting metrics');
      }
    });

    // GitHub webhook endpoint
    app.post('/webhook/github', this.handleGitHubWebhook.bind(this));

    // VS Code extension feedback endpoints
    app.post('/api/feedback', this.handleFeedback.bind(this));
    app.post('/api/telemetry', this.handleTelemetry.bind(this));
    app.get('/api/pending-tasks', this.handlePendingTasks.bind(this));
    app.post('/api/task/:taskId/result', this.handleTaskResult.bind(this));
  }

  /**
   * Verify GitHub webhook signature
   */
  private verifyWebhookSignature(payload: Buffer, signature: string | undefined): boolean {
    if (!this.config.webhookSecret) {
      this.logger.warn('Webhook secret not configured - skipping signature verification');
      return true;
    }

    if (!signature) {
      this.logger.warn('No signature provided in webhook request');
      return false;
    }

    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payload)
      .digest('hex')}`;

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Handle GitHub webhook
   */
  private async handleGitHubWebhook(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as GitHubEventType | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    // Verify signature
    if (!this.verifyWebhookSignature(req.body as Buffer, signature)) {
      this.logger.error({ deliveryId }, 'Invalid webhook signature');
      metricsService.observeWebhook(event || 'unknown', 'error', Date.now() - startTime);
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Parse payload
    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse((req.body as Buffer).toString());
    } catch (error) {
      this.logger.error({ error, deliveryId }, 'Failed to parse webhook payload');
      metricsService.observeWebhook(event || 'unknown', 'error', Date.now() - startTime);
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    this.logger.info({
      event,
      action: payload.action,
      deliveryId,
      repository: payload.repository?.full_name,
      sender: payload.sender?.login,
    }, 'Received GitHub webhook');

    // Acknowledge immediately (async processing)
    res.status(202).json({
      received: true,
      deliveryId,
      event,
      action: payload.action,
    });

    // Record metrics
    metricsService.observeWebhook(event || 'unknown', 'success', Date.now() - startTime);

    // Emit event for processing
    this.emit('github:webhook', {
      event,
      action: payload.action,
      deliveryId,
      payload,
    });

    // Emit specific events for easier handling
    if (event) {
      this.emit(`github:${event}`, {
        action: payload.action,
        deliveryId,
        payload,
      });

      // Emit combined event:action for precise handling
      this.emit(`github:${event}:${payload.action}`, {
        deliveryId,
        payload,
      });
    }
  }

  /**
   * Handle VS Code extension feedback
   */
  private async handleFeedback(req: Request, res: Response): Promise<void> {
    const { type, data, extensionVersion, timestamp } = req.body;

    this.logger.info({
      type,
      extensionVersion,
    }, 'Received feedback from VS Code extension');

    // Emit feedback event for processing
    this.emit('feedback', {
      type,
      data,
      extensionVersion,
      timestamp: timestamp || new Date().toISOString(),
      source: 'vscode-extension',
    });

    res.status(202).json({
      received: true,
      id: crypto.randomUUID(),
    });
  }

  /**
   * Handle VS Code extension telemetry
   */
  private async handleTelemetry(req: Request, res: Response): Promise<void> {
    const { metrics, events, extensionVersion } = req.body;

    this.logger.debug({
      metricsCount: metrics?.length,
      eventsCount: events?.length,
      extensionVersion,
    }, 'Received telemetry from VS Code extension');

    // Emit telemetry event for processing
    this.emit('telemetry', {
      metrics,
      events,
      extensionVersion,
      timestamp: new Date().toISOString(),
      source: 'vscode-extension',
    });

    res.status(202).json({ received: true });
  }

  /**
   * Handle pending tasks request
   */
  private async handlePendingTasks(req: Request, res: Response): Promise<void> {
    const { workspaceId, capabilities } = req.query;

    this.logger.debug({
      workspaceId,
      capabilities,
    }, 'Request for pending tasks');

    // This will be implemented by IssueProcessor to return tasks
    // For now, emit event and respond with empty list
    const tasks: unknown[] = [];

    this.emit('tasks:pending:request', {
      workspaceId,
      capabilities: capabilities ? (capabilities as string).split(',') : [],
      respond: (pendingTasks: unknown[]) => {
        tasks.push(...pendingTasks);
      },
    });

    res.json({
      tasks,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle task result from VS Code extension
   */
  private async handleTaskResult(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params;
    const { status, result, error, metadata } = req.body;

    this.logger.info({
      taskId,
      status,
      hasResult: !!result,
      hasError: !!error,
    }, 'Received task result from VS Code extension');

    // Emit task result event for processing
    this.emit('task:result', {
      taskId,
      status,
      result,
      error,
      metadata,
      timestamp: new Date().toISOString(),
    });

    res.json({
      received: true,
      taskId,
    });
  }

  /**
   * Error handler middleware
   */
  private errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    this.logger.error({ error: err.message, stack: err.stack }, 'Server error');
    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer(this.app);
        this.server.listen(this.config.port, this.config.host || '0.0.0.0', () => {
          this.logger.info({
            port: this.config.port,
            host: this.config.host || '0.0.0.0',
          }, 'Webhook server started');
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Webhook server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get Express app (for testing)
   */
  getApp(): Express {
    return this.app;
  }
}
