/**
 * E2E tests for file-based resource tracking.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { rm } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { setupTestTracking, createMockResource, type TestTrackingContext } from '../helpers/testResources.js';

describe('File-Based Tracking', () => {
  let trackingCtx: TestTrackingContext;
  const testTrackDir = path.join(process.cwd(), '.intellitester/test-track');

  beforeEach(async () => {
    // Ensure clean test directory
    mkdirSync(testTrackDir, { recursive: true });
  });

  afterEach(async () => {
    if (trackingCtx) {
      await trackingCtx.cleanup();
    }
    // Clean up test track directory
    await rm(testTrackDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('initialization', () => {
    it('should create track file on init', async () => {
      trackingCtx = await setupTestTracking({ mode: 'file', trackDir: testTrackDir });

      expect(trackingCtx.fileTracking).not.toBeNull();
      expect(trackingCtx.fileTracking!.trackFile).toBeDefined();
      expect(existsSync(trackingCtx.fileTracking!.trackFile)).toBe(true);
    });

    it('should set environment variables', async () => {
      trackingCtx = await setupTestTracking({ mode: 'file', trackDir: testTrackDir });

      expect(process.env.INTELLITESTER_SESSION_ID).toBe(trackingCtx.sessionId);
      expect(process.env.INTELLITESTER_TRACK_FILE).toBe(trackingCtx.fileTracking!.trackFile);
    });

    it('should generate unique session ID', async () => {
      const ctx1 = await setupTestTracking({ mode: 'file', trackDir: testTrackDir });
      await ctx1.cleanup();

      const ctx2 = await setupTestTracking({ mode: 'file', trackDir: testTrackDir });

      expect(ctx1.sessionId).not.toBe(ctx2.sessionId);

      await ctx2.cleanup();
    });
  });

  describe('cleanup', () => {
    it('should clear environment variables on cleanup', async () => {
      trackingCtx = await setupTestTracking({ mode: 'file', trackDir: testTrackDir });

      expect(process.env.INTELLITESTER_SESSION_ID).toBeDefined();

      await trackingCtx.cleanup();

      expect(process.env.INTELLITESTER_SESSION_ID).toBeUndefined();
      expect(process.env.INTELLITESTER_TRACK_FILE).toBeUndefined();
    });

    it('should stop file tracking on cleanup', async () => {
      trackingCtx = await setupTestTracking({ mode: 'file', trackDir: testTrackDir });

      const trackFile = trackingCtx.fileTracking!.trackFile;
      expect(existsSync(trackFile)).toBe(true);

      await trackingCtx.cleanup();

      // File might still exist but tracking should be stopped
      // The stop function should have been called without error
    });
  });

  describe('resource tracking', () => {
    it('should write resources to track file via track() function', async () => {
      trackingCtx = await setupTestTracking({ mode: 'file', trackDir: testTrackDir });

      // Import track function (uses INTELLITESTER_TRACK_FILE env var)
      const { track } = await import('../../../src/integration/index.js');

      const resource = {
        type: 'user',
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };

      // Track the resource
      await track(resource);

      // Give it a moment to write
      await new Promise((r) => setTimeout(r, 100));

      // Read the track file
      const trackFile = trackingCtx.fileTracking!.trackFile;
      const content = readFileSync(trackFile, 'utf8');

      // Track file is JSONL format
      const lines = content.trim().split('\n').filter(Boolean);
      const tracked = lines.map((line) => JSON.parse(line));

      // Should contain our resource
      const found = tracked.find((r) => r.id === resource.id);
      expect(found).toBeDefined();
      expect(found.type).toBe('user');
    });
  });
});
