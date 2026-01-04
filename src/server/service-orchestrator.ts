import Docker from 'dockerode';
import { Octokit } from '@octokit/rest';
import { pino, type Logger } from 'pino';

/**
 * Service definition discovered from GitHub repos
 */
export interface DiscoveredService {
  name: string;
  repoName: string;
  fullName: string;
  type: 'validator' | 'knowledge' | 'task' | 'core' | 'unknown';
  hasDockerfile: boolean;
  imageName: string;
  imageTag: string;
  topics: string[];
  updatedAt: string;
}

/**
 * Running container info
 */
export interface RunningService {
  containerId: string;
  name: string;
  image: string;
  status: string;
  state: string;
  createdAt: string;
}

/**
 * Service orchestration configuration
 */
export interface ServiceOrchestratorConfig {
  githubToken: string;
  organization: string;
  registryUrl: string;
  registryUsername?: string;
  registryPassword?: string;
  networkName: string;
  autoDeployEnabled: boolean;
  logLevel?: string;
}

/**
 * ServiceOrchestrator - Dynamically discovers and manages XORNG services
 * 
 * Features:
 * - Auto-discovers services from GitHub org repos by topics
 * - Pulls/builds container images automatically
 * - Deploys services to Docker with proper networking
 * - Health monitoring and auto-restart
 * - Traefik label injection for automatic routing
 */
export class ServiceOrchestrator {
  private docker: Docker;
  private octokit: Octokit;
  private logger: Logger;
  private config: ServiceOrchestratorConfig;
  private discoveredServices: Map<string, DiscoveredService> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;

  // Topic patterns for service type detection
  private static readonly SERVICE_TOPICS = {
    validator: ['xorng-validator', 'validator'],
    knowledge: ['xorng-knowledge', 'knowledge'],
    task: ['xorng-task', 'task'],
    core: ['xorng-core', 'core'],
  } as const;

  // Name patterns for service type detection (fallback)
  private static readonly NAME_PATTERNS = {
    validator: /^validator-/,
    knowledge: /^knowledge-/,
    task: /^task-/,
    core: /^core$/,
  } as const;

  constructor(config: ServiceOrchestratorConfig) {
    this.config = config;
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.octokit = new Octokit({ auth: config.githubToken });
    this.logger = pino({
      level: config.logLevel || 'info',
      name: 'service-orchestrator',
    });
  }

  /**
   * Start the orchestrator with periodic discovery
   */
  async start(pollIntervalMs: number = 5 * 60 * 1000): Promise<void> {
    this.logger.info('Starting service orchestrator');
    
    // Initial discovery and deployment
    await this.discoverAndDeploy();
    
    // Start polling for changes
    this.pollInterval = setInterval(async () => {
      try {
        await this.discoverAndDeploy();
      } catch (error) {
        this.logger.error({ error }, 'Error in discovery poll');
      }
    }, pollIntervalMs);
    
    this.logger.info({ pollIntervalMs }, 'Service orchestrator started');
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.logger.info('Service orchestrator stopped');
  }

  /**
   * Discover services from GitHub and deploy new/updated ones
   */
  async discoverAndDeploy(): Promise<void> {
    this.logger.info('Starting service discovery...');
    
    try {
      const services = await this.discoverServices();
      const running = await this.getRunningServices();
      
      for (const service of services) {
        const isRunning = running.some(r => r.name === `xorng-${service.name}`);
        
        if (!isRunning && this.config.autoDeployEnabled) {
          this.logger.info({ service: service.name }, 'Deploying new service');
          try {
            await this.deployService(service);
          } catch (deployError) {
            // Log but continue with other services
            this.logger.error({ error: deployError, service: service.name }, 'Failed to deploy service, continuing...');
          }
        }
      }
      
      this.logger.info({ discovered: services.length, running: running.length }, 'Discovery complete');
    } catch (error) {
      this.logger.error({ error }, 'Error during service discovery');
      throw error;
    }
  }

  /**
   * Discover deployable services from GitHub organization
   */
  async discoverServices(): Promise<DiscoveredService[]> {
    const services: DiscoveredService[] = [];
    let page = 1;

    while (true) {
      const { data: repos } = await this.octokit.repos.listForOrg({
        org: this.config.organization,
        type: 'all',
        per_page: 100,
        page,
      });

      if (repos.length === 0) break;

      for (const repo of repos) {
        // Skip archived repos
        if (repo.archived) continue;

        // Determine service type
        const type = this.detectServiceType(repo.name, repo.topics || []);
        if (type === 'unknown') continue;

        // Skip template repos
        if (repo.name.startsWith('template-')) continue;

        // Check for Dockerfile
        const hasDockerfile = await this.repoHasDockerfile(repo.owner.login, repo.name);
        if (!hasDockerfile) continue;

        const service: DiscoveredService = {
          name: repo.name,
          repoName: repo.name,
          fullName: repo.full_name,
          type,
          hasDockerfile,
          imageName: `${this.config.registryUrl}/${this.config.organization.toLowerCase()}/xorng-${repo.name}`,
          imageTag: 'latest',
          topics: repo.topics || [],
          updatedAt: repo.updated_at || new Date().toISOString(),
        };

        services.push(service);
        this.discoveredServices.set(repo.name, service);
      }

      page++;
    }

    return services;
  }

  /**
   * Detect service type from repo name and topics
   */
  private detectServiceType(name: string, topics: string[]): DiscoveredService['type'] {
    // Check topics first
    for (const [type, patterns] of Object.entries(ServiceOrchestrator.SERVICE_TOPICS)) {
      if (patterns.some(p => topics.includes(p))) {
        return type as DiscoveredService['type'];
      }
    }

    // Fallback to name patterns
    for (const [type, pattern] of Object.entries(ServiceOrchestrator.NAME_PATTERNS)) {
      if (pattern.test(name)) {
        return type as DiscoveredService['type'];
      }
    }

    return 'unknown';
  }

  /**
   * Check if repo has a Dockerfile
   */
  private async repoHasDockerfile(owner: string, repo: string): Promise<boolean> {
    try {
      await this.octokit.repos.getContent({
        owner,
        repo,
        path: 'Dockerfile',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get currently running XORNG services
   */
  async getRunningServices(): Promise<RunningService[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        name: ['xorng-'],
      },
    });

    return containers.map(c => ({
      containerId: c.Id,
      name: c.Names[0]?.replace(/^\//, '') || '',
      image: c.Image,
      status: c.Status,
      state: c.State,
      createdAt: new Date(c.Created * 1000).toISOString(),
    }));
  }

  /**
   * Deploy a discovered service
   */
  async deployService(service: DiscoveredService): Promise<void> {
    const containerName = `xorng-${service.name}`;
    
    try {
      // Pull the image
      this.logger.info({ image: service.imageName }, 'Pulling image');
      await this.pullImage(service.imageName, service.imageTag);

      // Create and start container
      const container = await this.docker.createContainer({
        name: containerName,
        Image: `${service.imageName}:${service.imageTag}`,
        Env: [
          `LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}`,
          `REDIS_URL=redis://xorng-redis:6379`,
        ],
        Labels: {
          'xorng.service': 'true',
          'xorng.type': service.type,
          'xorng.repo': service.fullName,
          // Traefik labels for automatic routing (if service exposes HTTP)
          'traefik.enable': 'false', // Disabled by default, enable per-service if needed
        },
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          NetworkMode: this.config.networkName,
        },
      });

      await container.start();
      this.logger.info({ service: service.name, containerId: container.id }, 'Service deployed');
    } catch (error) {
      this.logger.error({ error, service: service.name }, 'Failed to deploy service');
      throw error;
    }
  }

  /**
   * Pull an image from registry
   */
  private async pullImage(imageName: string, tag: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const authconfig = this.config.registryPassword
        ? {
            username: this.config.registryUsername,
            password: this.config.registryPassword,
            serveraddress: this.config.registryUrl,
          }
        : undefined;

      this.docker.pull(`${imageName}:${tag}`, { authconfig }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        if (!stream) {
          resolve();
          return;
        }

        this.docker.modem.followProgress(stream, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /**
   * Stop and remove a service
   */
  async removeService(serviceName: string): Promise<void> {
    const containerName = `xorng-${serviceName}`;
    
    try {
      const container = this.docker.getContainer(containerName);
      await container.stop();
      await container.remove();
      this.logger.info({ service: serviceName }, 'Service removed');
    } catch (error) {
      this.logger.error({ error, service: serviceName }, 'Failed to remove service');
      throw error;
    }
  }

  /**
   * Restart a service
   */
  async restartService(serviceName: string): Promise<void> {
    const containerName = `xorng-${serviceName}`;
    
    try {
      const container = this.docker.getContainer(containerName);
      await container.restart();
      this.logger.info({ service: serviceName }, 'Service restarted');
    } catch (error) {
      this.logger.error({ error, service: serviceName }, 'Failed to restart service');
      throw error;
    }
  }

  /**
   * Get status of all services
   */
  async getStatus(): Promise<{
    discovered: DiscoveredService[];
    running: RunningService[];
    pending: DiscoveredService[];
  }> {
    const discovered = Array.from(this.discoveredServices.values());
    const running = await this.getRunningServices();
    const runningNames = new Set(running.map(r => r.name.replace('xorng-', '')));
    const pending = discovered.filter(d => !runningNames.has(d.name));

    return { discovered, running, pending };
  }

  /**
   * Force redeploy of a specific service
   */
  async redeployService(serviceName: string): Promise<void> {
    const service = this.discoveredServices.get(serviceName);
    if (!service) {
      throw new Error(`Service ${serviceName} not found`);
    }

    // Stop existing container if running
    try {
      await this.removeService(serviceName);
    } catch {
      // Ignore if not running
    }

    // Deploy fresh
    await this.deployService(service);
  }

  /**
   * Sync services - deploy missing, remove orphaned
   */
  async syncServices(removeOrphans: boolean = false): Promise<void> {
    const { discovered, running, pending } = await this.getStatus();

    // Deploy pending services
    for (const service of pending) {
      this.logger.info({ service: service.name }, 'Deploying pending service');
      await this.deployService(service);
    }

    // Optionally remove orphaned containers
    if (removeOrphans) {
      const discoveredNames = new Set(discovered.map(d => `xorng-${d.name}`));
      for (const container of running) {
        if (!discoveredNames.has(container.name) && container.name !== 'xorng-automation' && container.name !== 'xorng-redis') {
          this.logger.info({ container: container.name }, 'Removing orphaned container');
          await this.removeService(container.name.replace('xorng-', ''));
        }
      }
    }
  }
}
