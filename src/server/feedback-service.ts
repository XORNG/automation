import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';
import crypto from 'crypto';

/**
 * Feedback types from VS Code extension
 */
export type FeedbackType =
  | 'improvement-accepted'    // User accepted an AI suggestion
  | 'improvement-rejected'    // User rejected an AI suggestion
  | 'error-report'           // Error encountered in extension
  | 'suggestion'             // User has a suggestion
  | 'code-review-result'     // Result of a code review
  | 'pattern-learned'        // New pattern learned from user behavior
  | 'task-completed'         // Task completed successfully
  | 'task-failed'            // Task failed
  | 'rating';                // User rating of AI response

/**
 * Feedback entry
 */
export interface FeedbackEntry {
  id: string;
  type: FeedbackType;
  timestamp: string;
  source: string;
  extensionVersion?: string;
  data: {
    // Common fields
    message?: string;
    rating?: number;
    
    // Code context
    file?: string;
    language?: string;
    codeSnippet?: string;
    
    // AI interaction
    prompt?: string;
    response?: string;
    model?: string;
    
    // Task context
    taskId?: string;
    issueNumber?: number;
    repository?: string;
    
    // Pattern data
    pattern?: {
      name: string;
      description: string;
      example: string;
    };
    
    // Error data
    error?: {
      message: string;
      stack?: string;
      code?: string;
    };
    
    // Additional metadata
    [key: string]: unknown;
  };
}

/**
 * Telemetry event
 */
export interface TelemetryEvent {
  name: string;
  timestamp: string;
  properties?: Record<string, unknown>;
}

/**
 * Telemetry metric
 */
export interface TelemetryMetric {
  name: string;
  value: number;
  timestamp: string;
  tags?: Record<string, string>;
}

/**
 * Aggregated statistics
 */
export interface FeedbackStats {
  totalFeedback: number;
  byType: Record<FeedbackType, number>;
  acceptanceRate: number;
  averageRating: number;
  errorCount: number;
  lastUpdated: string;
}

/**
 * FeedbackService - Handles feedback from VS Code extensions
 * 
 * Features:
 * - Collects user feedback on AI suggestions
 * - Tracks acceptance/rejection rates
 * - Stores patterns learned from user behavior
 * - Aggregates telemetry for optimization
 */
export class FeedbackService extends EventEmitter {
  private logger: Logger;
  private feedbackStore: Map<string, FeedbackEntry> = new Map();
  private telemetryEvents: TelemetryEvent[] = [];
  private telemetryMetrics: TelemetryMetric[] = [];

  // Statistics
  private stats: {
    improvements: { accepted: number; rejected: number };
    ratings: number[];
    errorCount: number;
    feedbackByType: Map<FeedbackType, number>;
  } = {
    improvements: { accepted: 0, rejected: 0 },
    ratings: [],
    errorCount: 0,
    feedbackByType: new Map(),
  };

  constructor(options?: { logLevel?: string }) {
    super();
    this.logger = pino({
      level: options?.logLevel || 'info',
      name: 'feedback-service',
    });
  }

  /**
   * Submit feedback from VS Code extension
   */
  submitFeedback(entry: Omit<FeedbackEntry, 'id' | 'timestamp'>): FeedbackEntry {
    const feedback: FeedbackEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    // Store feedback
    this.feedbackStore.set(feedback.id, feedback);

    // Update statistics
    this.updateStats(feedback);

    this.logger.info({
      feedbackId: feedback.id,
      type: feedback.type,
      source: feedback.source,
    }, 'Received feedback');

    // Emit event for further processing
    this.emit('feedback:received', feedback);

    // Emit specific event for type
    this.emit(`feedback:${feedback.type}`, feedback);

    return feedback;
  }

  /**
   * Update statistics based on feedback
   */
  private updateStats(feedback: FeedbackEntry): void {
    // Update by type counter
    const currentCount = this.stats.feedbackByType.get(feedback.type) || 0;
    this.stats.feedbackByType.set(feedback.type, currentCount + 1);

    // Update specific stats
    switch (feedback.type) {
      case 'improvement-accepted':
        this.stats.improvements.accepted++;
        break;
      case 'improvement-rejected':
        this.stats.improvements.rejected++;
        break;
      case 'error-report':
        this.stats.errorCount++;
        break;
      case 'rating':
        if (feedback.data.rating !== undefined) {
          this.stats.ratings.push(feedback.data.rating);
        }
        break;
    }
  }

  /**
   * Submit telemetry events from VS Code extension
   */
  submitTelemetry(data: {
    events?: TelemetryEvent[];
    metrics?: TelemetryMetric[];
    extensionVersion?: string;
  }): void {
    if (data.events) {
      this.telemetryEvents.push(...data.events);
      
      // Keep only last 10000 events
      if (this.telemetryEvents.length > 10000) {
        this.telemetryEvents = this.telemetryEvents.slice(-10000);
      }
    }

    if (data.metrics) {
      this.telemetryMetrics.push(...data.metrics);
      
      // Keep only last 10000 metrics
      if (this.telemetryMetrics.length > 10000) {
        this.telemetryMetrics = this.telemetryMetrics.slice(-10000);
      }
    }

    this.logger.debug({
      eventsCount: data.events?.length,
      metricsCount: data.metrics?.length,
      extensionVersion: data.extensionVersion,
    }, 'Received telemetry');

    this.emit('telemetry:received', data);
  }

  /**
   * Get feedback statistics
   */
  getStats(): FeedbackStats {
    const byType: Record<string, number> = {};
    for (const [type, count] of this.stats.feedbackByType) {
      byType[type] = count;
    }

    const totalImprovements = this.stats.improvements.accepted + this.stats.improvements.rejected;
    const acceptanceRate = totalImprovements > 0
      ? this.stats.improvements.accepted / totalImprovements
      : 0;

    const averageRating = this.stats.ratings.length > 0
      ? this.stats.ratings.reduce((a, b) => a + b, 0) / this.stats.ratings.length
      : 0;

    return {
      totalFeedback: this.feedbackStore.size,
      byType: byType as Record<FeedbackType, number>,
      acceptanceRate,
      averageRating,
      errorCount: this.stats.errorCount,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get recent feedback entries
   */
  getRecentFeedback(limit: number = 50, type?: FeedbackType): FeedbackEntry[] {
    let entries = Array.from(this.feedbackStore.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (type) {
      entries = entries.filter(e => e.type === type);
    }

    return entries.slice(0, limit);
  }

  /**
   * Get feedback by ID
   */
  getFeedback(id: string): FeedbackEntry | null {
    return this.feedbackStore.get(id) || null;
  }

  /**
   * Get learned patterns from feedback
   */
  getLearnedPatterns(): Array<FeedbackEntry['data']['pattern']> {
    const patterns = Array.from(this.feedbackStore.values())
      .filter(e => e.type === 'pattern-learned' && e.data.pattern)
      .map(e => e.data.pattern!);

    return patterns;
  }

  /**
   * Get error reports
   */
  getErrorReports(limit: number = 50): FeedbackEntry[] {
    return this.getRecentFeedback(limit, 'error-report');
  }

  /**
   * Get telemetry events
   */
  getTelemetryEvents(options?: {
    name?: string;
    since?: Date;
    limit?: number;
  }): TelemetryEvent[] {
    let events = [...this.telemetryEvents];

    if (options?.name) {
      events = events.filter(e => e.name === options.name);
    }

    if (options?.since) {
      events = events.filter(e => new Date(e.timestamp) >= options.since!);
    }

    if (options?.limit) {
      events = events.slice(-options.limit);
    }

    return events;
  }

  /**
   * Get telemetry metrics
   */
  getTelemetryMetrics(options?: {
    name?: string;
    since?: Date;
    limit?: number;
  }): TelemetryMetric[] {
    let metrics = [...this.telemetryMetrics];

    if (options?.name) {
      metrics = metrics.filter(m => m.name === options.name);
    }

    if (options?.since) {
      metrics = metrics.filter(m => new Date(m.timestamp) >= options.since!);
    }

    if (options?.limit) {
      metrics = metrics.slice(-options.limit);
    }

    return metrics;
  }

  /**
   * Export feedback for long-term storage
   */
  exportFeedback(options?: {
    since?: Date;
    types?: FeedbackType[];
  }): FeedbackEntry[] {
    let entries = Array.from(this.feedbackStore.values());

    if (options?.since) {
      entries = entries.filter(e => new Date(e.timestamp) >= options.since!);
    }

    if (options?.types) {
      entries = entries.filter(e => options.types!.includes(e.type));
    }

    return entries;
  }

  /**
   * Import feedback from external storage
   */
  importFeedback(entries: FeedbackEntry[]): number {
    let imported = 0;

    for (const entry of entries) {
      if (!this.feedbackStore.has(entry.id)) {
        this.feedbackStore.set(entry.id, entry);
        this.updateStats(entry);
        imported++;
      }
    }

    this.logger.info({ imported }, 'Imported feedback entries');

    return imported;
  }

  /**
   * Clean up old feedback entries
   */
  cleanup(olderThanDays: number = 30): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [id, entry] of this.feedbackStore) {
      if (new Date(entry.timestamp).getTime() < cutoff) {
        this.feedbackStore.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info({ removed }, 'Cleaned up old feedback entries');
    }

    return removed;
  }
}
