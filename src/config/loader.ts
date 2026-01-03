import { parse } from 'yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FleetConfigSchema, type FleetConfig, type SubAgentManifest } from './manifest.js';

/**
 * Load a fleet configuration from a YAML file
 */
export async function loadFleetConfig(filePath: string): Promise<FleetConfig> {
  const content = await fs.readFile(filePath, 'utf-8');
  const data = parse(content);
  return FleetConfigSchema.parse(data);
}

/**
 * Load a sub-agent manifest from a directory
 */
export async function loadSubAgentManifest(dir: string): Promise<SubAgentManifest | null> {
  const manifestPath = path.join(dir, 'xorng.yml');
  
  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const data = parse(content);
    return data as SubAgentManifest;
  } catch (error) {
    return null;
  }
}

/**
 * Discover all sub-agents in a directory
 */
export async function discoverSubAgents(rootDir: string): Promise<SubAgentManifest[]> {
  const manifests: SubAgentManifest[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    // Look for validator-*, knowledge-*, task-* directories
    if (
      entry.name.startsWith('validator-') ||
      entry.name.startsWith('knowledge-') ||
      entry.name.startsWith('task-')
    ) {
      const manifest = await loadSubAgentManifest(path.join(rootDir, entry.name));
      if (manifest) {
        manifests.push(manifest);
      }
    }
  }

  return manifests;
}

/**
 * Generate a fleet config from discovered sub-agents
 */
export async function generateFleetConfig(
  rootDir: string,
  name: string = 'xorng'
): Promise<FleetConfig> {
  const agents = await discoverSubAgents(rootDir);

  return {
    version: '1.0.0',
    name,
    settings: {
      network: 'xorng-network',
      logLevel: 'info',
    },
    agents,
  };
}
