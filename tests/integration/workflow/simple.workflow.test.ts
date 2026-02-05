/**
 * E2E tests for simple workflow execution.
 * Tests basic workflow operations without browser automation.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { rm } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { startTestServer, waitForServer, type TestServerContext } from '../helpers/testServer.js';
import { setupTestTracking, type TestTrackingContext } from '../helpers/testResources.js';
import { createTestBrowser, type TestBrowserContext } from '../helpers/testBrowser.js';

describe('Simple Workflow Execution', () => {
  const testDir = path.join(process.cwd(), '.intellitester/workflow-test');
  let serverCtx: TestServerContext | null = null;
  let trackingCtx: TestTrackingContext | null = null;
  let browserCtx: TestBrowserContext | null = null;

  beforeAll(async () => {
    // Create test directory with sample pages
    mkdirSync(testDir, { recursive: true });

    // Create a simple test page
    writeFileSync(
      path.join(testDir, 'index.html'),
      `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1 id="title">Welcome</h1>
  <input id="name-input" type="text" placeholder="Enter name">
  <button id="submit-btn">Submit</button>
  <p id="output"></p>
  <script>
    document.getElementById('submit-btn').addEventListener('click', () => {
      const name = document.getElementById('name-input').value;
      document.getElementById('output').textContent = 'Hello, ' + name + '!';
    });
  </script>
</body>
</html>`
    );

    // Start test server
    serverCtx = await startTestServer({ staticDir: testDir });
    await waitForServer(serverCtx.url);
  });

  afterAll(async () => {
    if (serverCtx) {
      await serverCtx.stop();
    }
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    if (browserCtx) {
      await browserCtx.cleanup();
      browserCtx = null;
    }
    if (trackingCtx) {
      await trackingCtx.cleanup();
      trackingCtx = null;
    }
  });

  describe('browser navigation', () => {
    it('should navigate to a URL', async () => {
      browserCtx = await createTestBrowser({ headless: true });

      await browserCtx.page.goto(serverCtx!.url);

      const title = await browserCtx.page.title();
      expect(title).toBe('Test Page');
    });

    it('should find elements by ID', async () => {
      browserCtx = await createTestBrowser({ headless: true });
      await browserCtx.page.goto(serverCtx!.url);

      const heading = await browserCtx.page.$('#title');
      expect(heading).not.toBeNull();

      const text = await heading!.textContent();
      expect(text).toBe('Welcome');
    });

    it('should interact with form elements', async () => {
      browserCtx = await createTestBrowser({ headless: true });
      await browserCtx.page.goto(serverCtx!.url);

      // Fill input
      await browserCtx.page.fill('#name-input', 'Test User');

      // Click button
      await browserCtx.page.click('#submit-btn');

      // Check output
      const output = await browserCtx.page.$('#output');
      const text = await output!.textContent();
      expect(text).toBe('Hello, Test User!');
    });
  });

  describe('with tracking', () => {
    it('should set up tracking context', async () => {
      trackingCtx = await setupTestTracking({ mode: 'file' });
      browserCtx = await createTestBrowser({ headless: true });

      expect(process.env.INTELLITESTER_SESSION_ID).toBeDefined();

      await browserCtx.page.goto(serverCtx!.url);
      // Page should load successfully with tracking enabled
      expect(await browserCtx.page.title()).toBe('Test Page');
    });
  });

  describe('viewport testing', () => {
    it('should test at different viewport sizes', async () => {
      const sizes = [
        { width: 375, height: 667 },  // Mobile
        { width: 768, height: 1024 }, // Tablet
        { width: 1920, height: 1080 }, // Desktop
      ];

      for (const viewport of sizes) {
        browserCtx = await createTestBrowser({ headless: true, viewport });
        await browserCtx.page.goto(serverCtx!.url);

        const viewportSize = browserCtx.page.viewportSize();
        expect(viewportSize?.width).toBe(viewport.width);
        expect(viewportSize?.height).toBe(viewport.height);

        await browserCtx.cleanup();
        browserCtx = null;
      }
    });
  });

  describe('assertions', () => {
    it('should verify element visibility', async () => {
      browserCtx = await createTestBrowser({ headless: true });
      await browserCtx.page.goto(serverCtx!.url);

      const isVisible = await browserCtx.page.isVisible('#title');
      expect(isVisible).toBe(true);

      const isHidden = await browserCtx.page.isVisible('#nonexistent');
      expect(isHidden).toBe(false);
    });

    it('should verify text content', async () => {
      browserCtx = await createTestBrowser({ headless: true });
      await browserCtx.page.goto(serverCtx!.url);

      const content = await browserCtx.page.textContent('#title');
      expect(content).toContain('Welcome');
    });
  });

  describe('error handling', () => {
    it('should handle navigation timeout gracefully', async () => {
      browserCtx = await createTestBrowser({ headless: true, timeout: 1000 });

      await expect(
        browserCtx.page.goto('http://127.0.0.1:59999', { timeout: 500 })
      ).rejects.toThrow();
    });

    it('should handle element not found', async () => {
      browserCtx = await createTestBrowser({ headless: true });
      await browserCtx.page.goto(serverCtx!.url);

      const element = await browserCtx.page.$('#does-not-exist');
      expect(element).toBeNull();
    });
  });
});
