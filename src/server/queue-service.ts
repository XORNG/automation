export enum JobType {
  ISSUE_PROCESSING = 'issue_processing',
  FEEDBACK = 'feedback',
  OTHER = 'other'
}

export enum JobPriority {
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3
}

export interface QueueConfig {
  host: string;
  port: number;
  password?: string;
}
  updatedAt: string;
  action: string;
}

/**
 * Job data for PR processing
 */
export interface PRJobData {
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
  action: string;
}

/**
 * Job data for feedback processing
 */
export interface FeedbackJobData {
  type: string;
  source: string;
  extensionVersion?: string;
  data: Record<string, unknown>;
}

/**
 * Union type for all job data
 */
export type JobData = 
  | { type: 'issue'; data: IssueJobData }
  | { type: 'pr'; data: PRJobData }
  | { type: 'feedback'; data: FeedbackJobData };

/**
 * Job result interface
 */
export interface JobResult {
  success: boolean;
  message?: string;
  aiAnalysis?: unknown;
  error?: string;
}

/**
 * Queue service configuration
 */
export interface QueueServiceConfig {
  redisUrl: string;
  logLevel?: string;
  /** Max concurrent jobs per worker */
  concurrency?: number;
  /** Default job attempts */
  defaultAttempts?: number;
  /** Rate limit: max jobs per duration */
  rateLimitMax?: number;
  /** Rate limit: duration in ms */
  rateLimitDuration?: number;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

/**
 * QueueService - BullMQ-based persistent job queue
 * 
 * Features:
 * - Redis-backed persistence (survives restarts)
 * - Automatic retries with exponential backoff
 * - Rate limiting for API protection
 * - Priority queues
 * - Job scheduling and delays
 * - Event-driven architecture
 */
export class QueueService extends EventEmitter {
  private queue: Queue;
  private queueEvents: QueueEvents;
  private worker: Worker | null = null;
  private logger: Logger;
  private config: Required<QueueServiceConfig>;
  private connection: ConnectionOptions;
  private isShuttingDown = false;

  static readonly QUEUE_NAME = 'xorng-processing';

  constructor(config: QueueServiceConfig) {
    super();
    this.config = {
      redisUrl: config.redisUrl,
      logLevel: config.logLevel || 'info',
      concurrency: config.concurrency || 10,
      defaultAttempts: config.defaultAttempts || 3,
      rateLimitMax: config.rateLimitMax || 100,
      rateLimitDuration: config.rateLimitDuration || 60000,
    };

    this.logger = pino({
      level: this.config.logLevel,
      name: 'queue-service',
    });

    // Parse Redis URL for connection
    this.connection = this.parseRedisUrl(this.config.redisUrl);

    // Create queue
    this.queue = new Queue(QueueService.QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: this.config.defaultAttempts,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          count: 1000, // Keep last 1000 completed jobs
          age: 24 * 60 * 60, // Or 24 hours
        },
        removeOnFail: {
          count: 5000, // Keep last 5000 failed jobs
          age: 7 * 24 * 60 * 60, // Or 7 days
        },
      },
    });

    // Create queue events listener
    this.queueEvents = new QueueEvents(QueueService.QUEUE_NAME, {
      connection: this.connection,
    });

    this.setupEventListeners();
  }

  /**
   * Parse Redis URL into connection options
   */
  private parseRedisUrl(url: string): ConnectionOptions {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      db: parseInt(parsed.pathname.slice(1) || '0', 10),
    };
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
      this.logger.debug({ jobId }, 'Job completed');
      this.emit('job:completed', { jobId, result: returnvalue });
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.error({ jobId, reason: failedReason }, 'Job failed');
      this.emit('job:failed', { jobId, reason: failedReason });
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      this.emit('job:progress', { jobId, progress: data });
    });

    this.queueEvents.on('stalled', ({ jobId }) => {
      this.logger.warn({ jobId }, 'Job stalled');
      this.emit('job:stalled', { jobId });
    });
  }

  /**
   * Start the worker to process jobs
   */
  startWorker(processor: (job: Job<JobData>) => Promise<JobResult>): void {
    if (this.worker) {
      this.logger.warn('Worker already started');
      return;
    }

    this.worker = new Worker<JobData, JobResult>(
      QueueService.QUEUE_NAME,
      async (job) => {
        this.logger.info({
          jobId: job.id,
          type: job.data.type,
          attempt: job.attemptsMade + 1,
        }, 'Processing job');

        try {
          const result = await processor(job);
          return result;
        } catch (error) {
          this.logger.error({
            jobId: job.id,
            error: (error as Error).message,
          }, 'Job processing error');
          throw error;
        }
      },
      {
        connection: this.connection,
        concurrency: this.config.concurrency,
        limiter: {
          max: this.config.rateLimitMax,
          duration: this.config.rateLimitDuration,
        },
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.info({ jobId: job.id }, 'Job completed by worker');
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error({
        jobId: job?.id,
        error: error.message,
        attempts: job?.attemptsMade,
      }, 'Job failed in worker');
    });

    this.worker.on('error', (error) => {
      this.logger.error({ error: error.message }, 'Worker error');
    });

    this.logger.info({
      concurrency: this.config.concurrency,
      rateLimit: `${this.config.rateLimitMax}/${this.config.rateLimitDuration}ms`,
    }, 'Worker started');
  }

  /**
   * Add an issue job to the queue
   */
  async addIssueJob(data: IssueJobData, options?: {
    priority?: number;
    delay?: number;
    jobId?: string;
  }): Promise<Job<JobData>> {
    const jobId = options?.jobId || `issue-${data.repository}-${data.number}-${Date.now()}`;
    const priority = options?.priority || this.calculateIssuePriority(data);

    const job = await this.queue.add(
      'issue',
      { type: 'issue', data },
      {
        jobId,
        priority,
        delay: options?.delay,
      },
    );

    this.logger.info({
      jobId: job.id,
      issue: data.number,
      repository: data.repository,
      priority,
    }, 'Issue job added to queue');

    this.emit('job:added', { jobId: job.id, type: 'issue' });
    return job;
  }

  /**
   * Add a PR job to the queue
   */
  async addPRJob(data: PRJobData, options?: {
    priority?: number;
    delay?: number;
    jobId?: string;
  }): Promise<Job<JobData>> {
    const jobId = options?.jobId || `pr-${data.repository}-${data.number}-${Date.now()}`;
    const priority = options?.priority || 50; // Medium priority for PRs

    const job = await this.queue.add(
      'pr',
      { type: 'pr', data },
      {
        jobId,
        priority,
        delay: options?.delay,
      },
    );

    this.logger.info({
      jobId: job.id,
      pr: data.number,
      repository: data.repository,
      priority,
    }, 'PR job added to queue');

    this.emit('job:added', { jobId: job.id, type: 'pr' });
    return job;
  }

  /**
   * Add a feedback job to the queue
   */
  async addFeedbackJob(data: FeedbackJobData, options?: {
    priority?: number;
    delay?: number;
  }): Promise<Job<JobData>> {
    const jobId = `feedback-${crypto.randomUUID()}`;
    const priority = options?.priority || 30; // Lower priority for feedback

    const job = await this.queue.add(
      'feedback',
      { type: 'feedback', data },
      {
        jobId,
        priority,
        delay: options?.delay,
      },
    );

    this.logger.debug({
      jobId: job.id,
      type: data.type,
    }, 'Feedback job added to queue');

    this.emit('job:added', { jobId: job.id, type: 'feedback' });
    return job;
  }

  /**
   * Calculate issue priority based on labels and other factors
   */
  private calculateIssuePriority(data: IssueJobData): number {
    let priority = 50; // Default priority

    const labels = data.labels.map(l => l.name.toLowerCase());

    // Higher priority (lower number = higher priority in BullMQ)
    if (labels.includes('critical')) priority = 10;
    else if (labels.includes('security')) priority = 15;
    else if (labels.includes('bug')) priority = 25;
    else if (labels.includes('high-priority')) priority = 30;
    else if (labels.includes('enhancement')) priority = 40;
    else if (labels.includes('documentation')) priority = 60;
    else if (labels.includes('question')) priority = 70;

    return priority;
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<Job<JobData> | undefined> {
    return this.queue.getJob(jobId);
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<QueueStats> {
    const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
      this.queue.getPausedCount(),
    ]);

    return { waiting, active, completed, failed, delayed, paused };
  }

  /**
   * Get waiting jobs
   */
  async getWaitingJobs(start = 0, end = 100): Promise<Job<JobData>[]> {
    return this.queue.getWaiting(start, end);
  }

  /**
   * Get failed jobs
   */
  async getFailedJobs(start = 0, end = 100): Promise<Job<JobData>[]> {
    return this.queue.getFailed(start, end);
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job) {
      await job.retry();
      this.logger.info({ jobId }, 'Job retried');
    }
  }

  /**
   * Remove a job
   */
  async removeJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job) {
      await job.remove();
      this.logger.info({ jobId }, 'Job removed');
    }
  }

  /**
   * Pause the queue
   */
  async pause(): Promise<void> {
    await this.queue.pause();
    this.logger.info('Queue paused');
  }

  /**
   * Resume the queue
   */
  async resume(): Promise<void> {
    await this.queue.resume();
    this.logger.info('Queue resumed');
  }

  /**
   * Drain the queue (remove all waiting jobs)
   */
  async drain(): Promise<void> {
    await this.queue.drain();
    this.logger.info('Queue drained');
  }

  /**
   * Clean old jobs
   */
  async clean(gracePeriodMs: number, limit: number, status: 'completed' | 'failed' = 'completed'): Promise<string[]> {
    const cleaned = await this.queue.clean(gracePeriodMs, limit, status);
    this.logger.info({ count: cleaned.length, status }, 'Old jobs cleaned');
    return cleaned;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.info('Shutting down queue service...');

    // Close worker first (wait for active jobs to complete)
    if (this.worker) {
      await this.worker.close();
      this.logger.info('Worker closed');
    }

    // Close queue events
    await this.queueEvents.close();
    this.logger.info('Queue events closed');

    // Close queue
    await this.queue.close();
    this.logger.info('Queue closed');

    this.logger.info('Queue service shutdown complete');
  }

  /**
   * Check if service is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.queue.getWaitingCount();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create queue service from environment
 */
export function createQueueServiceFromEnv(): QueueService {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  return new QueueService({
    redisUrl,
    logLevel: process.env.LOG_LEVEL || 'info',
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '10', 10),
    defaultAttempts: parseInt(process.env.QUEUE_ATTEMPTS || '3', 10),
    rateLimitMax: parseInt(process.env.QUEUE_RATE_LIMIT_MAX || '100', 10),
    rateLimitDuration: parseInt(process.env.QUEUE_RATE_LIMIT_DURATION || '60000', 10),
  });
}
