import { z } from 'zod';

/**
 * Sub-agent manifest schema
 */
export const SubAgentManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  type: z.enum(['validator', 'knowledge', 'task', 'custom']),
  
  // Docker configuration
  docker: z.object({
    image: z.string().optional(),
    build: z.object({
      context: z.string(),
      dockerfile: z.string().optional(),
    }).optional(),
    ports: z.record(z.string()).optional(),
    volumes: z.array(z.string()).optional(),
    environment: z.record(z.string()).optional(),
  }),

  // MCP configuration
  mcp: z.object({
    transport: z.enum(['stdio', 'http']).default('stdio'),
    endpoint: z.string().optional(),
    tools: z.array(z.string()).optional(),
  }),

  // Resource requirements
  resources: z.object({
    memory: z.string().optional(),
    cpu: z.string().optional(),
  }).optional(),

  // Dependencies
  dependencies: z.array(z.string()).optional(),
});

export type SubAgentManifest = z.infer<typeof SubAgentManifestSchema>;

/**
 * Fleet configuration schema
 */
export const FleetConfigSchema = z.object({
  version: z.string(),
  name: z.string(),
  
  // Global settings
  settings: z.object({
    network: z.string().default('xorng-network'),
    logLevel: z.string().default('info'),
    redis: z.object({
      host: z.string().default('redis'),
      port: z.number().default(6379),
    }).optional(),
  }).optional(),

  // Sub-agent fleet
  agents: z.array(SubAgentManifestSchema),
});

export type FleetConfig = z.infer<typeof FleetConfigSchema>;
