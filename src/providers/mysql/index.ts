import type { CleanupProvider, CleanupHandler, CleanupUntrackedOptions, CleanupUntrackedResult } from '../../core/cleanup/types.js';
import type { TrackedResource } from '../../integration/index.js';

interface MysqlConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
}

export function createMysqlProvider(config: MysqlConfig): CleanupProvider {
  // Connection will be lazily initialized in configure()
  let connection: any = null;

  const methods: Record<string, CleanupHandler> = {
    deleteRow: async (resource: TrackedResource) => {
      if (!connection) {
        throw new Error('MySQL connection not initialized. Call configure() first.');
      }

      const table = resource.table as string;
      const database = (resource.database as string) || config.database;

      if (!table) {
        throw new Error(`Missing table name for row ${resource.id}`);
      }

      // Use parameterized query to prevent SQL injection
      await connection.execute(
        `DELETE FROM \`${database}\`.\`${table}\` WHERE id = ?`,
        [resource.id]
      );
    },

    deleteUser: async (resource: TrackedResource) => {
      if (!connection) {
        throw new Error('MySQL connection not initialized. Call configure() first.');
      }

      const table = (resource.table as string) || 'users';
      const database = (resource.database as string) || config.database;

      await connection.execute(
        `DELETE FROM \`${database}\`.\`${table}\` WHERE id = ?`,
        [resource.id]
      );
    },

    customDelete: async (resource: TrackedResource) => {
      if (!connection) {
        throw new Error('MySQL connection not initialized. Call configure() first.');
      }

      // Allow custom SQL queries via the query property
      const query = resource.query as string;
      const params = (resource.params as any[]) || [resource.id];

      if (!query) {
        throw new Error(`Missing query for custom delete of resource ${resource.id}`);
      }

      await connection.execute(query, params);
    },
  };

  async function cleanupUntracked(options: CleanupUntrackedOptions): Promise<CleanupUntrackedResult> {
    if (!connection) {
      throw new Error('MySQL connection not initialized. Call configure() first.');
    }

    const { testStartTime, userId } = options;
    const deleted: string[] = [];
    const failed: string[] = [];
    let scanned = 0;

    // 1. Get all tables in the database
    const [tablesRows] = await connection.execute(`
      SELECT TABLE_NAME as table_name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME NOT LIKE '_intellitester%'
    `, [config.database]);

    for (const row of tablesRows as { table_name: string }[]) {
      const tableName = row.table_name;
      scanned++;

      // 2. Check if table has created_at and user_id columns
      const [columnsRows] = await connection.execute(`
        SELECT COLUMN_NAME as column_name
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      `, [config.database, tableName]);

      const columns: string[] = (columnsRows as { column_name: string }[]).map(r => r.column_name);
      const hasCreatedAt = columns.some(c => ['created_at', 'createdat', 'created'].includes(c.toLowerCase()));
      const userIdColumn = columns.find(c => ['user_id', 'userid', 'owner_id', 'author_id'].includes(c.toLowerCase()));

      if (!hasCreatedAt) continue;

      // 3. Find the created_at column name
      const createdAtCol = columns.find(c => ['created_at', 'createdat', 'created'].includes(c.toLowerCase()));
      if (!createdAtCol) continue;

      // 4. First, select rows to be deleted (MySQL doesn't have RETURNING)
      let selectQuery = `SELECT id FROM \`${tableName}\` WHERE `;
      const conditions: string[] = [];
      const params: (string | undefined)[] = [];

      // Add created_at condition
      conditions.push(`\`${createdAtCol}\` >= ?`);
      params.push(testStartTime);

      // Add user_id condition if available
      if (userId && userIdColumn) {
        conditions.push(`\`${userIdColumn}\` = ?`);
        params.push(userId);
      }

      selectQuery += conditions.join(' AND ');

      try {
        // Get IDs of rows to be deleted
        const [rowsToDelete] = await connection.execute(selectQuery, params);
        const idsToDelete = (rowsToDelete as { id: string | number }[]).map(r => r.id);

        if (idsToDelete.length === 0) continue;

        // Delete the rows
        const deleteQuery = `DELETE FROM \`${tableName}\` WHERE ` + conditions.join(' AND ');
        await connection.execute(deleteQuery, params);

        // Record deleted IDs
        for (const id of idsToDelete) {
          deleted.push(`${tableName}:${id}`);
        }
      } catch {
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
    name: 'mysql',
    async configure() {
      try {
        // Dynamic import since mysql2 is an optional dependency
        // @ts-expect-error - mysql2 is an optional peer dependency
        const mysql = await import('mysql2/promise');
        const createConnection = mysql.createConnection || mysql.default?.createConnection;
        connection = await createConnection({
          host: config.host,
          port: config.port || 3306,
          user: config.user,
          password: config.password,
          database: config.database,
        });
      } catch {
        throw new Error(
          'Failed to initialize MySQL connection. Make sure the "mysql2" package is installed: npm install mysql2'
        );
      }
    },
    methods,
    cleanupUntracked,
  };
}

// Default type mappings for MySQL resources
export const mysqlTypeMappings: Record<string, string> = {
  row: 'mysql.deleteRow',
  user: 'mysql.deleteUser',
  custom: 'mysql.customDelete',
};
