import type { CleanupProvider, CleanupHandler } from '../../core/cleanup/types.js';
import type { TrackedResource } from '../../integration/index.js';

interface SqliteConfig {
  database: string; // Path to the SQLite database file
  readonly?: boolean;
}

export function createSqliteProvider(config: SqliteConfig): CleanupProvider {
  // Database will be lazily initialized in configure()
  let db: any = null;

  const methods: Record<string, CleanupHandler> = {
    deleteRow: async (resource: TrackedResource) => {
      if (!db) {
        throw new Error('SQLite database not initialized. Call configure() first.');
      }

      const table = resource.table as string;

      if (!table) {
        throw new Error(`Missing table name for row ${resource.id}`);
      }

      // Use parameterized query to prevent SQL injection
      const stmt = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      stmt.run(resource.id);
    },

    deleteUser: async (resource: TrackedResource) => {
      if (!db) {
        throw new Error('SQLite database not initialized. Call configure() first.');
      }

      const table = (resource.table as string) || 'users';

      const stmt = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      stmt.run(resource.id);
    },

    customDelete: async (resource: TrackedResource) => {
      if (!db) {
        throw new Error('SQLite database not initialized. Call configure() first.');
      }

      // Allow custom SQL queries via the query property
      const query = resource.query as string;
      const params = (resource.params as any[]) || [resource.id];

      if (!query) {
        throw new Error(`Missing query for custom delete of resource ${resource.id}`);
      }

      const stmt = db.prepare(query);
      stmt.run(...params);
    },
  };

  return {
    name: 'sqlite',
    async configure() {
      try {
        // Dynamic import since better-sqlite3 is an optional dependency
        const DatabaseModule = await import('better-sqlite3');
        const Database = DatabaseModule.default || DatabaseModule;
        db = new Database(config.database, {
          readonly: config.readonly || false,
        });
      } catch {
        throw new Error(
          'Failed to initialize SQLite database. Make sure the "better-sqlite3" package is installed: npm install better-sqlite3'
        );
      }
    },
    methods,
  };
}

// Default type mappings for SQLite resources
export const sqliteTypeMappings: Record<string, string> = {
  row: 'sqlite.deleteRow',
  user: 'sqlite.deleteUser',
  custom: 'sqlite.customDelete',
};
