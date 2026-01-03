#!/usr/bin/env node

import { Command } from 'commander';
import { pino } from 'pino';
import { FleetManager } from './fleet/manager.js';
import { loadFleetConfig, generateFleetConfig, discoverSubAgents } from './config/loader.js';
import { DockerOrchestrator } from './docker/orchestrator.js';

const logger = pino({ name: 'xorng-cli' });

const program = new Command();

program
  .name('xorng')
  .description('XORNG Framework CLI')
  .version('0.1.0');

// Fleet commands
const fleet = program.command('fleet').description('Manage sub-agent fleet');

fleet
  .command('start')
  .description('Start all sub-agents')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (options) => {
    try {
      const config = await loadFleetConfig(options.config);
      const manager = new FleetManager(config);
      await manager.initialize();
      await manager.startAll();
      console.log('Fleet started successfully');
    } catch (error) {
      logger.error(error, 'Failed to start fleet');
      process.exit(1);
    }
  });

fleet
  .command('stop')
  .description('Stop all sub-agents')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (options) => {
    try {
      const config = await loadFleetConfig(options.config);
      const manager = new FleetManager(config);
      await manager.initialize();
      await manager.stopAll();
      console.log('Fleet stopped successfully');
    } catch (error) {
      logger.error(error, 'Failed to stop fleet');
      process.exit(1);
    }
  });

fleet
  .command('status')
  .description('Show fleet status')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (options) => {
    try {
      const config = await loadFleetConfig(options.config);
      const manager = new FleetManager(config);
      await manager.initialize();
      const status = await manager.getStatus();

      console.log(`\nFleet: ${status.name}`);
      console.log(`Total: ${status.totalAgents} | Running: ${status.running} | Stopped: ${status.stopped}\n`);
      
      console.log('Agents:');
      for (const agent of status.agents) {
        const icon = agent.status === 'running' ? '✓' : '✗';
        console.log(`  ${icon} ${agent.name} (${agent.type}) - ${agent.status}`);
      }
    } catch (error) {
      logger.error(error, 'Failed to get status');
      process.exit(1);
    }
  });

fleet
  .command('logs <agent>')
  .description('Show logs for a sub-agent')
  .option('-n, --tail <lines>', 'Number of lines', '100')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (agent, options) => {
    try {
      const config = await loadFleetConfig(options.config);
      const manager = new FleetManager(config);
      await manager.initialize();
      const logs = await manager.getAgentLogs(agent, { tail: parseInt(options.tail) });
      console.log(logs);
    } catch (error) {
      logger.error(error, 'Failed to get logs');
      process.exit(1);
    }
  });

// Agent commands
const agent = program.command('agent').description('Manage individual sub-agents');

agent
  .command('start <name>')
  .description('Start a single sub-agent')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (name, options) => {
    try {
      const config = await loadFleetConfig(options.config);
      const agentConfig = config.agents.find(a => a.name === name);
      if (!agentConfig) {
        console.error(`Agent '${name}' not found in config`);
        process.exit(1);
      }
      const manager = new FleetManager(config);
      await manager.initialize();
      await manager.startAgent(agentConfig);
      console.log(`Agent '${name}' started`);
    } catch (error) {
      logger.error(error, 'Failed to start agent');
      process.exit(1);
    }
  });

agent
  .command('stop <name>')
  .description('Stop a single sub-agent')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (name, options) => {
    try {
      const config = await loadFleetConfig(options.config);
      const manager = new FleetManager(config);
      await manager.initialize();
      await manager.stopAgent(name);
      console.log(`Agent '${name}' stopped`);
    } catch (error) {
      logger.error(error, 'Failed to stop agent');
      process.exit(1);
    }
  });

agent
  .command('restart <name>')
  .description('Restart a single sub-agent')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (name, options) => {
    try {
      const config = await loadFleetConfig(options.config);
      const manager = new FleetManager(config);
      await manager.initialize();
      await manager.restartAgent(name);
      console.log(`Agent '${name}' restarted`);
    } catch (error) {
      logger.error(error, 'Failed to restart agent');
      process.exit(1);
    }
  });

// Config commands
const config = program.command('config').description('Configuration management');

config
  .command('discover')
  .description('Discover sub-agents in the workspace')
  .option('-d, --dir <path>', 'Root directory', '.')
  .action(async (options) => {
    try {
      const agents = await discoverSubAgents(options.dir);
      console.log(`\nDiscovered ${agents.length} sub-agents:\n`);
      for (const agent of agents) {
        console.log(`  - ${agent.name} (${agent.type})`);
      }
    } catch (error) {
      logger.error(error, 'Failed to discover agents');
      process.exit(1);
    }
  });

config
  .command('generate')
  .description('Generate a fleet config from discovered agents')
  .option('-d, --dir <path>', 'Root directory', '.')
  .option('-n, --name <name>', 'Fleet name', 'xorng')
  .action(async (options) => {
    try {
      const fleetConfig = await generateFleetConfig(options.dir, options.name);
      console.log(JSON.stringify(fleetConfig, null, 2));
    } catch (error) {
      logger.error(error, 'Failed to generate config');
      process.exit(1);
    }
  });

// Docker commands
const docker = program.command('docker').description('Docker management');

docker
  .command('build')
  .description('Build all sub-agent images')
  .option('-c, --config <path>', 'Fleet config file', 'fleet.yml')
  .action(async (options) => {
    try {
      const fleetConfig = await loadFleetConfig(options.config);
      const orchestrator = new DockerOrchestrator();

      for (const agent of fleetConfig.agents) {
        if (agent.docker.build) {
          console.log(`Building ${agent.name}...`);
          await orchestrator.buildImage(
            agent.docker.build.context,
            `xorng/${agent.name}:${agent.version}`,
            { dockerfile: agent.docker.build.dockerfile }
          );
          console.log(`Built xorng/${agent.name}:${agent.version}`);
        }
      }

      console.log('\nAll images built successfully');
    } catch (error) {
      logger.error(error, 'Failed to build images');
      process.exit(1);
    }
  });

program.parse();
