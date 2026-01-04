/**
 * XORNG Automation - State Persistence Service
 * 
 * Provides Redis-backed persistence for automation state that needs to survive restarts:
 * - Fix attempts tracking (prevents retry storms)
 * - Applied analyses (enables learning from success)
 * - Repository locks (prevents concurrent fixes)
 * 
 * Uses ioredis for Redis connectivity with automatic reconnection.
 */

import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';
import { EventEmitter } from 'events';

/**
 * Fix attempt record stored per PR
 */
export interface PersistedFixAttempt {
  attempts: number;
  lastAttempt: string; // ISO timestamp
  lastError?: string;
  analyses?: string[]; // Stringified analyses for restoration
}

/**
 * Repository lock record
 */
export interface PersistedRepoLock {
  prNumber: number;
  owner: string;
  acquiredAt: string; // ISO timestamp
  reason?: string;
}

/**
 * Applied analysis record
 */
export interface PersistedAnalysis {
  category: string;
  severity: string;
  description: string;
  file?: string;
  line?: number;
  suggestedFix?: string;
  appliedAt: string; // ISO timestamp
}

/**
 * Configuration for state persistence
 */
export interface StatePersistenceConfig {
  redisUrl: string;
  keyPrefix?: string;
  logLevel?: string;
  /** TTL for fix attempts in seconds (default: 7 days) */
  fixAttemptsTTL?: number;
  /** TTL for repo locks in seconds (default: 1 hour) */
  repoLocksTTL?: number;
  /** TTL for applied analyses in seconds (default: 7 days) */
  analysesTTL?: number;
}

/**
 * Redis key namespaces
 */
const KEYS = {
  FIX_ATTEMPTS: 'fix-attempts',
  REPO_LOCKS: 'repo-locks',
  APPLIED_ANALYSES: 'applied-analyses',
} as const;

/**
 * State Persistence Service
 * 
 * Handles Redis-backed persistence for automation state with:
 * - Automatic reconnection on connection loss
 * - Graceful degradation (falls back to in-memory if Redis unavailable)
 * - TTL-based expiration for stale data cleanup
 */
export class StatePersistence extends EventEmitter {
  private redis: Redis;
  private logger: Logger;
  private config: Required<StatePersistenceConfig>;
  private connected = false;
  
  // In-memory fallback caches (used when Redis is unavailable)
  private localFixAttempts = new Map<string, PersistedFixAttempt>();
  private localRepoLocks = new Map<string, PersistedRepoLock>();
  private localAnalyses = new Map<string, PersistedAnalysis[]>();

  constructor(config: StatePersistenceConfig) {
    super();
    
    this.config = {
      redisUrl: config.redisUrl,
      keyPrefix: config.keyPrefix || 'xorng:automation:',
      logLevel: config.logLevel || 'info',
      fixAttemptsTTL: config.fixAttemptsTTL || 7 * 24 * 60 * 60, // 7 days
      repoLocksTTL: config.repoLocksTTL || 60 * 60, // 1 hour
      analysesTTL: config.analysesTTL || 7 * 24 * 60 * 60, // 7 days
    };

    this.logger = pino({
      level: this.config.logLevel,
      name: 'state-persistence',
    });

    this.redis = new Redis(this.config.redisUrl, {
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 100, 3000);
        this.logger.warn({ attempt: times, delay }, 'Redis reconnecting...');
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.setupEventHandlers();
  }

  /**
   * Setup Redis event handlers
   */
  private setupEventHandlers(): void {
    this.redis.on('connect', () => {
      this.logger.info('Redis connected');
      this.connected = true;
      this.emit('connected');
    });

    this.redis.on('ready', () => {
      this.logger.info('Redis ready');
      this.syncFromLocal();
    });

    this.redis.on('error', (err: Error) => {
      this.logger.error({ err }, 'Redis error');
      this.emit('error', err);
    });

    this.redis.on('close', () => {
      this.logger.warn('Redis connection closed');
      this.connected = false;
      this.emit('disconnected');
    });

    this.redis.on('reconnecting', () => {
      this.logger.info('Redis reconnecting...');
    });
  }

  /**
   * Sync local cache to Redis after reconnection
   */
  private async syncFromLocal(): Promise<void> {
    if (!this.connected) return;

    try {
      // Sync fix attempts
      for (const [key, value] of this.localFixAttempts) {
        await this.setFixAttempts(key, value);
      }

      // Sync repo locks
      for (const [key, value] of this.localRepoLocks) {
        await this.setRepoLock(key, value);
      }

      // Sync analyses
      for (const [key, value] of this.localAnalyses) {
        await this.setAppliedAnalyses(key, value);
      }

      this.logger.info({
        fixAttempts: this.localFixAttempts.size,
        repoLocks: this.localRepoLocks.size,
        analyses: this.localAnalyses.size,
      }, 'Synced local cache to Redis');
    } catch (error) {
      this.logger.error({ error }, 'Failed to sync local cache to Redis');
    }
  }

  /**
   * Build Redis key with prefix
   */
  private key(namespace: string, id: string): string {
    return `${this.config.keyPrefix}${namespace}:${id}`;
  }

  // ===========================================
  // Fix Attempts Management
  // ===========================================

  /**
   * Get fix attempts for a PR
   * @param prKey Format: "repo#prNumber" (e.g., "core#123")
   */
  async getFixAttempts(prKey: string): Promise<PersistedFixAttempt | null> {
    try {
      if (this.connected) {
        const data = await this.redis.get(this.key(KEYS.FIX_ATTEMPTS, prKey));
        if (data) {
          const parsed = JSON.parse(data) as PersistedFixAttempt;
          this.localFixAttempts.set(prKey, parsed); // Update local cache
          return parsed;
        }
      }
      return this.localFixAttempts.get(prKey) || null;
    } catch (error) {
      this.logger.error({ error, prKey }, 'Failed to get fix attempts');
      return this.localFixAttempts.get(prKey) || null;
    }
  }

  /**
   * Set fix attempts for a PR
   */
  async setFixAttempts(prKey: string, data: PersistedFixAttempt): Promise<void> {
    this.localFixAttempts.set(prKey, data);
    
    try {
      if (this.connected) {
        await this.redis.setex(
          this.key(KEYS.FIX_ATTEMPTS, prKey),
          this.config.fixAttemptsTTL,
          JSON.stringify(data)
        );
      }
    } catch (error) {
      this.logger.error({ error, prKey }, 'Failed to persist fix attempts');
    }
  }

  /**
   * Increment fix attempts for a PR
   * Returns the new attempt count
   */
  async incrementFixAttempts(prKey: string, error?: string): Promise<number> {
    const existing = await this.getFixAttempts(prKey);
    const newData: PersistedFixAttempt = {
      attempts: (existing?.attempts || 0) + 1,
      lastAttempt: new Date().toISOString(),
      lastError: error,
      analyses: existing?.analyses,
    };
    await this.setFixAttempts(prKey, newData);
    return newData.attempts;
  }

  /**
   * Delete fix attempts for a PR
   */
  async deleteFixAttempts(prKey: string): Promise<void> {
    this.localFixAttempts.delete(prKey);
    
    try {
      if (this.connected) {
        await this.redis.del(this.key(KEYS.FIX_ATTEMPTS, prKey));
      }
    } catch (error) {
      this.logger.error({ error, prKey }, 'Failed to delete fix attempts');
    }
  }

  /**
   * Reset fix attempts to 0 (for retry requests)
   */
  async resetFixAttempts(prKey: string): Promise<void> {
    const existing = await this.getFixAttempts(prKey);
    await this.setFixAttempts(prKey, {
      attempts: 0,
      lastAttempt: new Date().toISOString(),
      analyses: existing?.analyses,
    });
  }

  // ===========================================
  // Repository Locks Management
  // ===========================================

  /**
   * Get repository lock
   * @param repoKey Format: "owner/repo" (e.g., "XORNG/core")
   */
  async getRepoLock(repoKey: string): Promise<PersistedRepoLock | null> {
    try {
      if (this.connected) {
        const data = await this.redis.get(this.key(KEYS.REPO_LOCKS, repoKey));
        if (data) {
          const parsed = JSON.parse(data) as PersistedRepoLock;
          this.localRepoLocks.set(repoKey, parsed);
          return parsed;
        }
      }
      return this.localRepoLocks.get(repoKey) || null;
    } catch (error) {
      this.logger.error({ error, repoKey }, 'Failed to get repo lock');
      return this.localRepoLocks.get(repoKey) || null;
    }
  }

  /**
   * Set repository lock
   */
  async setRepoLock(repoKey: string, data: PersistedRepoLock): Promise<void> {
    this.localRepoLocks.set(repoKey, data);
    
    try {
      if (this.connected) {
        await this.redis.setex(
          this.key(KEYS.REPO_LOCKS, repoKey),
          this.config.repoLocksTTL,
          JSON.stringify(data)
        );
      }
    } catch (error) {
      this.logger.error({ error, repoKey }, 'Failed to persist repo lock');
    }
  }

  /**
   * Try to acquire a repository lock (atomic operation)
   * Returns true if lock was acquired, false if already locked by another PR
   */
  async tryAcquireRepoLock(repoKey: string, owner: string, prNumber: number): Promise<boolean> {
    const key = this.key(KEYS.REPO_LOCKS, repoKey);
    const lockData: PersistedRepoLock = {
      prNumber,
      owner,
      acquiredAt: new Date().toISOString(),
    };

    try {
      if (this.connected) {
        // Use SETNX for atomic lock acquisition
        const result = await this.redis.set(
          key,
          JSON.stringify(lockData),
          'EX',
          this.config.repoLocksTTL,
          'NX'
        );
        
        if (result === 'OK') {
          this.localRepoLocks.set(repoKey, lockData);
          return true;
        }
        
        // Check if current lock is for the same PR (re-entrant)
        const existing = await this.getRepoLock(repoKey);
        if (existing && existing.prNumber === prNumber) {
          return true;
        }
        
        return false;
      }
      
      // Fallback to local
      const existing = this.localRepoLocks.get(repoKey);
      if (!existing || existing.prNumber === prNumber) {
        this.localRepoLocks.set(repoKey, lockData);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error({ error, repoKey, prNumber }, 'Failed to acquire repo lock');
      // Fallback to local on error
      const existing = this.localRepoLocks.get(repoKey);
      if (!existing || existing.prNumber === prNumber) {
        this.localRepoLocks.set(repoKey, lockData);
        return true;
      }
      return false;
    }
  }

  /**
   * Release repository lock
   */
  async releaseRepoLock(repoKey: string, prNumber: number): Promise<boolean> {
    try {
      const existing = await this.getRepoLock(repoKey);
      
      // Only release if this PR holds the lock
      if (!existing || existing.prNumber !== prNumber) {
        return false;
      }
      
      this.localRepoLocks.delete(repoKey);
      
      if (this.connected) {
        await this.redis.del(this.key(KEYS.REPO_LOCKS, repoKey));
      }
      
      return true;
    } catch (error) {
      this.logger.error({ error, repoKey, prNumber }, 'Failed to release repo lock');
      return false;
    }
  }

  /**
   * Get the PR number holding the lock for a repo
   */
  async getLockedPR(repoKey: string): Promise<number | null> {
    const lock = await this.getRepoLock(repoKey);
    return lock?.prNumber || null;
  }

  // ===========================================
  // Applied Analyses Management
  // ===========================================

  /**
   * Get applied analyses for a PR
   * @param prKey Format: "owner/repo#prNumber" (e.g., "XORNG/core#123")
   */
  async getAppliedAnalyses(prKey: string): Promise<PersistedAnalysis[] | null> {
    try {
      if (this.connected) {
        const data = await this.redis.get(this.key(KEYS.APPLIED_ANALYSES, prKey));
        if (data) {
          const parsed = JSON.parse(data) as PersistedAnalysis[];
          this.localAnalyses.set(prKey, parsed);
          return parsed;
        }
      }
      return this.localAnalyses.get(prKey) || null;
    } catch (error) {
      this.logger.error({ error, prKey }, 'Failed to get applied analyses');
      return this.localAnalyses.get(prKey) || null;
    }
  }

  /**
   * Set applied analyses for a PR
   */
  async setAppliedAnalyses(prKey: string, analyses: PersistedAnalysis[]): Promise<void> {
    this.localAnalyses.set(prKey, analyses);
    
    try {
      if (this.connected) {
        await this.redis.setex(
          this.key(KEYS.APPLIED_ANALYSES, prKey),
          this.config.analysesTTL,
          JSON.stringify(analyses)
        );
      }
    } catch (error) {
      this.logger.error({ error, prKey }, 'Failed to persist applied analyses');
    }
  }

  /**
   * Add an analysis to a PR's applied analyses
   */
  async addAppliedAnalysis(prKey: string, analysis: PersistedAnalysis): Promise<void> {
    const existing = await this.getAppliedAnalyses(prKey);
    const analyses = existing || [];
    analyses.push(analysis);
    await this.setAppliedAnalyses(prKey, analyses);
  }

  /**
   * Delete applied analyses for a PR
   */
  async deleteAppliedAnalyses(prKey: string): Promise<void> {
    this.localAnalyses.delete(prKey);
    
    try {
      if (this.connected) {
        await this.redis.del(this.key(KEYS.APPLIED_ANALYSES, prKey));
      }
    } catch (error) {
      this.logger.error({ error, prKey }, 'Failed to delete applied analyses');
    }
  }

  // ===========================================
  // Lifecycle Methods
  // ===========================================

  /**
   * Check if Redis is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Initialize the persistence service
   * Loads existing state from Redis into local cache
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing state persistence service');
    
    try {
      // Wait for Redis connection with timeout
      if (!this.connected) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.logger.warn('Redis connection timeout, using local cache only');
            resolve();
          }, 5000);

          this.redis.once('ready', () => {
            clearTimeout(timeout);
            resolve();
          });

          this.redis.once('error', (err: Error) => {
            clearTimeout(timeout);
            this.logger.warn({ err }, 'Redis connection failed, using local cache');
            resolve();
          });
        });
      }

      // Load existing keys into local cache
      if (this.connected) {
        await this.loadStateFromRedis();
      }

      this.logger.info({ connected: this.connected }, 'State persistence initialized');
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize state persistence');
    }
  }

  /**
   * Load all state from Redis into local cache
   */
  private async loadStateFromRedis(): Promise<void> {
    try {
      const prefix = this.config.keyPrefix;
      
      // Load fix attempts
      const fixAttemptsKeys = await this.redis.keys(`${prefix}${KEYS.FIX_ATTEMPTS}:*`);
      for (const key of fixAttemptsKeys) {
        const data = await this.redis.get(key);
        if (data) {
          const prKey = key.replace(`${prefix}${KEYS.FIX_ATTEMPTS}:`, '');
          this.localFixAttempts.set(prKey, JSON.parse(data));
        }
      }

      // Load repo locks
      const repoLocksKeys = await this.redis.keys(`${prefix}${KEYS.REPO_LOCKS}:*`);
      for (const key of repoLocksKeys) {
        const data = await this.redis.get(key);
        if (data) {
          const repoKey = key.replace(`${prefix}${KEYS.REPO_LOCKS}:`, '');
          this.localRepoLocks.set(repoKey, JSON.parse(data));
        }
      }

      // Load analyses
      const analysesKeys = await this.redis.keys(`${prefix}${KEYS.APPLIED_ANALYSES}:*`);
      for (const key of analysesKeys) {
        const data = await this.redis.get(key);
        if (data) {
          const prKey = key.replace(`${prefix}${KEYS.APPLIED_ANALYSES}:`, '');
          this.localAnalyses.set(prKey, JSON.parse(data));
        }
      }

      this.logger.info({
        fixAttempts: this.localFixAttempts.size,
        repoLocks: this.localRepoLocks.size,
        analyses: this.localAnalyses.size,
      }, 'Loaded state from Redis');
    } catch (error) {
      this.logger.error({ error }, 'Failed to load state from Redis');
    }
  }

  /**
   * Gracefully close the Redis connection
   */
  async close(): Promise<void> {
    this.logger.info('Closing state persistence service');
    try {
      await this.redis.quit();
      this.connected = false;
    } catch (error) {
      this.logger.error({ error }, 'Error closing Redis connection');
    }
  }

  /**
   * Get all active fix attempts (for debugging/monitoring)
   */
  async getAllFixAttempts(): Promise<Map<string, PersistedFixAttempt>> {
    if (this.connected) {
      await this.loadStateFromRedis();
    }
    return new Map(this.localFixAttempts);
  }

  /**
   * Get all active repo locks (for debugging/monitoring)
   */
  async getAllRepoLocks(): Promise<Map<string, PersistedRepoLock>> {
    if (this.connected) {
      // Refresh from Redis
      const prefix = this.config.keyPrefix;
      const keys = await this.redis.keys(`${prefix}${KEYS.REPO_LOCKS}:*`);
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          const repoKey = key.replace(`${prefix}${KEYS.REPO_LOCKS}:`, '');
          this.localRepoLocks.set(repoKey, JSON.parse(data));
        }
      }
    }
    return new Map(this.localRepoLocks);
  }
}

/**
 * Create and initialize a StatePersistence instance
 */
export async function createStatePersistence(config: StatePersistenceConfig): Promise<StatePersistence> {
  const persistence = new StatePersistence(config);
  await persistence.initialize();
  return persistence;
}
