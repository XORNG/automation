import { pino, type Logger } from 'pino';
import { DockerOrchestrator, type ContainerConfig, type ContainerStatus } from '../docker/orchestrator.js';
import type { FleetConfig, SubAgentManifest } from '../config/manifest.js';

/**
 * Fleet status
 */
export interface FleetStatus {
  name: string;
  totalAgents: number;
  running: number;
  stopped: number;
  agents: Array<{
    name: string;
    type: SubAgentManifest['type'];
    status: ContainerStatus['state'];
    container?: ContainerStatus;
  }>;
}

/**
 * Fleet manager for orchestrating sub-agent containers
 */
export class FleetManager {
  private docker: DockerOrchestrator;
  private logger: Logger;
  private config: FleetConfig;

  constructor(config: FleetConfig, options?: { logLevel?: string }) {
    this.config = config;
    this.docker = new DockerOrchestrator({
      networkName: config.settings?.network,
      logLevel: options?.logLevel,
    });
    this.logger = pino({
      level: options?.logLevel || 'info',
      name: 'fleet-manager',
    });
  }

  /**
   * Initialize the fleet manager
   */
  async initialize(): Promise<void> {
    await this.docker.initialize();
    this.logger.info({ fleet: this.config.name }, 'Fleet manager initialized');
  }

  /**
   * Start all sub-agents in the fleet
   */
  async startAll(): Promise<void> {
    this.logger.info({ fleet: this.config.name }, 'Starting fleet');

    for (const agent of this.config.agents) {
      await this.startAgent(agent);
    }

    this.logger.info({ fleet: this.config.name }, 'Fleet started');
  }

  /**
   * Stop all sub-agents in the fleet
   */
  async stopAll(): Promise<void> {
    this.logger.info({ fleet: this.config.name }, 'Stopping fleet');

    for (const agent of this.config.agents) {
      await this.stopAgent(agent.name);
    }

    this.logger.info({ fleet: this.config.name }, 'Fleet stopped');
  }

  /**
   * Start a single sub-agent
   */
  async startAgent(agent: SubAgentManifest): Promise<string> {
    const containerName = `xorng-${agent.name}`;
    this.logger.info({ agent: agent.name }, 'Starting agent');

    // Build image if needed
    if (agent.docker.build) {
      await this.docker.buildImage(
        agent.docker.build.context,
        `xorng/${agent.name}:${agent.version}`,
        { dockerfile: agent.docker.build.dockerfile }
      );
    }

    // Prepare container config
    const containerConfig: ContainerConfig = {
      name: containerName,
      image: agent.docker.image || `xorng/${agent.name}:${agent.version}`,
      ports: agent.docker.ports,
      environment: {
        ...agent.docker.environment,
        LOG_LEVEL: this.config.settings?.logLevel || 'info',
      },
      volumes: agent.docker.volumes,
      network: this.config.settings?.network,
      labels: {
        'xorng.agent.name': agent.name,
        'xorng.agent.type': agent.type,
        'xorng.agent.version': agent.version,
      },
    };

    return this.docker.startContainer(containerConfig);
  }

  /**
   * Stop a single sub-agent
   */
  async stopAgent(name: string): Promise<void> {
    const containerName = `xorng-${name}`;
    await this.docker.stopContainer(containerName);
  }

  /**
   * Restart a sub-agent
   */
  async restartAgent(name: string): Promise<void> {
    const agent = this.config.agents.find(a => a.name === name);
    if (!agent) {
      throw new Error(`Agent '${name}' not found in fleet config`);
    }

    await this.stopAgent(name);
    await this.startAgent(agent);
  }

  /**
   * Get fleet status
   */
  async getStatus(): Promise<FleetStatus> {
    const containers = await this.docker.listContainers();
    const agentStatuses: FleetStatus['agents'] = [];

    let running = 0;
    let stopped = 0;

    for (const agent of this.config.agents) {
      const containerName = `xorng-${agent.name}`;
      const container = containers.find(c => c.name === containerName);

      const status = container?.state || 'stopped';
      if (status === 'running') running++;
      else stopped++;

      agentStatuses.push({
        name: agent.name,
        type: agent.type,
        status,
        container: container || undefined,
      });
    }

    return {
      name: this.config.name,
      totalAgents: this.config.agents.length,
      running,
      stopped,
      agents: agentStatuses,
    };
  }

  /**
   * Get logs for a sub-agent
   */
  async getAgentLogs(name: string, options?: { tail?: number }): Promise<string> {
    const containerName = `xorng-${name}`;
    return this.docker.getLogs(containerName, options);
  }

  /**
   * Scale a sub-agent (create replicas)
   */
  async scaleAgent(name: string, replicas: number): Promise<void> {
    const agent = this.config.agents.find(a => a.name === name);
    if (!agent) {
      throw new Error(`Agent '${name}' not found in fleet config`);
    }

    // For now, just log - actual scaling would require more complex orchestration
    this.logger.info({ agent: name, replicas }, 'Scaling not yet implemented');
  }
}
