/**
 * E2E tests for tracked resource cleanup.
 * Tests that require SQLite are automatically skipped if SQLite is not available.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createTestDatabase,
  insertTestUser,
  insertTestResource,
  type TestDatabase,
} from '../helpers/testDatabase.js';
import { setupTestCleanup, createMockCleanupProvider, type TestCleanupContext } from '../helpers/testCleanup.js';
import { createMockResource, createMockResources } from '../helpers/testResources.js';

describe('Tracked Resource Cleanup', () => {
  let testDb: TestDatabase | null = null;
  let cleanupCtx: TestCleanupContext | null = null;
  let sqliteAvailable = false;

  beforeAll(async () => {
    try {
      testDb = await createTestDatabase();
      cleanupCtx = await setupTestCleanup(testDb);
      sqliteAvailable = true;
    } catch (error) {
      console.warn('SQLite cleanup tests will be skipped:', error instanceof Error ? error.message : 'SQLite not available');
      sqliteAvailable = false;
    }
  });

  afterAll(() => {
    testDb?.cleanup();
  });

  beforeEach(({ skip }) => {
    if (!sqliteAvailable) {
      skip();
      return;
    }
    testDb!.db.exec('DELETE FROM users; DELETE FROM resources;');
  });

  describe('resource tracking integration', () => {
    it('should clean up resources that were tracked during test', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const userId = insertTestUser(testDb!.db, {});
      const resourceId = insertTestResource(testDb!.db, { type: 'test-data' });

      const trackedResources = [
        createMockResource('user', { id: userId }),
        createMockResource('row', { id: resourceId, table: 'resources' }),
      ];

      const result = await cleanupCtx!.runCleanup(trackedResources);

      expect(result.success).toBe(true);
      expect(result.deleted).toHaveLength(2);

      const users = testDb!.db.prepare('SELECT * FROM users').all();
      const resources = testDb!.db.prepare('SELECT * FROM resources').all();
      expect(users).toHaveLength(0);
      expect(resources).toHaveLength(0);
    });
  });

  describe('cleanup with type mappings', () => {
    it('should use correct handler based on resource type', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const userId = insertTestUser(testDb!.db, {});
      const resourceId = insertTestResource(testDb!.db, { type: 'data' });

      const resources = [
        createMockResource('user', { id: userId }),
        createMockResource('row', { id: resourceId, table: 'resources' }),
      ];

      const result = await cleanupCtx!.runCleanup(resources);

      expect(result.success).toBe(true);
      expect(result.deleted).toContain(`user:${userId}`);
      expect(result.deleted).toContain(`row:${resourceId}`);
    });

    it('should fail for unmapped resource types', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const resource = createMockResource('unknown_type', { id: randomUUID() });
      const result = await cleanupCtx!.runCleanup([resource]);

      expect(result.failed.length).toBeGreaterThan(0);
    });
  });

  describe('empty cleanup', () => {
    it('should handle empty resource list', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const result = await cleanupCtx!.runCleanup([]);

      expect(result.success).toBe(true);
      expect(result.deleted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe('mock provider', () => {
    it('should track deleted resources', async () => {
      const mockProvider = createMockCleanupProvider();
      await mockProvider.configure({});

      const resource = createMockResource('resource', { id: 'test-123' });
      await mockProvider.methods.deleteResource(resource);

      expect((mockProvider as any).getDeletedIds()).toContain('test-123');
    });

    it('should fail for specified IDs', async () => {
      const mockProvider = createMockCleanupProvider({ shouldFail: ['fail-id'] });
      await mockProvider.configure({});

      const goodResource = createMockResource('resource', { id: 'good-id' });
      const badResource = createMockResource('resource', { id: 'fail-id' });

      await expect(mockProvider.methods.deleteResource(goodResource)).resolves.toBeUndefined();
      await expect(mockProvider.methods.deleteResource(badResource)).rejects.toThrow('Mock cleanup failed');
    });

    it('should respect delay option', async () => {
      const delay = 100;
      const mockProvider = createMockCleanupProvider({ delay });
      await mockProvider.configure({});

      const resource = createMockResource('resource', { id: 'test' });

      const start = Date.now();
      await mockProvider.methods.deleteResource(resource);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(delay - 10);
    });
  });

  describe('bulk cleanup', () => {
    it('should handle large number of resources', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const count = 50;
      const userIds: string[] = [];

      for (let i = 0; i < count; i++) {
        userIds.push(insertTestUser(testDb!.db, { email: `user${i}@test.com` }));
      }

      const resources = userIds.map((id) => createMockResource('user', { id }));

      const result = await cleanupCtx!.runCleanup(resources);

      expect(result.success).toBe(true);
      expect(result.deleted).toHaveLength(count);

      const remaining = testDb!.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      expect(remaining.count).toBe(0);
    });
  });
});
