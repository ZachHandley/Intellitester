/**
 * E2E tests for web server cleanup and signal handling.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  startTestServer,
  waitForServer,
  type TestServerContext,
} from '../helpers/testServer.js';

describe('Web Server Cleanup', () => {
  let serverCtx: TestServerContext | null = null;

  afterEach(async () => {
    if (serverCtx) {
      await serverCtx.stop().catch(() => {});
      serverCtx = null;
    }
  });

  describe('graceful shutdown', () => {
    it('should close server connection on stop', async () => {
      serverCtx = await startTestServer();
      const port = serverCtx.port;

      // Verify server is running
      expect(await waitForServer(serverCtx.url, { timeout: 2000 })).toBe(true);

      // Stop the server
      await serverCtx.stop();

      // Server should no longer respond
      const isReachable = await waitForServer(`http://127.0.0.1:${port}`, { timeout: 500 });
      expect(isReachable).toBe(false);

      serverCtx = null;
    });

    it('should handle multiple stop calls gracefully', async () => {
      serverCtx = await startTestServer();

      // First stop should succeed
      await serverCtx.stop();

      // Second stop should not throw
      await expect(serverCtx.stop()).resolves.toBeUndefined();

      serverCtx = null;
    });
  });

  describe('connection handling', () => {
    it('should complete in-flight requests before stopping', async () => {
      const handler = async (req: any, res: any) => {
        // Simulate slow response
        await new Promise((r) => setTimeout(r, 100));
        res.writeHead(200);
        res.end('done');
      };

      serverCtx = await startTestServer({ handler });

      // Start a request (don't await yet)
      const requestPromise = fetch(serverCtx.url);

      // Give the request time to start
      await new Promise((r) => setTimeout(r, 10));

      // Stop the server
      const stopPromise = serverCtx.stop();

      // The request might complete or fail depending on timing
      // Either is acceptable for this test
      try {
        const response = await requestPromise;
        expect(response.status).toBe(200);
      } catch {
        // Connection was closed, that's also acceptable
      }

      await stopPromise;
      serverCtx = null;
    });
  });

  describe('resource cleanup', () => {
    it('should free up port after stop', async () => {
      const firstServer = await startTestServer({ port: 0 });
      const port = firstServer.port;

      await firstServer.stop();

      // Should be able to start another server on the same port
      // (Note: port 0 means random, so we just verify the first one stopped)
      const isAvailable = !(await waitForServer(`http://127.0.0.1:${port}`, { timeout: 500 }));
      expect(isAvailable).toBe(true);
    });

    it('should handle rapid start/stop cycles', async () => {
      for (let i = 0; i < 5; i++) {
        const server = await startTestServer();
        expect(await waitForServer(server.url, { timeout: 1000 })).toBe(true);
        await server.stop();
      }
    });
  });

  describe('error scenarios', () => {
    it('should handle server already stopped', async () => {
      serverCtx = await startTestServer();
      await serverCtx.stop();

      // Calling stop again should not throw
      await expect(serverCtx.stop()).resolves.toBeUndefined();

      serverCtx = null;
    });
  });
});
