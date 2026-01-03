# XORNG Automation

Automation and orchestration tools for the XORNG Framework.

## Overview

The automation package provides:

- **Docker Orchestrator** - Manage sub-agent containers
- **Fleet Manager** - Orchestrate multiple sub-agents
- **CLI Tool** - Command-line interface for management
- **Scripts** - Setup and build automation

## Installation

```bash
npm install
npm run build
```

## CLI Usage

### Fleet Management

```bash
# Start all sub-agents
npm run start -- fleet start

# Stop all sub-agents
npm run start -- fleet stop

# View fleet status
npm run start -- fleet status

# View agent logs
npm run start -- fleet logs validator-code-review
```

### Agent Management

```bash
# Start a single agent
npm run start -- agent start validator-code-review

# Stop a single agent
npm run start -- agent stop validator-code-review

# Restart an agent
npm run start -- agent restart validator-code-review
```

### Configuration

```bash
# Discover sub-agents in workspace
npm run start -- config discover -d /path/to/xorng

# Generate fleet config
npm run start -- config generate -d /path/to/xorng
```

### Docker Operations

```bash
# Build all images
npm run start -- docker build

# Or use the shell script
./scripts/docker-build.sh
```

## Docker Compose

For local development:

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

## Fleet Configuration

Create a `fleet.yml` file:

```yaml
version: "1.0.0"
name: xorng-dev

settings:
  network: xorng-network
  logLevel: info
  redis:
    host: redis
    port: 6379

agents:
  - name: validator-code-review
    version: "0.1.0"
    type: validator
    docker:
      build:
        context: ../validator-code-review
      ports:
        "3001": "3001"
      environment:
        LOG_LEVEL: debug
    mcp:
      transport: stdio
      tools:
        - review-code
        - check-style
        - analyze-complexity

  - name: validator-security
    version: "0.1.0"
    type: validator
    docker:
      build:
        context: ../validator-security
    mcp:
      transport: stdio
```

## Sub-Agent Manifest

Each sub-agent can have an `xorng.yml` manifest:

```yaml
name: validator-code-review
version: "0.1.0"
description: Code review and quality analysis
type: validator

docker:
  build:
    context: .
    dockerfile: Dockerfile
  ports:
    "3001": "3001"
  environment:
    NODE_ENV: production

mcp:
  transport: stdio
  tools:
    - review-code
    - check-style
    - analyze-complexity

resources:
  memory: "512m"
  cpu: "0.5"
```

## Scripts

### setup.sh

Sets up the development environment:

```bash
./scripts/setup.sh
```

This will:
- Check prerequisites (Node.js, Docker)
- Install dependencies for all packages
- Build all packages
- Create `.env` files

### docker-build.sh

Builds Docker images:

```bash
# Build all
./scripts/docker-build.sh

# Build specific type
./scripts/docker-build.sh validators
./scripts/docker-build.sh knowledge

# Build specific agent
./scripts/docker-build.sh validator-code-review
```

## Programmatic Usage

```typescript
import { FleetManager, DockerOrchestrator, loadFleetConfig } from '@xorng/automation';

// Load config
const config = await loadFleetConfig('./fleet.yml');

// Create fleet manager
const fleet = new FleetManager(config);
await fleet.initialize();

// Start fleet
await fleet.startAll();

// Get status
const status = await fleet.getStatus();
console.log(status);

// Get logs
const logs = await fleet.getAgentLogs('validator-code-review', { tail: 100 });

// Stop fleet
await fleet.stopAll();
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   XORNG CLI                        │
├─────────────────────────────────────────────────────┤
│                Fleet Manager                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │
│  │  Start All  │ │  Stop All   │ │   Status    │  │
│  └─────────────┘ └─────────────┘ └─────────────┘  │
├─────────────────────────────────────────────────────┤
│              Docker Orchestrator                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │
│  │   Start     │ │    Stop     │ │    Build    │  │
│  │  Container  │ │  Container  │ │   Image     │  │
│  └─────────────┘ └─────────────┘ └─────────────┘  │
├─────────────────────────────────────────────────────┤
│                Docker Engine                        │
│  ┌─────────────────────────────────────────────┐   │
│  │              XORNG Network                   │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │   │
│  │  │ Redis   │ │Validator│ │Knowledge│       │   │
│  │  └─────────┘ └─────────┘ └─────────┘       │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## License

MIT
