import { Client, Users, TablesDB, Storage, Teams } from 'node-appwrite';
import type { TrackedResource, TestContext, AppwriteCleanupConfig } from './types';
import { saveFailedCleanup } from '../../core/cleanup/persistence.js';

export class AppwriteTestClient {
  private client: Client;
  private users: Users;
  private tablesDB: TablesDB;
  private storage: Storage;
  private teams: Teams;
  private config: AppwriteCleanupConfig;

  constructor(config: AppwriteCleanupConfig) {
    this.config = config;
    this.client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    this.users = new Users(this.client);
    this.tablesDB = new TablesDB(this.client);
    this.storage = new Storage(this.client);
    this.teams = new Teams(this.client);
  }

  async cleanup(
    context: TestContext,
    sessionId?: string,
    cwd?: string
  ): Promise<{ success: boolean; deleted: string[]; failed: string[] }> {
    const deleted: string[] = [];
    const failed: string[] = [];

    // Delete in reverse order (newest first, user last)
    const sortedResources = [...context.resources].reverse();

    for (const resource of sortedResources) {
      // Skip resources that were already deleted during the test
      if (resource.deleted) {
        deleted.push(`${resource.type}:${resource.id} (already deleted)`);
        continue;
      }

      try {
        switch (resource.type) {
          case 'row':
            if (resource.databaseId && resource.tableId) {
              await this.tablesDB.deleteRow({
                databaseId: resource.databaseId,
                tableId: resource.tableId,
                rowId: resource.id,
              });
            }
            break;
          case 'file':
            if (resource.bucketId) {
              await this.storage.deleteFile(resource.bucketId, resource.id);
            }
            break;
          case 'membership':
            if (resource.teamId) {
              await this.teams.deleteMembership(resource.teamId, resource.id);
            }
            break;
          case 'team':
            await this.teams.delete(resource.id);
            break;
          case 'message':
            // Messages typically can't be deleted after being sent
            // Skip cleanup for message type
            deleted.push(`${resource.type}:${resource.id} (skipped - messages cannot be deleted)`);
            continue;
          case 'user':
            // Delete user last
            break;
        }
        deleted.push(`${resource.type}:${resource.id}`);
      } catch (error) {
        failed.push(`${resource.type}:${resource.id}`);
        console.warn(`Failed to delete ${resource.type} ${resource.id}:`, error);
      }
    }

    // Delete user last
    if (context.userId) {
      try {
        await this.users.delete(context.userId);
        deleted.push(`user:${context.userId}`);
      } catch (error) {
        failed.push(`user:${context.userId}`);
        console.warn(`Failed to delete user ${context.userId}:`, error);
      }
    }

    // Persist failed cleanup if there are failures
    if (failed.length > 0 && sessionId) {
      const failedResources = context.resources.filter(r =>
        failed.some(f => f.includes(r.id))
      );

      await saveFailedCleanup({
        sessionId,
        timestamp: new Date().toISOString(),
        resources: failedResources.map(r => ({
          type: r.type,
          id: r.id,
          databaseId: r.databaseId,
          tableId: r.tableId,
          bucketId: r.bucketId,
          teamId: r.teamId,
        })),
        providerConfig: {
          provider: 'appwrite',
          endpoint: this.config.endpoint,
          projectId: this.config.projectId,
        },
        errors: failed,
      }, cwd);
    }

    return { success: failed.length === 0, deleted, failed };
  }
}

export function createTestContext(): TestContext {
  return {
    resources: [],
    variables: new Map(),
  };
}
