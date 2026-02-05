/**
 * E2E tests for web server lifecycle management.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { rm } from 'fs/promises';
import path from 'path';
import {
  startTestServer,
  waitForServer,
  startTrackingTestServer,
  type TestServerContext,
} from '../helpers/testServer.js';

describe('Web Server Lifecycle', () => {
  let serverCtx: TestServerContext | null = null;
  const testStaticDir = path.join(process.cwd(), '.intellitester/test-static');

  afterEach(async () => {
    if (serverCtx) {
      await serverCtx.stop();
      serverCtx = null;
    }
    await rm(testStaticDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('server start', () => {
    it('should start on random available port', async () => {
      serverCtx = await startTestServer({ port: 0 });

      expect(serverCtx.port).toBeGreaterThan(0);
      expect(serverCtx.url).toBe(`http://127.0.0.1:${serverCtx.port}`);
    });

    it('should be reachable after start', async () => {
      serverCtx = await startTestServer();

      const isReady = await waitForServer(serverCtx.url, { timeout: 5000 });
      expect(isReady).toBe(true);
    });

    it('should serve static files', async () => {
      // Create test static directory with index.html
      mkdirSync(testStaticDir, { recursive: true });
      writeFileSync(path.join(testStaticDir, 'index.html'), '<html><body>Test</body></html>');

      serverCtx = await startTestServer({ staticDir: testStaticDir });

      const response = await fetch(serverCtx.url);
      expect(response.ok).toBe(true);

      const text = await response.text();
      expect(text).toContain('Test');
    });

    it('should return 404 for missing files', async () => {
      mkdirSync(testStaticDir, { recursive: true });
      serverCtx = await startTestServer({ staticDir: testStaticDir });

      const response = await fetch(`${serverCtx.url}/nonexistent.html`);
      expect(response.status).toBe(404);
    });
  });

  describe('server stop', () => {
    it('should stop cleanly', async () => {
      serverCtx = await startTestServer();
      const port = serverCtx.port;

      // Verify it's running
      const beforeStop = await waitForServer(serverCtx.url, { timeout: 2000 });
      expect(beforeStop).toBe(true);

      await serverCtx.stop();

      // Verify it's stopped
      const isReachable = await waitForServer(`http://127.0.0.1:${port}`, { timeout: 1000 });
      expect(isReachable).toBe(false);

      serverCtx = null; // Prevent double-stop in afterEach
    });
  });

  describe('waitForServer', () => {
    it('should return true when server is ready', async () => {
      serverCtx = await startTestServer();

      const isReady = await waitForServer(serverCtx.url);
      expect(isReady).toBe(true);
    });

    it('should return false when server is not available', async () => {
      // Use a port that's definitely not in use
      const isReady = await waitForServer('http://127.0.0.1:59999', { timeout: 500 });
      expect(isReady).toBe(false);
    });

    it('should respect timeout option', async () => {
      const start = Date.now();
      const isReady = await waitForServer('http://127.0.0.1:59999', { timeout: 500, interval: 100 });
      const elapsed = Date.now() - start;

      expect(isReady).toBe(false);
      // Allow some variance for network timeouts, should complete within 2 seconds
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe('tracking server', () => {
    it('should track requests', async () => {
      const ctx = await startTrackingTestServer();
      serverCtx = ctx;

      // Make some requests
      await fetch(`${ctx.url}/test1`);
      await fetch(`${ctx.url}/test2`, { method: 'POST', body: 'data' });

      expect(ctx.requests).toHaveLength(2);
      expect(ctx.requests[0].url).toBe('/test1');
      expect(ctx.requests[0].method).toBe('GET');
      expect(ctx.requests[1].url).toBe('/test2');
      expect(ctx.requests[1].method).toBe('POST');
      expect(ctx.requests[1].body).toBe('data');
    });
  });

  describe('custom handler', () => {
    it('should use provided request handler', async () => {
      const handler = (req: any, res: any) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ custom: true, path: req.url }));
      };

      serverCtx = await startTestServer({ handler });

      const response = await fetch(`${serverCtx.url}/custom-path`);
      const data = await response.json();

      expect(data.custom).toBe(true);
      expect(data.path).toBe('/custom-path');
    });
  });

  describe('content types', () => {
    it('should serve files with correct content types', async () => {
      mkdirSync(testStaticDir, { recursive: true });
      writeFileSync(path.join(testStaticDir, 'style.css'), 'body { color: red; }');
      writeFileSync(path.join(testStaticDir, 'script.js'), 'console.log("test")');
      writeFileSync(path.join(testStaticDir, 'data.json'), '{"test": true}');

      serverCtx = await startTestServer({ staticDir: testStaticDir });

      const cssResponse = await fetch(`${serverCtx.url}/style.css`);
      expect(cssResponse.headers.get('content-type')).toBe('text/css');

      const jsResponse = await fetch(`${serverCtx.url}/script.js`);
      expect(jsResponse.headers.get('content-type')).toBe('application/javascript');

      const jsonResponse = await fetch(`${serverCtx.url}/data.json`);
      expect(jsonResponse.headers.get('content-type')).toBe('application/json');
    });
  });
});
