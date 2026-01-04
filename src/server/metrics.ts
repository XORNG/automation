import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { pino, type Logger } from 'pino';

/**
 * Metrics Service for XORNG Automation
 * 
 * Provides Prometheus-compatible metrics for observability:
 * - Issue/PR processing metrics
 * - AI service metrics
 * - Queue metrics
 * - HTTP request metrics
 * - Circuit breaker metrics
 */

// Create a custom registry
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Issue/PR Processing Metrics
 */
export const issueMetrics = {
  processed: new Counter({
    name: 'xorng_issues_processed_total',
    help: 'Total number of issues processed',
    labelNames: ['repository', 'status', 'type'] as const,
    registers: [metricsRegistry],
  }),

  processingDuration: new Histogram({
    name: 'xorng_issue_processing_duration_seconds',
    help: 'Issue processing duration in seconds',
    labelNames: ['repository', 'type'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [metricsRegistry],
  }),

  queueDepth: new Gauge({
    name: 'xorng_queue_depth',
    help: 'Current queue depth by status',
    labelNames: ['status'] as const,
    registers: [metricsRegistry],
  }),

  taskAssigned: new Counter({
    name: 'xorng_tasks_assigned_total',
    help: 'Total number of tasks assigned to workers',
    labelNames: ['type'] as const,
    registers: [metricsRegistry],
  }),

  taskCompleted: new Counter({
    name: 'xorng_tasks_completed_total',
    help: 'Total number of tasks completed',
    labelNames: ['type', 'status'] as const,
    registers: [metricsRegistry],
  }),
};

/**
 * AI Service Metrics
 */
export const aiMetrics = {
  requests: new Counter({
    name: 'xorng_ai_requests_total',
    help: 'Total AI API requests',
    labelNames: ['model', 'status', 'operation'] as const,
    registers: [metricsRegistry],
  }),

  requestDuration: new Histogram({
    name: 'xorng_ai_request_duration_seconds',
    help: 'AI request duration in seconds',
    labelNames: ['model', 'operation'] as const,
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [metricsRegistry],
  }),

  tokensUsed: new Counter({
    name: 'xorng_ai_tokens_used_total',
    help: 'Total tokens used in AI requests',
    labelNames: ['model', 'type'] as const,
    registers: [metricsRegistry],
  }),

  errors: new Counter({
    name: 'xorng_ai_errors_total',
    help: 'Total AI API errors',
    labelNames: ['model', 'error_type'] as const,
    registers: [metricsRegistry],
  }),
};

/**
 * HTTP Server Metrics
 */
export const httpMetrics = {
  requests: new Counter({
    name: 'xorng_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [metricsRegistry],
  }),

  requestDuration: new Histogram({
    name: 'xorng_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'path'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [metricsRegistry],
  }),

  activeConnections: new Gauge({
    name: 'xorng_http_active_connections',
    help: 'Number of active HTTP connections',
    registers: [metricsRegistry],
  }),
};

/**
 * Circuit Breaker Metrics
 */
export const circuitBreakerMetrics = {
  state: new Gauge({
    name: 'xorng_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
    labelNames: ['name'] as const,
    registers: [metricsRegistry],
  }),

  stateChanges: new Counter({
    name: 'xorng_circuit_breaker_state_changes_total',
    help: 'Total circuit breaker state changes',
    labelNames: ['name', 'from', 'to'] as const,
    registers: [metricsRegistry],
  }),

  failures: new Counter({
    name: 'xorng_circuit_breaker_failures_total',
    help: 'Total circuit breaker failures',
    labelNames: ['name'] as const,
    registers: [metricsRegistry],
  }),
};

/**
 * Webhook Metrics
 */
export const webhookMetrics = {
  received: new Counter({
    name: 'xorng_webhooks_received_total',
    help: 'Total webhooks received',
    labelNames: ['event', 'repository'] as const,
    registers: [metricsRegistry],
  }),

  processingErrors: new Counter({
    name: 'xorng_webhook_processing_errors_total',
    help: 'Total webhook processing errors',
    labelNames: ['event', 'error_type'] as const,
    registers: [metricsRegistry],
  }),
};

/**
 * Service Orchestrator Metrics
 */
export const serviceMetrics = {
  discovered: new Gauge({
    name: 'xorng_services_discovered',
    help: 'Number of discovered services',
    labelNames: ['type'] as const,
    registers: [metricsRegistry],
  }),

  running: new Gauge({
    name: 'xorng_services_running',
    help: 'Number of running services',
    labelNames: ['type'] as const,
    registers: [metricsRegistry],
  }),

  deployments: new Counter({
    name: 'xorng_service_deployments_total',
    help: 'Total service deployments',
    labelNames: ['service', 'status'] as const,
    registers: [metricsRegistry],
  }),
};

/**
 * Feedback Metrics
 */
export const feedbackMetrics = {
  received: new Counter({
    name: 'xorng_feedback_received_total',
    help: 'Total feedback received',
    labelNames: ['type', 'source'] as const,
    registers: [metricsRegistry],
  }),

  rating: new Histogram({
    name: 'xorng_feedback_rating',
    help: 'Feedback rating distribution',
    labelNames: ['type'] as const,
    buckets: [1, 2, 3, 4, 5],
    registers: [metricsRegistry],
  }),
};

/**
 * MetricsService - Main service class for metrics management
 */
export class MetricsService {
  private logger: Logger;

  constructor(options?: { logLevel?: string }) {
    this.logger = pino({
      level: options?.logLevel || 'info',
      name: 'metrics-service',
    });
  }

  /**
   * Get all metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return metricsRegistry.metrics();
  }

  /**
   * Get content type for metrics response
   */
  getContentType(): string {
    return metricsRegistry.contentType;
  }

  /**
   * Record issue processing
   */
  recordIssueProcessed(
    repository: string,
    status: 'success' | 'failed' | 'skipped',
    type: 'issue' | 'pr',
    durationMs?: number,
  ): void {
    issueMetrics.processed.inc({ repository, status, type });
    
    if (durationMs !== undefined) {
      issueMetrics.processingDuration.observe(
        { repository, type },
        durationMs / 1000,
      );
    }
  }

  /**
   * Update queue depth
   */
  updateQueueDepth(pending: number, inProgress: number, completed: number, failed: number): void {
    issueMetrics.queueDepth.set({ status: 'pending' }, pending);
    issueMetrics.queueDepth.set({ status: 'in-progress' }, inProgress);
    issueMetrics.queueDepth.set({ status: 'completed' }, completed);
    issueMetrics.queueDepth.set({ status: 'failed' }, failed);
  }

  /**
   * Set queue depth for a specific status
   */
  setQueueDepth(status: string, value: number): void {
    issueMetrics.queueDepth.set({ status }, value);
  }

  /**
   * Observe webhook processing duration
   */
  observeWebhook(event: string, status: 'success' | 'error', durationMs: number): void {
    webhookMetrics.received.inc({ event, repository: 'unknown' });
    if (status === 'error') {
      webhookMetrics.processingErrors.inc({ event, error_type: 'processing' });
    }
  }

  /**
   * Record AI request
   */
  recordAIRequest(
    model: string,
    operation: string,
    status: 'success' | 'error',
    durationMs: number,
    tokens?: { prompt?: number; completion?: number },
  ): void {
    aiMetrics.requests.inc({ model, operation, status });
    aiMetrics.requestDuration.observe({ model, operation }, durationMs / 1000);

    if (tokens) {
      if (tokens.prompt) {
        aiMetrics.tokensUsed.inc({ model, type: 'prompt' }, tokens.prompt);
      }
      if (tokens.completion) {
        aiMetrics.tokensUsed.inc({ model, type: 'completion' }, tokens.completion);
      }
    }
  }

  /**
   * Record AI error
   */
  recordAIError(model: string, errorType: string): void {
    aiMetrics.errors.inc({ model, error_type: errorType });
  }

  /**
   * Record HTTP request
   */
  recordHttpRequest(
    method: string,
    path: string,
    status: number,
    durationMs: number,
  ): void {
    const normalizedPath = this.normalizePath(path);
    httpMetrics.requests.inc({
      method,
      path: normalizedPath,
      status: String(status),
    });
    httpMetrics.requestDuration.observe(
      { method, path: normalizedPath },
      durationMs / 1000,
    );
  }

  /**
   * Record webhook
   */
  recordWebhook(event: string, repository: string): void {
    webhookMetrics.received.inc({ event, repository });
  }

  /**
   * Record webhook error
   */
  recordWebhookError(event: string, errorType: string): void {
    webhookMetrics.processingErrors.inc({ event, error_type: errorType });
  }

  /**
   * Update circuit breaker state
   */
  updateCircuitBreakerState(
    name: string,
    state: 'closed' | 'half-open' | 'open',
  ): void {
    const stateValue = state === 'closed' ? 0 : state === 'half-open' ? 1 : 2;
    circuitBreakerMetrics.state.set({ name }, stateValue);
  }

  /**
   * Record circuit breaker state change
   */
  recordCircuitBreakerStateChange(
    name: string,
    from: string,
    to: string,
  ): void {
    circuitBreakerMetrics.stateChanges.inc({ name, from, to });
  }

  /**
   * Record circuit breaker failure
   */
  recordCircuitBreakerFailure(name: string): void {
    circuitBreakerMetrics.failures.inc({ name });
  }

  /**
   * Update service counts
   */
  updateServiceCounts(
    discovered: Record<string, number>,
    running: Record<string, number>,
  ): void {
    Object.entries(discovered).forEach(([type, count]) => {
      serviceMetrics.discovered.set({ type }, count);
    });
    Object.entries(running).forEach(([type, count]) => {
      serviceMetrics.running.set({ type }, count);
    });
  }

  /**
   * Record feedback
   */
  recordFeedback(type: string, source: string, rating?: number): void {
    feedbackMetrics.received.inc({ type, source });
    if (rating !== undefined) {
      feedbackMetrics.rating.observe({ type }, rating);
    }
  }

  /**
   * Normalize path for metrics (remove dynamic segments)
   */
  private normalizePath(path: string): string {
    return path
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-f0-9-]{36}/g, '/:uuid')
      .replace(/\?.*/g, '');
  }
}

// Singleton instance
export const metricsService = new MetricsService();

// Export all metric groups
export const metrics = {
  issue: issueMetrics,
  ai: aiMetrics,
  http: httpMetrics,
  circuitBreaker: circuitBreakerMetrics,
  webhook: webhookMetrics,
  service: serviceMetrics,
  feedback: feedbackMetrics,
};
