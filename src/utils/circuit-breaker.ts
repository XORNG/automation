import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';

/**
 * Circuit Breaker States
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit Breaker Configuration
 */
export interface CircuitBreakerConfig {
  /** Name for logging and identification */
  name: string;
  /** Number of failures before opening the circuit */
  failureThreshold?: number;
  /** Time in ms before attempting to close the circuit */
  resetTimeout?: number;
  /** Number of successful calls in half-open state to close circuit */
  successThreshold?: number;
  /** Timeout for individual calls in ms */
  callTimeout?: number;
  /** Log level */
  logLevel?: string;
}

/**
 * Circuit Breaker Statistics
 */
export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  totalCalls: number;
  lastFailure: string | null;
  lastSuccess: string | null;
}

/**
 * Circuit Breaker Error
 */
export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly circuitName: string,
    public readonly state: CircuitState,
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * CircuitBreaker - Protects external service calls with fail-fast behavior
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Requests fail immediately, service is assumed down
 * - HALF-OPEN: Limited requests allowed to test if service recovered
 * 
 * Usage:
 * ```typescript
 * const breaker = new CircuitBreaker({ name: 'github-api' });
 * const result = await breaker.execute(() => githubClient.getIssues());
 * ```
 */
export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private totalCalls = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;
  private halfOpenSuccesses = 0;
  private logger: Logger;
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: CircuitBreakerConfig) {
    super();
    this.config = {
      name: config.name,
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeout: config.resetTimeout ?? 30000,
      successThreshold: config.successThreshold ?? 2,
      callTimeout: config.callTimeout ?? 30000,
      logLevel: config.logLevel ?? 'info',
    };
    this.logger = pino({
      level: this.config.logLevel,
      name: `circuit-breaker:${this.config.name}`,
    });
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    // Check if we should transition from open to half-open
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('half-open');
      } else {
        throw new CircuitBreakerError(
          `Circuit breaker '${this.config.name}' is open`,
          this.config.name,
          this.state,
        );
      }
    }

    try {
      const result = await this.executeWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error as Error);
      throw error;
    }
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Call timed out after ${this.config.callTimeout}ms`));
      }, this.config.callTimeout);

      fn()
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Handle successful call
   */
  private onSuccess(): void {
    this.successes++;
    this.lastSuccess = new Date();

    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo('closed');
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success
      this.failures = 0;
    }

    this.emit('success', this.getStats());
  }

  /**
   * Handle failed call
   */
  private onFailure(error: Error): void {
    this.failures++;
    this.lastFailure = new Date();

    this.logger.warn({
      error: error.message,
      failures: this.failures,
      threshold: this.config.failureThreshold,
    }, 'Circuit breaker recorded failure');

    if (this.state === 'half-open') {
      // Any failure in half-open goes back to open
      this.transitionTo('open');
    } else if (this.state === 'closed') {
      if (this.failures >= this.config.failureThreshold) {
        this.transitionTo('open');
      }
    }

    this.emit('failure', this.getStats(), error);
  }

  /**
   * Check if we should attempt to reset (transition to half-open)
   */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailure) return true;
    return Date.now() - this.lastFailure.getTime() >= this.config.resetTimeout;
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'half-open') {
      this.halfOpenSuccesses = 0;
    } else if (newState === 'closed') {
      this.failures = 0;
      this.halfOpenSuccesses = 0;
    }

    this.logger.info({
      from: oldState,
      to: newState,
    }, 'Circuit breaker state transition');

    this.emit('stateChange', oldState, newState);
  }

  /**
   * Force the circuit to open (for testing or manual intervention)
   */
  forceOpen(): void {
    this.transitionTo('open');
  }

  /**
   * Force the circuit to close (for testing or manual intervention)
   */
  forceClose(): void {
    this.transitionTo('closed');
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      name: this.config.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalCalls: this.totalCalls,
      lastFailure: this.lastFailure?.toISOString() ?? null,
      lastSuccess: this.lastSuccess?.toISOString() ?? null,
    };
  }

  /**
   * Check if circuit is allowing requests
   */
  isAllowing(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half-open') return true;
    return this.shouldAttemptReset();
  }
}

/**
 * Circuit Breaker Registry - Manages multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Get or create a circuit breaker
   */
  getBreaker(config: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(config.name);
    if (!breaker) {
      breaker = new CircuitBreaker(config);
      this.breakers.set(config.name, breaker);
    }
    return breaker;
  }

  /**
   * Get all circuit breaker stats
   */
  getAllStats(): CircuitBreakerStats[] {
    return Array.from(this.breakers.values()).map(b => b.getStats());
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    this.breakers.forEach(breaker => breaker.forceClose());
  }
}

// Global registry instance
export const circuitBreakerRegistry = new CircuitBreakerRegistry();
