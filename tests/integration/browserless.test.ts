import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright';

describe('Browserless Integration', () => {
  it(
    'should connect to Browserless and navigate to a page',
    { timeout: 30000 },
    async () => {
      const browserWSEndpoint =
        process.env.BROWSERLESS_URL || 'ws://localhost:3000';

      const browser = await chromium.connect(browserWSEndpoint);

      try {
        const context = await browser.newContext();
        const page = await context.newPage();

        // Navigate to a simple page
        await page.goto('https://example.com');

        // Verify the page loaded
        const title = await page.title();
        expect(title).toBeTruthy();
        expect(title.length).toBeGreaterThan(0);

        // Verify we can interact with the page
        const heading = await page.locator('h1').textContent();
        expect(heading).toBeTruthy();

        await page.close();
        await context.close();
      } finally {
        await browser.close();
      }
    },
  );

  it(
    'should handle multiple concurrent browser contexts',
    { timeout: 30000 },
    async () => {
      const browserWSEndpoint =
        process.env.BROWSERLESS_URL || 'ws://localhost:3000';

      const browser = await chromium.connect(browserWSEndpoint);

      try {
        const context1 = await browser.newContext();
        const context2 = await browser.newContext();

        const page1 = await context1.newPage();
        const page2 = await context2.newPage();

        // Navigate both pages concurrently
        await Promise.all([
          page1.goto('https://example.com'),
          page2.goto('https://example.org'),
        ]);

        // Verify both pages loaded
        const [title1, title2] = await Promise.all([
          page1.title(),
          page2.title(),
        ]);

        expect(title1).toBeTruthy();
        expect(title2).toBeTruthy();

        await page1.close();
        await page2.close();
        await context1.close();
        await context2.close();
      } finally {
        await browser.close();
      }
    },
  );
});
