import { createAppwriteProvider, appwriteTypeMappings } from './appwrite/index.js';
import { createPostgresProvider, postgresTypeMappings } from './postgres/index.js';
import { createMysqlProvider, mysqlTypeMappings } from './mysql/index.js';
import { createSqliteProvider, sqliteTypeMappings } from './sqlite/index.js';
import type { CleanupProvider } from '../core/cleanup/types.js';

// Re-export for convenience
export { createAppwriteProvider, appwriteTypeMappings } from './appwrite/index.js';
export { createPostgresProvider, postgresTypeMappings } from './postgres/index.js';
export { createMysqlProvider, mysqlTypeMappings } from './mysql/index.js';
export { createSqliteProvider, sqliteTypeMappings } from './sqlite/index.js';

// Provider factory registry using static imports
export const providerFactories: Record<string, (config: any) => CleanupProvider> = {
  appwrite: (config) => createAppwriteProvider(config),
  postgres: (config) => createPostgresProvider(config),
  mysql: (config) => createMysqlProvider(config),
  sqlite: (config) => createSqliteProvider(config),
};

// Default type mappings for each provider
const typeMappingsRegistry: Record<string, Record<string, string>> = {
  appwrite: appwriteTypeMappings,
  postgres: postgresTypeMappings,
  mysql: mysqlTypeMappings,
  sqlite: sqliteTypeMappings,
};

// Get default type mappings for a provider
export function getDefaultTypeMappings(provider: string): Record<string, string> {
  return typeMappingsRegistry[provider] ?? {};
}

// Helper to check if a provider is available
export function isProviderAvailable(provider: string): boolean {
  return provider in providerFactories;
}

// Helper to list all available providers
export function listAvailableProviders(): string[] {
  return Object.keys(providerFactories);
}
