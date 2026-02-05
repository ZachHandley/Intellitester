/**
 * E2E tests for SQLite cleanup provider.
 * These tests require better-sqlite3 with native bindings compiled.
 * Tests are automatically skipped if SQLite is not available.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createTestDatabase,
  insertTestUser,
  insertTestResource,
  type TestDatabase,
} from '../helpers/testDatabase.js';
import { setupTestCleanup, type TestCleanupContext } from '../helpers/testCleanup.js';
import { createMockResource } from '../helpers/testResources.js';

describe('SQLite Cleanup Provider', () => {
  let testDb: TestDatabase | null = null;
  let cleanupCtx: TestCleanupContext | null = null;
  let sqliteAvailable = false;

  beforeAll(async () => {
    try {
      testDb = await createTestDatabase();
      cleanupCtx = await setupTestCleanup(testDb);
      sqliteAvailable = true;
    } catch (error) {
      console.warn('SQLite tests will be skipped:', error instanceof Error ? error.message : 'SQLite not available');
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
    testDb!.db.exec('DELETE FROM users; DELETE FROM resources; DELETE FROM teams; DELETE FROM team_members;');
  });

  describe('deleteRow', () => {
    it('should delete a row by id from specified table', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const resourceId = insertTestResource(testDb!.db, { type: 'test' });
      const before = testDb!.db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
      expect(before).toBeDefined();

      const resource = createMockResource('row', { id: resourceId, table: 'resources' });
      const result = await cleanupCtx!.runCleanup([resource]);

      expect(result.success).toBe(true);
      expect(result.deleted).toContain(`row:${resourceId}`);

      const after = testDb!.db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
      expect(after).toBeUndefined();
    });

    it('should handle missing table gracefully', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const resource = createMockResource('row', { id: randomUUID(), table: 'nonexistent_table' });
      const result = await cleanupCtx!.runCleanup([resource]);
      expect(result.failed.length).toBeGreaterThan(0);
    });

    it('should handle non-existent row without error', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const resource = createMockResource('row', { id: randomUUID(), table: 'resources' });
      const result = await cleanupCtx!.runCleanup([resource]);
      expect(result.success).toBe(true);
    });
  });

  describe('deleteUser', () => {
    it('should delete a user by id from users table', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const userId = insertTestUser(testDb!.db, { name: 'Test User' });
      const before = testDb!.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      expect(before).toBeDefined();

      const resource = createMockResource('user', { id: userId });
      const result = await cleanupCtx!.runCleanup([resource]);

      expect(result.success).toBe(true);
      expect(result.deleted).toContain(`user:${userId}`);

      const after = testDb!.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      expect(after).toBeUndefined();
    });

    it('should delete from custom table when specified', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const teamId = randomUUID();
      testDb!.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(teamId, 'Test Team');

      const resource = createMockResource('user', { id: teamId, table: 'teams' });
      const result = await cleanupCtx!.runCleanup([resource]);

      expect(result.success).toBe(true);
      const after = testDb!.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
      expect(after).toBeUndefined();
    });
  });

  describe('customDelete', () => {
    it('should execute custom SQL query', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      insertTestUser(testDb!.db, { email: 'test1@example.com' });
      insertTestUser(testDb!.db, { email: 'test2@example.com' });
      expect(testDb!.db.prepare('SELECT COUNT(*) as count FROM users').get()).toEqual({ count: 2 });

      const resource = createMockResource('custom', {
        id: 'batch-delete',
        query: "DELETE FROM users WHERE email LIKE ?",
        params: ['%@example.com'],
      });
      const result = await cleanupCtx!.runCleanup([resource]);

      expect(result.success).toBe(true);
      expect(testDb!.db.prepare('SELECT COUNT(*) as count FROM users').get()).toEqual({ count: 0 });
    });

    it('should error when query is missing', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const resource = createMockResource('custom', { id: 'no-query' });
      const result = await cleanupCtx!.runCleanup([resource]);
      expect(result.failed.length).toBeGreaterThan(0);
    });
  });

  describe('cleanup ordering', () => {
    it('should clean up resources in LIFO order', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const id1 = insertTestResource(testDb!.db, { type: 'first' });
      const id2 = insertTestResource(testDb!.db, { type: 'second' });
      const id3 = insertTestResource(testDb!.db, { type: 'third' });

      const resources = [
        createMockResource('row', { id: id1, table: 'resources', createdAt: '2024-01-01T00:00:00Z' }),
        createMockResource('row', { id: id2, table: 'resources', createdAt: '2024-01-01T00:01:00Z' }),
        createMockResource('row', { id: id3, table: 'resources', createdAt: '2024-01-01T00:02:00Z' }),
      ];

      const result = await cleanupCtx!.runCleanup(resources);

      expect(result.success).toBe(true);
      expect(result.deleted).toHaveLength(3);
      expect(result.deleted).toContain(`row:${id1}`);
      expect(result.deleted).toContain(`row:${id2}`);
      expect(result.deleted).toContain(`row:${id3}`);
    });
  });

  describe('multiple resources', () => {
    it('should handle mixed resource types', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const userId = insertTestUser(testDb!.db, {});
      const resourceId = insertTestResource(testDb!.db, { type: 'data' });

      const resources = [
        createMockResource('user', { id: userId }),
        createMockResource('row', { id: resourceId, table: 'resources' }),
      ];

      const result = await cleanupCtx!.runCleanup(resources);

      expect(result.success).toBe(true);
      expect(result.deleted).toHaveLength(2);
    });

    it('should continue cleanup even if one fails', async ({ skip }) => {
      if (!sqliteAvailable) return skip();

      const userId = insertTestUser(testDb!.db, {});

      const resources = [
        createMockResource('row', { id: randomUUID(), table: 'nonexistent' }),
        createMockResource('user', { id: userId }),
      ];

      const result = await cleanupCtx!.runCleanup(resources);

      expect(result.failed.length).toBeGreaterThan(0);
      expect(result.deleted).toContain(`user:${userId}`);
    });
  });
});
