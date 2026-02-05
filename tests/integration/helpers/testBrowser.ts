/**
 * Browser context management for E2E tests.
 */
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type BrowserType } from 'playwright';

export interface TestBrowserContext {
  /** The browser instance */
  browser: Browser;
  /** The browser context */
  context: BrowserContext;
  /** The page instance */
  page: Page;
  /** Clean up browser resources */
  cleanup: () => Promise<void>;
}

export interface TestBrowserOptions {
  /** Run browser in headless mode (default: true) */
  headless?: boolean;
  /** Browser type to use (default: chromium) */
  browserType?: 'chromium' | 'firefox' | 'webkit';
  /** Viewport size */
  viewport?: { width: number; height: number };
  /** Default navigation timeout in ms */
  timeout?: number;
}

const browserTypes: Record<string, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

/**
 * Create an isolated browser context for a test.
 */
export async function createTestBrowser(
  options: TestBrowserOptions = {}
): Promise<TestBrowserContext> {
  const {
    headless = true,
    browserType = 'chromium',
    viewport = { width: 1920, height: 1080 },
    timeout = 30000,
  } = options;

  const browserLauncher = browserTypes[browserType] || chromium;
  const browser = await browserLauncher.launch({ headless });

  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  return {
    browser,
    context,
    page,
    cleanup: async () => {
      try {
        await context.close();
      } catch {
        // Context may already be closed
      }
      try {
        await browser.close();
      } catch {
        // Browser may already be closed
      }
    },
  };
}

/**
 * Create a shared browser for multiple tests in a suite.
 * Returns browser and cleanup function; tests create their own contexts.
 */
export async function createSharedBrowser(
  options: Omit<TestBrowserOptions, 'viewport' | 'timeout'> = {}
): Promise<{ browser: Browser; cleanup: () => Promise<void> }> {
  const { headless = true, browserType = 'chromium' } = options;

  const browserLauncher = browserTypes[browserType] || chromium;
  const browser = await browserLauncher.launch({ headless });

  return {
    browser,
    cleanup: async () => {
      try {
        await browser.close();
      } catch {
        // Browser may already be closed
      }
    },
  };
}

/**
 * Create a new context and page from an existing browser.
 */
export async function createContextFromBrowser(
  browser: Browser,
  options: Pick<TestBrowserOptions, 'viewport' | 'timeout'> = {}
): Promise<Omit<TestBrowserContext, 'browser'> & { cleanup: () => Promise<void> }> {
  const {
    viewport = { width: 1920, height: 1080 },
    timeout = 30000,
  } = options;

  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  return {
    context,
    page,
    cleanup: async () => {
      try {
        await context.close();
      } catch {
        // Context may already be closed
      }
    },
  };
}
