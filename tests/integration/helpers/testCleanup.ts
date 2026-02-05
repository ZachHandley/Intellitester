/**
 * Cleanup orchestration for E2E tests.
 */
import type { CleanupProvider, CleanupHandler, CleanupConfig } from '../../../src/core/cleanup/types.js';
import type { TrackedResource } from '../../../src/integration/index.js';
import type { TestDatabase } from './testDatabase.js';

export interface TestCleanupContext {
  /** The cleanup provider instance */
  provider: CleanupProvider;
  /** Map of handler names to handler functions */
  handlers: Map<string, CleanupHandler>;
  /** Map of resource types to handler method names */
  typeMappings: Record<string, string>;
  /** Run cleanup on tracked resources */
  runCleanup: (resources: TrackedResource[]) => Promise<CleanupResult>;
}

export interface CleanupResult {
  success: boolean;
  deleted: string[];
  failed: string[];
}

/**
 * Set up cleanup context for tests using SQLite.
 */
export async function setupTestCleanup(testDb: TestDatabase): Promise<TestCleanupContext> {
  // Dynamic import to avoid loading cleanup module early
  const { loadCleanupHandlers, executeCleanup } = await import('../../../src/core/cleanup/index.js');

  const config: CleanupConfig = {
    provider: 'sqlite',
    sqlite: {
      database: testDb.path,
    },
    parallel: false,
    retries: 1, // Fewer retries for tests
  };

  const { handlers, typeMappings, provider } = await loadCleanupHandlers(config);

  if (!provider) {
    throw new Error('Failed to initialize SQLite cleanup provider');
  }

  return {
    provider,
    handlers,
    typeMappings,
    runCleanup: async (resources: TrackedResource[]) => {
      return executeCleanup(resources, handlers, typeMappings, {
        config,
        provider,
        parallel: false,
        retries: 1,
      });
    },
  };
}

export interface MockCleanupProviderOptions {
  name?: string;
  shouldFail?: string[]; // IDs that should fail cleanup
  delay?: number; // Artificial delay in ms
}

/**
 * Create a mock cleanup provider for testing cleanup execution logic.
 */
export function createMockCleanupProvider(options?: MockCleanupProviderOptions): CleanupProvider {
  const { name = 'mock', shouldFail = [], delay = 0 } = options ?? {};
  const deletedIds: string[] = [];

  return {
    name,
    async configure() {
      // No-op for mock
    },
    methods: {
      deleteResource: async (resource: TrackedResource) => {
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (shouldFail.includes(resource.id)) {
          throw new Error(`Mock cleanup failed for ${resource.id}`);
        }
        deletedIds.push(resource.id);
      },
    },
    // Expose deleted IDs for assertions
    getDeletedIds: () => [...deletedIds],
  } as CleanupProvider & { getDeletedIds: () => string[] };
}

/**
 * Create default type mappings for test cleanup.
 */
export function getTestTypeMappings(): Record<string, string> {
  return {
    user: 'sqlite.deleteUser',
    row: 'sqlite.deleteRow',
    resource: 'sqlite.deleteRow',
    custom: 'sqlite.customDelete',
  };
}
