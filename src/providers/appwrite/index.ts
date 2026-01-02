import { Client, Users, TablesDB, Storage, Teams, Query } from 'node-appwrite';
import type {
  CleanupProvider,
  CleanupHandler,
  CleanupUntrackedOptions,
  CleanupUntrackedResult,
} from '../../core/cleanup/types.js';
import type { TrackedResource } from '../../integration/index.js';

interface AppwriteConfig {
  endpoint: string;
  projectId: string;
  apiKey: string;
}

export function createAppwriteProvider(config: AppwriteConfig): CleanupProvider {
  const client = new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setKey(config.apiKey);

  const tablesDB = new TablesDB(client);
  const storage = new Storage(client);
  const teams = new Teams(client);
  const users = new Users(client);

  const methods: Record<string, CleanupHandler> = {
    deleteRow: async (resource: TrackedResource) => {
      const databaseId = resource.databaseId as string;
      const tableId = resource.tableId as string;

      if (!databaseId || !tableId) {
        throw new Error(`Missing databaseId or tableId for row ${resource.id}`);
      }

      await tablesDB.deleteRow({
        databaseId,
        tableId,
        rowId: resource.id,
      });
    },

    deleteFile: async (resource: TrackedResource) => {
      const bucketId = resource.bucketId as string;

      if (!bucketId) {
        throw new Error(`Missing bucketId for file ${resource.id}`);
      }

      await storage.deleteFile(bucketId, resource.id);
    },

    deleteTeam: async (resource: TrackedResource) => {
      await teams.delete(resource.id);
    },

    deleteUser: async (resource: TrackedResource) => {
      await users.delete(resource.id);
    },

    deleteMembership: async (resource: TrackedResource) => {
      const teamId = resource.teamId as string;

      if (!teamId) {
        throw new Error(`Missing teamId for membership ${resource.id}`);
      }

      await teams.deleteMembership(teamId, resource.id);
    },
  };

  /**
   * Scan all Appwrite tables for resources created after testStartTime
   * that contain the userId in any field, and delete them.
   */
  async function cleanupUntracked(
    options: CleanupUntrackedOptions
  ): Promise<CleanupUntrackedResult> {
    const { testStartTime, userId, sessionId } = options;
    const deleted: string[] = [];
    const failed: string[] = [];
    let scanned = 0;

    console.log(
      `[Appwrite Cleanup] Starting untracked cleanup for session ${sessionId || 'unknown'}`
    );
    console.log(`[Appwrite Cleanup] Test start time: ${testStartTime}`);
    console.log(`[Appwrite Cleanup] User ID to match: ${userId || 'none'}`);

    try {
      // 1. List all databases
      const databases = await tablesDB.list();
      console.log(
        `[Appwrite Cleanup] Found ${databases.databases.length} databases to scan`
      );

      for (const db of databases.databases) {
        // 2. List all tables in each database
        const tables = await tablesDB.listTables({ databaseId: db.$id });
        console.log(
          `[Appwrite Cleanup] Database "${db.name}" (${db.$id}): ${tables.tables.length} tables`
        );

        for (const table of tables.tables) {
          // Skip tracking tables (tables starting with _intellitester)
          if (table.name.startsWith('_intellitester')) {
            console.log(
              `[Appwrite Cleanup] Skipping tracking table: ${table.name}`
            );
            continue;
          }

          scanned++;

          try {
            // 3. Query for rows created after testStartTime with pagination
            let hasMore = true;
            let cursor: string | undefined;

            while (hasMore) {
              const queries = [
                Query.greaterThanEqual('$createdAt', testStartTime),
                Query.limit(100),
              ];

              if (cursor) {
                queries.push(Query.cursorAfter(cursor));
              }

              const rows = await tablesDB.listRows({
                databaseId: db.$id,
                tableId: table.$id,
                queries,
              });

              console.log(
                `[Appwrite Cleanup] Table "${table.name}": found ${rows.rows.length} rows created after test start`
              );

              for (const row of rows.rows) {
                // 4. Check if any field contains userId
                const rowJson = JSON.stringify(row);
                const shouldDelete = userId && rowJson.includes(userId);

                if (shouldDelete) {
                  try {
                    await tablesDB.deleteRow({
                      databaseId: db.$id,
                      tableId: table.$id,
                      rowId: row.$id,
                    });
                    deleted.push(`row:${db.$id}/${table.$id}/${row.$id}`);
                    console.log(
                      `[Appwrite Cleanup] Deleted row ${row.$id} from ${table.name}`
                    );
                  } catch (error) {
                    failed.push(`row:${db.$id}/${table.$id}/${row.$id}`);
                    console.warn(
                      `[Appwrite Cleanup] Failed to delete row ${row.$id}:`,
                      error
                    );
                  }
                }
              }

              // Check if we need to paginate
              if (rows.rows.length < 100) {
                hasMore = false;
              } else {
                cursor = rows.rows[rows.rows.length - 1].$id;
              }
            }
          } catch (error) {
            console.warn(
              `[Appwrite Cleanup] Error scanning table ${table.name}:`,
              error
            );
          }
        }
      }

      // 5. Scan storage buckets for files
      console.log('[Appwrite Cleanup] Scanning storage buckets...');
      const buckets = await storage.listBuckets();
      console.log(
        `[Appwrite Cleanup] Found ${buckets.buckets.length} buckets to scan`
      );

      for (const bucket of buckets.buckets) {
        scanned++;

        try {
          let hasMore = true;
          let cursor: string | undefined;

          while (hasMore) {
            const queries = [
              Query.greaterThanEqual('$createdAt', testStartTime),
              Query.limit(100),
            ];

            if (cursor) {
              queries.push(Query.cursorAfter(cursor));
            }

            const files = await storage.listFiles({
              bucketId: bucket.$id,
              queries,
            });

            console.log(
              `[Appwrite Cleanup] Bucket "${bucket.name}": found ${files.files.length} files created after test start`
            );

            for (const file of files.files) {
              // Files don't have custom fields, but check name patterns
              // Note: $createdBy might not exist on all file objects
              const fileRecord = file as Record<string, unknown>;
              const createdBy = fileRecord.$createdBy as string | undefined;
              const shouldDelete =
                userId &&
                (createdBy === userId || file.name.includes(userId));

              if (shouldDelete) {
                try {
                  await storage.deleteFile({
                    bucketId: bucket.$id,
                    fileId: file.$id,
                  });
                  deleted.push(`file:${bucket.$id}/${file.$id}`);
                  console.log(
                    `[Appwrite Cleanup] Deleted file ${file.$id} from bucket ${bucket.name}`
                  );
                } catch (error) {
                  failed.push(`file:${bucket.$id}/${file.$id}`);
                  console.warn(
                    `[Appwrite Cleanup] Failed to delete file ${file.$id}:`,
                    error
                  );
                }
              }
            }

            // Check if we need to paginate
            if (files.files.length < 100) {
              hasMore = false;
            } else {
              cursor = files.files[files.files.length - 1].$id;
            }
          }
        } catch (error) {
          console.warn(
            `[Appwrite Cleanup] Error scanning bucket ${bucket.name}:`,
            error
          );
        }
      }

      // 6. Delete the test user last
      if (userId) {
        console.log(`[Appwrite Cleanup] Deleting test user: ${userId}`);
        try {
          await users.delete(userId);
          deleted.push(`user:${userId}`);
          console.log(`[Appwrite Cleanup] Deleted user ${userId}`);
        } catch (error) {
          failed.push(`user:${userId}`);
          console.warn(
            `[Appwrite Cleanup] Failed to delete user ${userId}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error('[Appwrite Cleanup] Error during cleanup scan:', error);
    }

    console.log(
      `[Appwrite Cleanup] Cleanup complete. Scanned: ${scanned}, Deleted: ${deleted.length}, Failed: ${failed.length}`
    );

    return {
      success: failed.length === 0,
      scanned,
      deleted,
      failed,
    };
  }

  return {
    name: 'appwrite',
    async configure() {
      // Client is already configured in the factory function
      // This is called by the cleanup executor but we don't need to do anything
    },
    methods,
    cleanupUntracked,
  };
}

// Default type mappings for Appwrite resources
export const appwriteTypeMappings: Record<string, string> = {
  row: 'appwrite.deleteRow',
  file: 'appwrite.deleteFile',
  team: 'appwrite.deleteTeam',
  user: 'appwrite.deleteUser',
  membership: 'appwrite.deleteMembership',
};
