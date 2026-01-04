import { Octokit } from '@octokit/rest';
import { pino, type Logger } from 'pino';

/**
 * Repository information
 */
export interface RepositoryInfo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  language: string | null;
  topics: string[];
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  archived: boolean;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
}

/**
 * Organization information
 */
export interface OrganizationInfo {
  id: number;
  login: string;
  name: string | null;
  description: string | null;
  htmlUrl: string;
  membersCount?: number;
  reposCount?: number;
}

/**
 * Service configuration
 */
export interface GitHubOrgServiceConfig {
  token: string;
  organization: string;
  logLevel?: string;
  excludePatterns?: string[];  // Glob patterns to exclude repositories
  includeArchived?: boolean;
  includePrivate?: boolean;
}

/**
 * GitHubOrgService - Automatically discovers and manages all repositories in a GitHub organization
 * 
 * Features:
 * - Auto-discovery of all organization repositories
 * - Webhook registration for all repositories
 * - Repository filtering (exclude archived, patterns, etc.)
 * - Caching with TTL for performance
 */
export class GitHubOrgService {
  private octokit: Octokit;
  private logger: Logger;
  private config: GitHubOrgServiceConfig;
  private repositoryCache: Map<string, RepositoryInfo> = new Map();
  private cacheTimestamp: number = 0;
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes

  constructor(config: GitHubOrgServiceConfig) {
    this.config = config;
    this.octokit = new Octokit({
      auth: config.token,
    });
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'github-org-service',
    });
  }

  /**
   * Get organization information
   */
  async getOrganization(): Promise<OrganizationInfo> {
    const { data } = await this.octokit.orgs.get({
      org: this.config.organization,
    });

    return {
      id: data.id,
      login: data.login,
      name: data.name ?? null,
      description: data.description ?? null,
      htmlUrl: data.html_url,
      membersCount: data.public_repos, // members_count not available in API response
      reposCount: data.public_repos + (data.total_private_repos || 0),
    };
  }

  /**
   * List all repositories in the organization
   * Automatically discovers all repos without manual configuration
   */
  async listRepositories(forceRefresh: boolean = false): Promise<RepositoryInfo[]> {
    // Check cache
    if (!forceRefresh && this.isCacheValid()) {
      this.logger.debug('Returning cached repositories');
      return Array.from(this.repositoryCache.values());
    }

    this.logger.info({ org: this.config.organization }, 'Fetching all organization repositories');

    const repositories: RepositoryInfo[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.octokit.repos.listForOrg({
        org: this.config.organization,
        type: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
        page,
      });

      if (data.length === 0) break;

      for (const repo of data) {
        // Filter out archived repositories unless explicitly included
        if (repo.archived && !this.config.includeArchived) {
          continue;
        }

        // Filter out private repositories unless explicitly included
        if (repo.private && !this.config.includePrivate) {
          continue;
        }

        // Filter out by exclude patterns
        if (this.shouldExclude(repo.name)) {
          this.logger.debug({ repo: repo.name }, 'Excluding repository by pattern');
          continue;
        }

        const repoInfo: RepositoryInfo = {
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          owner: repo.owner.login,
          description: repo.description ?? null,
          isPrivate: repo.private,
          defaultBranch: repo.default_branch ?? 'main',
          language: repo.language ?? null,
          topics: repo.topics || [],
          htmlUrl: repo.html_url,
          cloneUrl: repo.clone_url ?? '',
          sshUrl: repo.ssh_url ?? '',
          archived: repo.archived ?? false,
          disabled: repo.disabled ?? false,
          createdAt: repo.created_at ?? new Date().toISOString(),
          updatedAt: repo.updated_at ?? new Date().toISOString(),
          pushedAt: repo.pushed_at ?? null,
        };

        repositories.push(repoInfo);
      }

      page++;
    }

    // Update cache
    this.repositoryCache.clear();
    for (const repo of repositories) {
      this.repositoryCache.set(repo.name, repo);
    }
    this.cacheTimestamp = Date.now();

    this.logger.info({
      org: this.config.organization,
      count: repositories.length,
    }, 'Fetched organization repositories');

    return repositories;
  }

  /**
   * Get a specific repository
   */
  async getRepository(name: string, forceRefresh: boolean = false): Promise<RepositoryInfo | null> {
    // Check cache first
    if (!forceRefresh && this.isCacheValid() && this.repositoryCache.has(name)) {
      return this.repositoryCache.get(name) || null;
    }

    try {
      const { data: repo } = await this.octokit.repos.get({
        owner: this.config.organization,
        repo: name,
      });

      const repoInfo: RepositoryInfo = {
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        description: repo.description,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
        language: repo.language,
        topics: repo.topics || [],
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        archived: repo.archived,
        disabled: repo.disabled,
        createdAt: repo.created_at,
        updatedAt: repo.updated_at,
        pushedAt: repo.pushed_at,
      };

      // Update cache
      this.repositoryCache.set(name, repoInfo);

      return repoInfo;
    } catch (error: any) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Register webhook for a repository
   * 
   * Default events include CI-related events for self-healing pipeline:
   * - check_run, check_suite, workflow_run: For CI status monitoring
   * - pull_request, issue_comment: For PR lifecycle and commands
   * - push: For code change tracking
   */
  async registerWebhook(
    repoName: string,
    webhookUrl: string,
    events: string[] = [
      'check_run',       // Individual CI check status
      'check_suite',     // Grouped CI check status
      'workflow_run',    // GitHub Actions workflow status
      'pull_request',    // PR lifecycle events
      'issue_comment',   // Commands like /autofix, /approve, /merge
      'pull_request_review', // Review status
      'push',            // Code changes
    ],
    secret?: string
  ): Promise<{ id: number; active: boolean }> {
    const { data: hook } = await this.octokit.repos.createWebhook({
      owner: this.config.organization,
      repo: repoName,
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret: secret,
        insecure_ssl: '0',
      },
      events,
      active: true,
    });

    this.logger.info({
      repo: repoName,
      hookId: hook.id,
      events,
    }, 'Registered webhook for repository');

    return {
      id: hook.id,
      active: hook.active,
    };
  }

  /**
   * Register webhook for all repositories in the organization
   * 
   * Default events include CI-related events for self-healing pipeline.
   */
  async registerWebhooksForAll(
    webhookUrl: string,
    events: string[] = [
      'check_run',       // Individual CI check status
      'check_suite',     // Grouped CI check status  
      'workflow_run',    // GitHub Actions workflow status
      'pull_request',    // PR lifecycle events
      'issue_comment',   // Commands like /autofix, /approve, /merge
      'pull_request_review', // Review status
    ],
    secret?: string
  ): Promise<Array<{ repo: string; hookId?: number; error?: string }>> {
    const repositories = await this.listRepositories();
    const results: Array<{ repo: string; hookId?: number; error?: string }> = [];

    for (const repo of repositories) {
      try {
        // Check if webhook already exists
        const existingHooks = await this.listWebhooks(repo.name);
        const existingHook = existingHooks.find(h => h.config?.url === webhookUrl);

        if (existingHook) {
          this.logger.debug({ repo: repo.name }, 'Webhook already exists');
          results.push({ repo: repo.name, hookId: existingHook.id });
          continue;
        }

        const { id } = await this.registerWebhook(repo.name, webhookUrl, events, secret);
        results.push({ repo: repo.name, hookId: id });
      } catch (error: any) {
        this.logger.error({
          repo: repo.name,
          error: error.message,
        }, 'Failed to register webhook');
        results.push({ repo: repo.name, error: error.message });
      }
    }

    return results;
  }

  /**
   * List webhooks for a repository
   */
  async listWebhooks(repoName: string): Promise<Array<{ id: number; active: boolean; config?: { url?: string } }>> {
    const { data: hooks } = await this.octokit.repos.listWebhooks({
      owner: this.config.organization,
      repo: repoName,
    });

    return hooks.map(h => ({
      id: h.id,
      active: h.active,
      config: h.config,
    }));
  }

  /**
   * Create a new repository in the organization
   */
  async createRepository(
    name: string,
    options: {
      description?: string;
      private?: boolean;
      autoInit?: boolean;
      topics?: string[];
    } = {}
  ): Promise<RepositoryInfo> {
    const { data: repo } = await this.octokit.repos.createInOrg({
      org: this.config.organization,
      name,
      description: options.description,
      private: options.private ?? true,
      auto_init: options.autoInit ?? true,
    });

    // Set topics if provided
    if (options.topics && options.topics.length > 0) {
      await this.octokit.repos.replaceAllTopics({
        owner: this.config.organization,
        repo: name,
        names: options.topics,
      });
    }

    const repoInfo: RepositoryInfo = {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      description: repo.description,
      isPrivate: repo.private,
      defaultBranch: repo.default_branch,
      language: repo.language,
      topics: options.topics || [],
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      sshUrl: repo.ssh_url,
      archived: repo.archived,
      disabled: repo.disabled,
      createdAt: repo.created_at,
      updatedAt: repo.updated_at,
      pushedAt: repo.pushed_at,
    };

    // Update cache
    this.repositoryCache.set(name, repoInfo);

    this.logger.info({ repo: name }, 'Created new repository');

    return repoInfo;
  }

  /**
   * Watch for new repositories (polling-based)
   * Returns repositories created since last check
   */
  async checkForNewRepositories(): Promise<RepositoryInfo[]> {
    const previousRepos = new Set(this.repositoryCache.keys());
    const currentRepos = await this.listRepositories(true);

    const newRepos = currentRepos.filter(repo => !previousRepos.has(repo.name));

    if (newRepos.length > 0) {
      this.logger.info({
        count: newRepos.length,
        repos: newRepos.map(r => r.name),
      }, 'Detected new repositories');
    }

    return newRepos;
  }

  /**
   * Check if repository should be excluded
   */
  private shouldExclude(name: string): boolean {
    if (!this.config.excludePatterns || this.config.excludePatterns.length === 0) {
      return false;
    }

    for (const pattern of this.config.excludePatterns) {
      // Simple glob matching (supports * and ?)
      const regex = new RegExp(
        '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      if (regex.test(name)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if cache is still valid
   */
  private isCacheValid(): boolean {
    return (
      this.repositoryCache.size > 0 &&
      Date.now() - this.cacheTimestamp < this.cacheTTL
    );
  }

  /**
   * Set cache TTL
   */
  setCacheTTL(ttlMs: number): void {
    this.cacheTTL = ttlMs;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.repositoryCache.clear();
    this.cacheTimestamp = 0;
  }
}
