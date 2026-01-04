/**
 * Multi-Repository Scanner for Self-Healing Pipeline
 * 
 * This service periodically scans ALL repositories in the GitHub organization
 * to find open PRs with failing CI checks. This serves as:
 * 1. A backup mechanism when webhooks are missed
 * 2. A way to catch PRs that existed before webhooks were registered
 * 3. An initialization scan on server startup
 * 
 * The scanner works in conjunction with PipelineAutomation which handles
 * real-time webhook events. Together they ensure complete coverage.
 */

import { Octokit } from '@octokit/rest';
import { EventEmitter } from 'events';
import { pino, type Logger } from 'pino';
import type { GitHubOrgService, RepositoryInfo } from './github-org-service.js';
import type { PipelineAutomation } from './pipeline-automation.js';

/**
 * Open PR with failing checks
 */
export interface FailingPR {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  headBranch: string;
  author: string;
  failedChecks: string[];
  totalChecks: number;
  passedChecks: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Scan result summary
 */
export interface ScanResult {
  scannedAt: Date;
  totalRepos: number;
  reposScanned: number;
  reposSkipped: number;
  totalOpenPRs: number;
  failingPRs: number;
  processedPRs: number;
  errors: Array<{ repo: string; error: string }>;
}

/**
 * Scanner configuration
 */
export interface MultiRepoScannerConfig {
  /** GitHub API token */
  token: string;
  
  /** GitHub organization name */
  organization: string;
  
  /** GitHub org service for repository discovery */
  githubOrgService: GitHubOrgService;
  
  /** Pipeline automation service for processing failures */
  pipelineAutomation: PipelineAutomation;
  
  /** Scan interval in milliseconds (default: 5 minutes) */
  scanIntervalMs?: number;
  
  /** Enable periodic scanning (default: true) */
  enablePeriodicScan?: boolean;
  
  /** Max concurrent repository scans (default: 5) */
  maxConcurrentScans?: number;
  
  /** Skip repos with no open PRs (optimization) */
  skipReposWithoutPRs?: boolean;
  
  /** Logging level */
  logLevel?: string;
}

/**
 * Events emitted by the scanner
 */
export interface MultiRepoScannerEvents {
  'scan:started': () => void;
  'scan:completed': (result: ScanResult) => void;
  'scan:error': (error: Error) => void;
  'pr:found': (pr: FailingPR) => void;
  'pr:processed': (pr: FailingPR, success: boolean) => void;
}

/**
 * MultiRepoScanner - Scans all organization repositories for failing PRs
 * 
 * This is the central component for multi-repo self-healing pipeline monitoring.
 * It complements webhook-based detection with periodic scanning to ensure
 * no failing PRs are missed.
 */
export class MultiRepoScanner extends EventEmitter {
  private octokit: Octokit;
  private logger: Logger;
  private config: MultiRepoScannerConfig;
  private githubOrgService: GitHubOrgService;
  private pipelineAutomation: PipelineAutomation;
  
  /** Periodic scan interval handle */
  private scanInterval?: NodeJS.Timeout;
  
  /** Track scan state */
  private isScanning = false;
  private lastScanResult?: ScanResult;
  
  /** Statistics */
  private stats = {
    totalScans: 0,
    totalPRsFound: 0,
    totalPRsProcessed: 0,
    totalErrors: 0,
  };

  constructor(config: MultiRepoScannerConfig) {
    super();
    
    this.config = {
      scanIntervalMs: config.scanIntervalMs ?? 5 * 60 * 1000, // 5 minutes
      enablePeriodicScan: config.enablePeriodicScan ?? true,
      maxConcurrentScans: config.maxConcurrentScans ?? 5,
      skipReposWithoutPRs: config.skipReposWithoutPRs ?? true,
      ...config,
    };
    
    this.octokit = new Octokit({ auth: config.token });
    this.githubOrgService = config.githubOrgService;
    this.pipelineAutomation = config.pipelineAutomation;
    
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'multi-repo-scanner',
    });
    
    this.logger.info({
      organization: config.organization,
      scanIntervalMs: this.config.scanIntervalMs,
      enablePeriodicScan: this.config.enablePeriodicScan,
    }, 'Multi-repo scanner initialized');
  }

  /**
   * Start periodic scanning
   */
  start(): void {
    if (!this.config.enablePeriodicScan) {
      this.logger.info('Periodic scanning is disabled');
      return;
    }
    
    if (this.scanInterval) {
      this.logger.warn('Scanner is already running');
      return;
    }
    
    this.logger.info({
      intervalMs: this.config.scanIntervalMs,
    }, 'Starting periodic multi-repo scanning');
    
    // Run initial scan immediately
    this.scan().catch(err => {
      this.logger.error({ error: err }, 'Initial scan failed');
    });
    
    // Schedule periodic scans
    this.scanInterval = setInterval(() => {
      this.scan().catch(err => {
        this.logger.error({ error: err }, 'Periodic scan failed');
      });
    }, this.config.scanIntervalMs);
  }

  /**
   * Stop periodic scanning
   */
  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
      this.logger.info('Stopped periodic scanning');
    }
  }

  /**
   * Perform a single scan of all repositories
   */
  async scan(): Promise<ScanResult> {
    if (this.isScanning) {
      this.logger.warn('Scan already in progress, skipping');
      return this.lastScanResult || this.createEmptyResult();
    }
    
    this.isScanning = true;
    this.emit('scan:started');
    
    const result: ScanResult = {
      scannedAt: new Date(),
      totalRepos: 0,
      reposScanned: 0,
      reposSkipped: 0,
      totalOpenPRs: 0,
      failingPRs: 0,
      processedPRs: 0,
      errors: [],
    };
    
    try {
      this.logger.info('Starting multi-repo scan');
      
      // Get all repositories in the organization
      const repos = await this.githubOrgService.listRepositories();
      result.totalRepos = repos.length;
      
      this.logger.info({ repoCount: repos.length }, 'Found repositories to scan');
      
      // Process repos in batches to avoid rate limiting
      const batchSize = this.config.maxConcurrentScans!;
      
      for (let i = 0; i < repos.length; i += batchSize) {
        const batch = repos.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(repo => this.scanRepository(repo, result))
        );
      }
      
      this.stats.totalScans++;
      this.lastScanResult = result;
      
      this.logger.info({
        totalRepos: result.totalRepos,
        reposScanned: result.reposScanned,
        reposSkipped: result.reposSkipped,
        totalOpenPRs: result.totalOpenPRs,
        failingPRs: result.failingPRs,
        processedPRs: result.processedPRs,
        errors: result.errors.length,
      }, 'Multi-repo scan completed');
      
      this.emit('scan:completed', result);
      
      return result;
    } catch (error) {
      this.logger.error({ error }, 'Multi-repo scan failed');
      this.stats.totalErrors++;
      this.emit('scan:error', error as Error);
      throw error;
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Scan a single repository for failing PRs
   */
  private async scanRepository(repo: RepositoryInfo, result: ScanResult): Promise<void> {
    try {
      // Skip archived or disabled repos
      if (repo.archived || repo.disabled) {
        result.reposSkipped++;
        return;
      }
      
      // Get open PRs for this repo
      const { data: prs } = await this.octokit.pulls.list({
        owner: repo.owner,
        repo: repo.name,
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 30,
      });
      
      if (prs.length === 0) {
        if (this.config.skipReposWithoutPRs) {
          result.reposSkipped++;
          return;
        }
      }
      
      result.reposScanned++;
      result.totalOpenPRs += prs.length;
      
      // Check each PR for failing checks
      for (const pr of prs) {
        try {
          const failingPR = await this.checkPRStatus(repo, pr);
          
          if (failingPR) {
            result.failingPRs++;
            this.stats.totalPRsFound++;
            this.emit('pr:found', failingPR);
            
            // Process the failing PR through pipeline automation
            const processed = await this.processPR(failingPR);
            if (processed) {
              result.processedPRs++;
              this.stats.totalPRsProcessed++;
            }
          }
        } catch (error: any) {
          this.logger.error({
            repo: repo.name,
            pr: pr.number,
            error: error.message,
          }, 'Failed to check PR status');
        }
      }
    } catch (error: any) {
      this.logger.error({
        repo: repo.name,
        error: error.message,
      }, 'Failed to scan repository');
      result.errors.push({ repo: repo.name, error: error.message });
    }
  }

  /**
   * Check if a PR has failing checks
   */
  private async checkPRStatus(
    repo: RepositoryInfo,
    pr: { number: number; title: string; head: { sha: string; ref: string }; user: { login: string } | null; created_at: string; updated_at: string }
  ): Promise<FailingPR | null> {
    // Get check runs for the PR's head commit
    const { data: checks } = await this.octokit.checks.listForRef({
      owner: repo.owner,
      repo: repo.name,
      ref: pr.head.sha,
    });
    
    const failedChecks = checks.check_runs.filter(
      check => check.status === 'completed' && 
               (check.conclusion === 'failure' || check.conclusion === 'timed_out')
    );
    
    const passedChecks = checks.check_runs.filter(
      check => check.status === 'completed' && 
               (check.conclusion === 'success' || check.conclusion === 'skipped')
    );
    
    // No failing checks
    if (failedChecks.length === 0) {
      return null;
    }
    
    return {
      owner: repo.owner,
      repo: repo.name,
      number: pr.number,
      title: pr.title,
      headSha: pr.head.sha,
      headBranch: pr.head.ref,
      author: pr.user?.login || 'unknown',
      failedChecks: failedChecks.map(c => c.name),
      totalChecks: checks.check_runs.length,
      passedChecks: passedChecks.length,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    };
  }

  /**
   * Process a failing PR through the pipeline automation
   */
  private async processPR(pr: FailingPR): Promise<boolean> {
    try {
      this.logger.info({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        failedChecks: pr.failedChecks,
      }, 'Processing failing PR from scan');
      
      // Trigger analysis through pipeline automation
      // The automation handles locking, queuing, and fix attempts
      await this.pipelineAutomation.triggerPRAnalysis(pr.owner, pr.repo, pr.number);
      
      this.emit('pr:processed', pr, true);
      return true;
    } catch (error: any) {
      this.logger.error({
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        error: error.message,
      }, 'Failed to process failing PR');
      
      this.emit('pr:processed', pr, false);
      return false;
    }
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    totalScans: number;
    totalPRsFound: number;
    totalPRsProcessed: number;
    totalErrors: number;
    lastScanResult: ScanResult | undefined;
    isScanning: boolean;
  } {
    return {
      ...this.stats,
      lastScanResult: this.lastScanResult,
      isScanning: this.isScanning,
    };
  }

  /**
   * Get health status
   */
  getHealth(): {
    healthy: boolean;
    isScanning: boolean;
    lastScanAt: Date | undefined;
    scanIntervalMs: number;
    periodicScanEnabled: boolean;
  } {
    return {
      healthy: true,
      isScanning: this.isScanning,
      lastScanAt: this.lastScanResult?.scannedAt,
      scanIntervalMs: this.config.scanIntervalMs!,
      periodicScanEnabled: this.config.enablePeriodicScan!,
    };
  }

  /**
   * Force a scan of specific repositories
   */
  async scanRepositories(repoNames: string[]): Promise<FailingPR[]> {
    const failingPRs: FailingPR[] = [];
    
    for (const repoName of repoNames) {
      try {
        const repo = await this.githubOrgService.getRepository(repoName);
        if (!repo) {
          this.logger.warn({ repo: repoName }, 'Repository not found');
          continue;
        }
        
        const result = this.createEmptyResult();
        await this.scanRepository(repo, result);
        
        // Collect any failing PRs found
        if (result.failingPRs > 0) {
          // Re-scan to get the actual PR objects
          const { data: prs } = await this.octokit.pulls.list({
            owner: repo.owner,
            repo: repo.name,
            state: 'open',
          });
          
          for (const pr of prs) {
            const failingPR = await this.checkPRStatus(repo, pr);
            if (failingPR) {
              failingPRs.push(failingPR);
            }
          }
        }
      } catch (error: any) {
        this.logger.error({
          repo: repoName,
          error: error.message,
        }, 'Failed to scan specific repository');
      }
    }
    
    return failingPRs;
  }

  /**
   * Create an empty scan result
   */
  private createEmptyResult(): ScanResult {
    return {
      scannedAt: new Date(),
      totalRepos: 0,
      reposScanned: 0,
      reposSkipped: 0,
      totalOpenPRs: 0,
      failingPRs: 0,
      processedPRs: 0,
      errors: [],
    };
  }
}
