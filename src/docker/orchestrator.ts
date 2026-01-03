import Docker from 'dockerode';
import { pino, type Logger } from 'pino';
import { z } from 'zod';

/**
 * Container configuration
 */
export interface ContainerConfig {
  name: string;
  image: string;
  ports?: Record<string, string>;
  environment?: Record<string, string>;
  volumes?: string[];
  network?: string;
  labels?: Record<string, string>;
}

/**
 * Container status
 */
export interface ContainerStatus {
  id: string;
  name: string;
  state: 'running' | 'stopped' | 'paused' | 'exited' | 'dead' | 'unknown';
  image: string;
  created: Date;
  ports?: Array<{ host: number; container: number }>;
}

/**
 * Docker orchestrator for managing sub-agent containers
 */
export class DockerOrchestrator {
  private docker: Docker;
  private logger: Logger;
  private networkName: string;

  constructor(options?: {
    socketPath?: string;
    networkName?: string;
    logLevel?: string;
  }) {
    this.docker = new Docker({
      socketPath: options?.socketPath || '/var/run/docker.sock',
    });
    this.networkName = options?.networkName || 'xorng-network';
    this.logger = pino({
      level: options?.logLevel || 'info',
      name: 'docker-orchestrator',
    });
  }

  /**
   * Initialize the orchestrator
   */
  async initialize(): Promise<void> {
    // Ensure network exists
    await this.ensureNetwork();
    this.logger.info('Docker orchestrator initialized');
  }

  /**
   * Ensure the XORNG network exists
   */
  private async ensureNetwork(): Promise<void> {
    const networks = await this.docker.listNetworks({
      filters: { name: [this.networkName] },
    });

    if (networks.length === 0) {
      await this.docker.createNetwork({
        Name: this.networkName,
        Driver: 'bridge',
      });
      this.logger.info({ network: this.networkName }, 'Created network');
    }
  }

  /**
   * Start a sub-agent container
   */
  async startContainer(config: ContainerConfig): Promise<string> {
    this.logger.info({ name: config.name }, 'Starting container');

    // Check if container already exists
    const existing = await this.getContainer(config.name);
    if (existing) {
      const state = existing.state;
      if (state === 'running') {
        this.logger.info({ name: config.name }, 'Container already running');
        return existing.id;
      }
      // Remove stopped container
      await this.removeContainer(config.name);
    }

    // Build port bindings
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, object> = {};

    if (config.ports) {
      for (const [container, host] of Object.entries(config.ports)) {
        exposedPorts[`${container}/tcp`] = {};
        portBindings[`${container}/tcp`] = [{ HostPort: host }];
      }
    }

    // Create container
    const container = await this.docker.createContainer({
      name: config.name,
      Image: config.image,
      Env: config.environment
        ? Object.entries(config.environment).map(([k, v]) => `${k}=${v}`)
        : undefined,
      Labels: {
        'xorng.managed': 'true',
        ...config.labels,
      },
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds: config.volumes,
        NetworkMode: config.network || this.networkName,
      },
    });

    await container.start();
    this.logger.info({ name: config.name, id: container.id }, 'Container started');

    return container.id;
  }

  /**
   * Stop a container
   */
  async stopContainer(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      await container.stop();
      this.logger.info({ name }, 'Container stopped');
    } catch (error: any) {
      if (error.statusCode !== 304) { // Not modified = already stopped
        throw error;
      }
    }
  }

  /**
   * Remove a container
   */
  async removeContainer(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      await container.remove({ force: true });
      this.logger.info({ name }, 'Container removed');
    } catch (error: any) {
      if (error.statusCode !== 404) {
        throw error;
      }
    }
  }

  /**
   * Get container status
   */
  async getContainer(name: string): Promise<ContainerStatus | null> {
    try {
      const container = this.docker.getContainer(name);
      const info = await container.inspect();

      return {
        id: info.Id,
        name: info.Name.replace(/^\//, ''),
        state: this.mapState(info.State.Status),
        image: info.Config.Image,
        created: new Date(info.Created),
        ports: info.NetworkSettings.Ports
          ? Object.entries(info.NetworkSettings.Ports)
              .filter(([_, bindings]) => bindings)
              .map(([port, bindings]) => ({
                container: parseInt(port.split('/')[0]),
                host: parseInt(bindings![0].HostPort),
              }))
          : undefined,
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all XORNG managed containers
   */
  async listContainers(): Promise<ContainerStatus[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: ['xorng.managed=true'],
      },
    });

    return containers.map((c) => ({
      id: c.Id,
      name: c.Names[0].replace(/^\//, ''),
      state: this.mapState(c.State),
      image: c.Image,
      created: new Date(c.Created * 1000),
      ports: c.Ports.map((p) => ({
        container: p.PrivatePort,
        host: p.PublicPort,
      })),
    }));
  }

  /**
   * Get container logs
   */
  async getLogs(name: string, options?: {
    tail?: number;
    since?: Date;
  }): Promise<string> {
    const container = this.docker.getContainer(name);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: options?.tail || 100,
      since: options?.since ? Math.floor(options.since.getTime() / 1000) : undefined,
    });

    return logs.toString();
  }

  /**
   * Build an image from a Dockerfile
   */
  async buildImage(
    contextPath: string,
    tag: string,
    options?: { dockerfile?: string }
  ): Promise<void> {
    this.logger.info({ tag, context: contextPath }, 'Building image');

    const stream = await this.docker.buildImage(
      {
        context: contextPath,
        src: ['.'],
      },
      {
        t: tag,
        dockerfile: options?.dockerfile || 'Dockerfile',
      }
    );

    // Wait for build to complete
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err, res) => {
          if (err) reject(err);
          else resolve();
        },
        (event) => {
          if (event.stream) {
            this.logger.debug({ build: tag }, event.stream.trim());
          }
        }
      );
    });

    this.logger.info({ tag }, 'Image built');
  }

  /**
   * Pull an image
   */
  async pullImage(image: string): Promise<void> {
    this.logger.info({ image }, 'Pulling image');

    const stream = await this.docker.pull(image);

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.logger.info({ image }, 'Image pulled');
  }

  /**
   * Map Docker state string to ContainerStatus state
   */
  private mapState(state: string): ContainerStatus['state'] {
    switch (state.toLowerCase()) {
      case 'running':
        return 'running';
      case 'paused':
        return 'paused';
      case 'exited':
        return 'exited';
      case 'dead':
        return 'dead';
      case 'created':
      case 'restarting':
        return 'stopped';
      default:
        return 'unknown';
    }
  }
}
