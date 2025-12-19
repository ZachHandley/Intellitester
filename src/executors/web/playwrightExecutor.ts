import fs from 'node:fs/promises';
import path from 'node:path';

import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
  type Locator as PWLocator,
  type Page,
} from 'playwright';

import type { Action, Locator, TestDefinition } from '../../core/types';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface WebRunOptions {
  baseUrl?: string;
  browser?: BrowserName;
  headed?: boolean;
  screenshotDir?: string;
  defaultTimeoutMs?: number;
}

export interface StepResult {
  action: Action;
  status: 'passed' | 'failed';
  error?: string;
  screenshotPath?: string;
}

export interface WebRunResult {
  status: 'passed' | 'failed';
  steps: StepResult[];
}

const defaultScreenshotDir = path.join(process.cwd(), 'artifacts', 'screenshots');

const resolveUrl = (value: string, baseUrl?: string): string => {
  if (!baseUrl) return value;
  try {
    const url = new URL(value, baseUrl);
    return url.toString();
  } catch {
    return value;
  }
};

const resolveLocator = (page: Page, locator: Locator): PWLocator => {
  if (locator.testId) return page.getByTestId(locator.testId);
  if (locator.text) return page.getByText(locator.text);
  if (locator.css) return page.locator(locator.css);
  if (locator.xpath) return page.locator(`xpath=${locator.xpath}`);
  if (locator.role) {
    const options: { name?: string } = {};
    if (locator.name) options.name = locator.name;
    // playwright typing expects an ARIA role; rely on runtime validation for flexibility
    return page.getByRole(locator.role as any, options);
  }
  if (locator.description) return page.getByText(locator.description);
  throw new Error('No usable selector found for locator');
};

async function ensureScreenshotDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

const runNavigate = async (page: Page, value: string, baseUrl?: string): Promise<void> => {
  const target = resolveUrl(value, baseUrl);
  await page.goto(target);
};

const runTap = async (page: Page, locator: Locator): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.click();
};

const runInput = async (page: Page, locator: Locator, value: string): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.fill(value);
};

const runAssert = async (page: Page, locator: Locator, value?: string): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.waitFor({ state: 'visible' });
  if (value) {
    const text = (await handle.textContent())?.trim() ?? '';
    if (!text.includes(value)) {
      throw new Error(
        `Assertion failed: expected element text to include "${value}", got "${text}"`,
      );
    }
  }
};

const runWait = async (page: Page, action: Extract<Action, { type: 'wait' }>): Promise<void> => {
  if (action.target) {
    const handle = resolveLocator(page, action.target);
    await handle.waitFor({ state: 'visible', timeout: action.timeout });
    return;
  }
  await page.waitForTimeout(action.timeout ?? 1000);
};

const runScroll = async (
  page: Page,
  action: Extract<Action, { type: 'scroll' }>,
): Promise<void> => {
  if (action.target) {
    const handle = resolveLocator(page, action.target);
    await handle.scrollIntoViewIfNeeded();
    return;
  }
  const amount = action.amount ?? 500;
  const direction = action.direction ?? 'down';
  const deltaY = direction === 'up' ? -amount : amount;
  await page.evaluate((value) => window.scrollBy(0, value), deltaY);
};

const runScreenshot = async (
  page: Page,
  name: string | undefined,
  screenshotDir: string,
  stepIndex: number,
): Promise<string> => {
  await ensureScreenshotDir(screenshotDir);
  const filename = name ?? `step-${stepIndex + 1}.png`;
  const filePath = path.join(screenshotDir, filename);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const getBrowser = (browser: BrowserName): BrowserType => {
  switch (browser) {
    case 'firefox':
      return firefox;
    case 'webkit':
      return webkit;
    default:
      return chromium;
  }
};

export const runWebTest = async (
  test: TestDefinition,
  options: WebRunOptions = {},
): Promise<WebRunResult> => {
  if (test.platform !== 'web') {
    throw new Error(`runWebTest only supports web platform, received ${test.platform}`);
  }

  const browserName = options.browser ?? 'chromium';
  const headless = options.headed ? false : true;
  const screenshotDir = options.screenshotDir ?? defaultScreenshotDir;
  const defaultTimeout = options.defaultTimeoutMs ?? 30000;

  const browser = await getBrowser(browserName).launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(defaultTimeout);

  const results: StepResult[] = [];
  try {
    for (const [index, action] of test.steps.entries()) {
      try {
        switch (action.type) {
          case 'navigate':
            await runNavigate(page, action.value, options.baseUrl ?? test.config?.web?.baseUrl);
            break;
          case 'tap':
            await runTap(page, action.target);
            break;
          case 'input':
            await runInput(page, action.target, action.value);
            break;
          case 'assert':
            await runAssert(page, action.target, action.value);
            break;
          case 'wait':
            await runWait(page, action);
            break;
          case 'scroll':
            await runScroll(page, action);
            break;
          case 'screenshot': {
            const screenshotPath = await runScreenshot(page, action.name, screenshotDir, index);
            results.push({ action, status: 'passed', screenshotPath });
            continue;
          }
          default:
            // Exhaustiveness guard
            throw new Error(`Unsupported action type: ${(action as Action).type}`);
        }
        results.push({ action, status: 'passed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ action, status: 'failed', error: message });
        throw error;
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return {
    status: results.every((step) => step.status === 'passed') ? 'passed' : 'failed',
    steps: results,
  };
};
