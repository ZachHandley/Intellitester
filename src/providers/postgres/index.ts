import type { CleanupProvider, CleanupHandler, CleanupUntrackedOptions, CleanupUntrackedResult } from '../../core/cleanup/types.js';
import type { TrackedResource } from '../../integration/index.js';

interface PostgresConfig {
  connectionString: string;
}

export function createPostgresProvider(config: PostgresConfig): CleanupProvider {
  // Client will be lazily initialized in configure()
  let client: any = null;

  const methods: Record<string, CleanupHandler> = {
    deleteRow: async (resource: TrackedResource) => {
      if (!client) {
        throw new Error('Postgres client not initialized. Call configure() first.');
      }

      const schema = (resource.schema as string) || 'public';
      const table = resource.table as string;

      if (!table) {
        throw new Error(`Missing table name for row ${resource.id}`);
      }

      // Use parameterized query to prevent SQL injection
      await client.query(
        `DELETE FROM "${schema}"."${table}" WHERE id = $1`,
        [resource.id]
      );
    },

    deleteUser: async (resource: TrackedResource) => {
      if (!client) {
        throw new Error('Postgres client not initialized. Call configure() first.');
      }

      const table = (resource.table as string) || 'users';
      const schema = (resource.schema as string) || 'public';

      await client.query(
        `DELETE FROM "${schema}"."${table}" WHERE id = $1`,
        [resource.id]
      );
    },

    customDelete: async (resource: TrackedResource) => {
      if (!client) {
        throw new Error('Postgres client not initialized. Call configure() first.');
      }

      // Allow custom SQL queries via the query property
      const query = resource.query as string;
      const params = (resource.params as any[]) || [resource.id];

      if (!query) {
        throw new Error(`Missing query for custom delete of resource ${resource.id}`);
      }

      await client.query(query, params);
    },
  };

  async function cleanupUntracked(options: CleanupUntrackedOptions): Promise<CleanupUntrackedResult> {
    if (!client) {
      throw new Error('Postgres client not initialized. Call configure() first.');
    }

    const { testStartTime, userId } = options;
    const deleted: string[] = [];
    const failed: string[] = [];
    let scanned = 0;

    // 1. Get all tables in public schema
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '_intellitester%'
    `);

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;
      scanned++;

      // 2. Check if table has created_at and user_id columns
      const columnsResult = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = $1
      `, [tableName]);

      const columns: string[] = columnsResult.rows.map((r: { column_name: string }) => r.column_name);
      const hasCreatedAt = columns.some(c => ['created_at', 'createdat', 'created'].includes(c.toLowerCase()));
      const userIdColumn = columns.find(c => ['user_id', 'userid', 'owner_id', 'author_id'].includes(c.toLowerCase()));

      if (!hasCreatedAt) continue;

      // 3. Build and execute delete query
      let deleteQuery = `DELETE FROM "${tableName}" WHERE `;
      const conditions: string[] = [];
      const params: (string | undefined)[] = [];

      // Add created_at condition
      const createdAtCol = columns.find(c => ['created_at', 'createdat', 'created'].includes(c.toLowerCase()));
      if (createdAtCol) {
        conditions.push(`"${createdAtCol}" >= $${params.length + 1}`);
        params.push(testStartTime);
      }

      // Add user_id condition if available
      if (userId && userIdColumn) {
        conditions.push(`"${userIdColumn}" = $${params.length + 1}`);
        params.push(userId);
      }

      if (conditions.length === 0) continue;

      deleteQuery += conditions.join(' AND ') + ' RETURNING id';

      try {
        const result = await client.query(deleteQuery, params);
        for (const deletedRow of result.rows) {
          deleted.push(`${tableName}:${deletedRow.id}`);
        }
      } catch (error) {
        failed.push(`${tableName}:error`);
      }
    }

    return {
      success: failed.length === 0,
      scanned,
      deleted,
      failed,
    };
  }

  return {
    name: 'postgres',
    async configure() {
      try {
        // Dynamic import since pg is an optional dependency
        // @ts-ignore - pg is an optional peer dependency
        const pg = await import('pg');
        const Client = pg.Client || pg.default?.Client;
        client = new Client({ connectionString: config.connectionString });
        await client.connect();
      } catch (error) {
        throw new Error(
          'Failed to initialize Postgres client. Make sure the "pg" package is installed: npm install pg'
        );
      }
    },
    methods,
    cleanupUntracked,
  };
}

// Default type mappings for Postgres resources
export const postgresTypeMappings: Record<string, string> = {
  row: 'postgres.deleteRow',
  user: 'postgres.deleteUser',
  custom: 'postgres.customDelete',
};
