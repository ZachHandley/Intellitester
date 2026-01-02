export { createAppwriteProvider, appwriteTypeMappings } from './appwrite/index.js';
export { createPostgresProvider, postgresTypeMappings } from './postgres/index.js';
export { createMysqlProvider, mysqlTypeMappings } from './mysql/index.js';
export { createSqliteProvider, sqliteTypeMappings } from './sqlite/index.js';

import type { CleanupProvider } from '../core/cleanup/types.js';

// Provider factory registry
// Using dynamic imports to avoid loading unnecessary dependencies
export const providerFactories: Record<string, (config: any) => CleanupProvider> = {
  appwrite: (config) => {
    const { createAppwriteProvider } = require('./appwrite/index.js');
    return createAppwriteProvider(config);
  },
  postgres: (config) => {
    const { createPostgresProvider } = require('./postgres/index.js');
    return createPostgresProvider(config);
  },
  mysql: (config) => {
    const { createMysqlProvider } = require('./mysql/index.js');
    return createMysqlProvider(config);
  },
  sqlite: (config) => {
    const { createSqliteProvider } = require('./sqlite/index.js');
    return createSqliteProvider(config);
  },
};

// Get default type mappings for a provider
export function getDefaultTypeMappings(provider: string): Record<string, string> {
  switch (provider) {
    case 'appwrite': {
      const { appwriteTypeMappings } = require('./appwrite/index.js');
      return appwriteTypeMappings;
    }
    case 'postgres': {
      const { postgresTypeMappings } = require('./postgres/index.js');
      return postgresTypeMappings;
    }
    case 'mysql': {
      const { mysqlTypeMappings } = require('./mysql/index.js');
      return mysqlTypeMappings;
    }
    case 'sqlite': {
      const { sqliteTypeMappings } = require('./sqlite/index.js');
      return sqliteTypeMappings;
    }
    default:
      return {};
  }
}

// Helper to check if a provider is available
export function isProviderAvailable(provider: string): boolean {
  return provider in providerFactories;
}

// Helper to list all available providers
export function listAvailableProviders(): string[] {
  return Object.keys(providerFactories);
}
