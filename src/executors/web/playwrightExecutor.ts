import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  chromium,
  firefox,
  webkit,
  type BrowserContextOptions,
  type BrowserType,
  type FrameLocator,
  type Locator as PWLocator,
  type Page,
} from 'playwright';
import prompts from 'prompts';

import type { Action, Locator, TestDefinition, ErrorIf } from '../../core/types';
import { interpolateVariables } from '../../core/interpolation';
import { InbucketClient } from '../../integrations/email/inbucketClient';
import type { Email } from '../../integrations/email/types';
import { AppwriteTestClient, createTestContext, APPWRITE_PATTERNS, APPWRITE_UPDATE_PATTERNS, APPWRITE_DELETE_PATTERNS, type TrackedResource } from '../../integrations/appwrite';
import { getBrowserLaunchOptions, getBrowserTimingConfig, parseViewportSize } from './browserOptions.js';
import { compileMatcher } from './matchers.js';
import { ResponseLog } from './responseLog.js';
import { cssEscape } from './cssEscape';
import { cleanupResolvedFiles, resolveUploadFiles, toPlaywrightFiles } from './uploadResolver';
import { getAISuggestion } from '../../ai/errorHelper';
import { runHealingAgent, type HealingContext } from '../../ai/healingAgent';
import { TrackingServer, initFileTracking, mergeFileTrackedResources } from '../../tracking';
import { track as trackResource } from '../../integration/index.js';
import type { TrackedResource as IntegrationTrackedResource } from '../../integration/index.js';
import { webServerManager, type WebServerConfig, type WebServerInput } from './webServerManager.js';
import { evaluate, terminateOCRWorker } from '../../ai/evaluator';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export type { WebServerConfig };

export interface WebRunOptions {
  baseUrl?: string;
  browser?: BrowserName;
  headed?: boolean;
  screenshotDir?: string;
  defaultTimeoutMs?: number;
  webServer?: WebServerInput;
  debug?: boolean;
  interactive?: boolean;
  aiConfig?: import('../../ai/types').AIConfig;
  sessionId?: string;
  trackDir?: string;
  /** Viewport sizes to test at. Can be predefined ('xs', 'sm', 'md', 'lg', 'xl') or custom 'WxH' format (e.g., '1920x1080'). */
  testSizes?: string[];
  /** Playwright storageState (cookies/localStorage) to apply on every new context. File path string or inline {cookies, origins} object. */
  storageState?: BrowserContextOptions['storageState'];
  /** Absolute path to the test YAML file. Used to resolve relative paths in saveStorageState actions. */
  testFilePath?: string;
  /** Skip tracking server setup (CLI already owns it) */
  skipTrackingSetup?: boolean;
  /** Skip web server start (CLI already owns it) */
  skipWebServerStart?: boolean;
  /** AI-assisted healing configuration */
  healing?: {
    enabled: boolean;
    maxAttempts?: number;
  };
  /** Callback invoked before each step begins for real-time output. */
  onStepStart?: (info: { action: Action; index: number; total: number }) => void;
  /** Callback invoked after each step completes (passed or failed) for real-time output */
  onStepComplete?: (result: StepResult, index: number, total: number) => void;
}

/** Invoke a step callback without letting an exception in the user code cancel the test run. */
function safeCallback(label: string, fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    console.error(`[intellitester] ${label} callback threw:`, e);
  }
}

export interface StepResult {
  action: Action;
  status: 'passed' | 'failed';
  error?: string;
  screenshotPath?: string;
  logOutput?: string;
}

export interface WebRunResult {
  status: 'passed' | 'failed';
  steps: StepResult[];
  variables?: Map<string, string>;
}

interface ExecutionContext {
  variables: Map<string, string>;
  lastEmail: Email | null;
  emailClient: InbucketClient | null;
  appwriteContext: import('../../integrations/appwrite/types').TestContext;
  appwriteConfig?: {
    endpoint: string;
    projectId: string;
    apiKey: string;
  };
}

const defaultScreenshotDir = path.join(process.cwd(), 'artifacts', 'screenshots');

/**
 * Resolve a Playwright storageState value against a base directory.
 * - String paths: returned as-is if absolute, else joined with baseDir.
 * - Inline {cookies, origins} objects: returned unchanged.
 * - Undefined: returned unchanged.
 */
export const resolveStorageStatePath = (
  value: BrowserContextOptions['storageState'] | undefined,
  baseDir: string,
): BrowserContextOptions['storageState'] | undefined => {
  if (typeof value !== 'string') return value;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
};

const interpolateTrackMetadata = (
  value: unknown,
  variables: Map<string, string>
): unknown => {
  if (typeof value === 'string') {
    return interpolateVariables(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateTrackMetadata(entry, variables));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        interpolateTrackMetadata(entry, variables),
      ])
    );
  }
  return value;
};

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
  if (locator.testId) {
    // Try data-testid first (Playwright default), then fallback to id, then class
    return page.locator(
      `[data-testid="${locator.testId}"], #${cssEscape(locator.testId)}, .${cssEscape(locator.testId)}`
    ).first();
  }
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

interface FrameSpec {
  css?: string;
  name?: string;
  index?: number;
}

/**
 * Resolve a frame locator from the page. Returns a FrameLocator for iframe interaction.
 * If no frameSpec provided, returns null (use page directly).
 */
const resolveFrameLocator = (
  page: Page,
  frameSpec: FrameSpec | undefined,
): FrameLocator | null => {
  if (!frameSpec) return null;

  let frameLocator: FrameLocator;

  if (frameSpec.css) {
    frameLocator = page.frameLocator(frameSpec.css);
  } else if (frameSpec.name) {
    // Match by name or id attribute of iframe
    frameLocator = page.frameLocator(`iframe[name="${frameSpec.name}"], iframe#${frameSpec.name}`);
  } else {
    return null;
  }

  // Apply index if specified, otherwise use first()
  if (typeof frameSpec.index === 'number') {
    frameLocator = frameLocator.nth(frameSpec.index);
  } else {
    frameLocator = frameLocator.first();
  }

  return frameLocator;
};

/**
 * Resolve a locator within a context (Page or FrameLocator).
 * Works with both main page and iframe contexts.
 */
const resolveLocatorInContext = (
  context: Page | FrameLocator,
  locator: Locator,
): PWLocator => {
  if (locator.testId) {
    // Try data-testid first (Playwright default), then fallback to id, then class
    return context.locator(
      `[data-testid="${locator.testId}"], #${cssEscape(locator.testId)}, .${cssEscape(locator.testId)}`
    ).first();
  }
  if (locator.text) return context.getByText(locator.text);
  if (locator.css) return context.locator(locator.css);
  if (locator.xpath) return context.locator(`xpath=${locator.xpath}`);
  if (locator.role) {
    const options: { name?: string } = {};
    if (locator.name) options.name = locator.name;
    return context.getByRole(locator.role as any, options);
  }
  if (locator.description) return context.getByText(locator.description);
  throw new Error('No usable selector found for locator');
};

/**
 * Get the appropriate context (Page or FrameLocator) for an action.
 */
const getActionContext = (
  page: Page,
  frameSpec: FrameSpec | undefined,
): Page | FrameLocator => {
  const frame = resolveFrameLocator(page, frameSpec);
  return frame ?? page;
};

/**
 * Check if errorIf condition is met and throw immediately if so.
 * This check is quick (no waiting) - if condition is met, throws immediately.
 */
const checkErrorIf = async (
  page: Page,
  locator: Locator,
  errorIf: ErrorIf | undefined,
): Promise<void> => {
  if (!errorIf) return;

  const handle = resolveLocator(page, locator);

  switch (errorIf) {
    case 'not-found': {
      // Check if element exists in DOM right now (no waiting)
      const count = await handle.count();
      if (count === 0) {
        throw new Error(`errorIf: Element not found in DOM (testId/selector: ${JSON.stringify(locator)})`);
      }
      break;
    }
    case 'not-visible': {
      // Check if element exists but is not visible
      const count = await handle.count();
      if (count > 0) {
        const isVisible = await handle.isVisible();
        if (!isVisible) {
          throw new Error(`errorIf: Element exists but is not visible (testId/selector: ${JSON.stringify(locator)})`);
        }
      }
      break;
    }
    case 'disabled': {
      // Check if element is disabled
      const count = await handle.count();
      if (count > 0) {
        const isDisabled = await handle.isDisabled();
        if (isDisabled) {
          throw new Error(`errorIf: Element is disabled (testId/selector: ${JSON.stringify(locator)})`);
        }
      }
      break;
    }
    case 'empty': {
      // Check if element has no text content
      const count = await handle.count();
      if (count > 0) {
        const text = await handle.textContent();
        if (!text || text.trim() === '') {
          throw new Error(`errorIf: Element has no text content (testId/selector: ${JSON.stringify(locator)})`);
        }
      }
      break;
    }
  }
};

async function ensureScreenshotDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function evaluateStyleAssertion(
  actual: string,
  op: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'greaterThan' | 'lessThan',
  expected: string,
): boolean {
  switch (op) {
    case 'equals': return actual === expected;
    case 'notEquals': return actual !== expected;
    case 'contains': return actual.includes(expected);
    case 'notContains': return !actual.includes(expected);
    case 'greaterThan': {
      const a = parseFloat(actual);
      const e = parseFloat(expected);
      return Number.isFinite(a) && Number.isFinite(e) && a > e;
    }
    case 'lessThan': {
      const a = parseFloat(actual);
      const e = parseFloat(expected);
      return Number.isFinite(a) && Number.isFinite(e) && a < e;
    }
  }
}

const runNavigate = async (
  page: Page,
  value: string,
  baseUrl: string | undefined,
  context: ExecutionContext,
): Promise<void> => {
  const interpolated = interpolateVariables(value, context.variables);
  const target = resolveUrl(interpolated, baseUrl);
  await page.goto(target);
};

const runTap = async (page: Page, locator: Locator, browserName?: BrowserName): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.click();

  // Wait for page to stabilize after click (handles 302 redirect cookie timing, SPA navigation)
  const timing = getBrowserTimingConfig(browserName ?? 'chromium');
  await waitForPageStable(page, timing.networkIdleTimeout);
};

const runInput = async (
  page: Page,
  locator: Locator,
  value: string,
  context: ExecutionContext,
): Promise<void> => {
  const interpolated = interpolateVariables(value, context.variables);
  const handle = resolveLocator(page, locator);
  await handle.fill(interpolated);
};

const runAssert = async (
  page: Page,
  locator: Locator,
  value: string | undefined,
  context: ExecutionContext,
): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.waitFor({ state: 'visible' });
  if (value) {
    const interpolated = interpolateVariables(value, context.variables);
    const text = (await handle.textContent())?.trim() ?? '';
    if (!text.includes(interpolated)) {
      throw new Error(
        `Assertion failed: expected element text to include "${interpolated}", got "${text}"`,
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

const waitForCondition = async (
  checkFn: () => Promise<boolean>,
  timeout: number,
  errorMessage: string,
  browserName?: BrowserName,
): Promise<void> => {
  // Firefox benefits from slightly longer timeouts and slower polling
  const effectiveTimeout = browserName === 'firefox' ? Math.round(timeout * 1.5) : timeout;
  const pollInterval = browserName === 'firefox' ? 150 : 100;

  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (await checkFn()) return;
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(errorMessage);
};

/**
 * Cascading wait strategy that works reliably across all browsers:
 * 1. Wait for domcontentloaded (fast, reliable baseline)
 * 2. Then wait for networkidle (handles SPA data loading)
 * 3. If networkidle times out, continue anyway
 */
const waitForPageStable = async (
  page: Page,
  networkIdleTimeout: number,
): Promise<void> => {
  // Step 1: Wait for DOM to be ready (fast, reliable)
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Step 2: Wait for network to settle (handles SPAs loading data)
  // If this times out, we proceed anyway since DOM is ready
  await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout }).catch(() => {});
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
  browserName?: BrowserName,
): Promise<string> => {
  await ensureScreenshotDir(screenshotDir);

  // Wait for page to stabilize before screenshot
  const timing = getBrowserTimingConfig(browserName ?? 'chromium');
  await waitForPageStable(page, timing.screenshotNetworkIdleTimeout);

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

async function handleInteractiveError(
  page: Page,
  action: Action,
  error: Error,
  screenshotDir: string,
  stepIndex: number,
  aiConfig?: import('../../ai/types').AIConfig,
): Promise<'retry' | 'skip' | 'abort' | 'debug'> {
  console.error(`\n❌ Action failed: ${action.type}`);
  console.error(`   Error: ${error.message}\n`);

  // Take screenshot
  await ensureScreenshotDir(screenshotDir);
  const screenshotPath = path.join(screenshotDir, `error-step-${stepIndex + 1}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Get page content
  const pageContent = await page.content();

  // Get AI suggestion
  if (aiConfig) {
    console.log('🤖 Analyzing error with AI...\n');
    const screenshot = await fs.readFile(screenshotPath);
    const suggestion = await getAISuggestion(error.message, action, pageContent, screenshot, aiConfig);

    if (suggestion.hasSuggestion && suggestion.suggestedSelector) {
      console.log('🤖 AI Suggestion:');
      console.log(`   ${suggestion.explanation}\n`);
      console.log('   Suggested selector:');
      console.log('   target:');
      if (suggestion.suggestedSelector.testId) {
        console.log(`     testId: "${suggestion.suggestedSelector.testId}"`);
      }
      if (suggestion.suggestedSelector.text) {
        console.log(`     text: "${suggestion.suggestedSelector.text}"`);
      }
      if (suggestion.suggestedSelector.css) {
        console.log(`     css: "${suggestion.suggestedSelector.css}"`);
      }
      if (suggestion.suggestedSelector.role) {
        console.log(`     role: "${suggestion.suggestedSelector.role}"`);
      }
      if (suggestion.suggestedSelector.name) {
        console.log(`     name: "${suggestion.suggestedSelector.name}"`);
      }
      console.log('');
    } else {
      console.log(`🤖 AI Analysis: ${suggestion.explanation}\n`);
    }
  }

  // Prompt user
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: 'Retry with AI suggestion', value: 'retry', disabled: !aiConfig },
      { title: 'Skip this step', value: 'skip' },
      { title: 'Abort test', value: 'abort' },
      { title: 'Open in browser (pause)', value: 'debug' },
    ],
    initial: 0,
  });

  return response.action || 'abort';
}

export interface ActionExtras {
  logOutput?: string;
  /** Path to the screenshot file produced by `screenshot` or `evaluate` actions. */
  screenshotPath?: string;
}

/**
 * Snapshot of an element's measurable state captured by `measureElement`.
 * Lives in a per-test `Map` keyed by the user-supplied `name`.
 */
export interface ElementMeasurement {
  /** Bounding box at capture time. Always present (measureElement throws if boundingBox() returned null). */
  box: { x: number; y: number; width: number; height: number };
  /** Captured computed-style values, keyed by CSS property name. */
  styles: Record<string, string>;
  /** Element-scoped PNG buffer if `pixels: true` was set. Required for looksLike/looksDifferent comparators. */
  pixels?: Buffer;
}

export interface ExecuteActionOptions {
  baseUrl?: string;
  context: ExecutionContext;
  screenshotDir: string;
  debugMode: boolean;
  interactive: boolean;
  aiConfig?: import('../../ai/types').AIConfig;
  browserName?: BrowserName;
  healing?: {
    enabled: boolean;
    maxAttempts?: number;
  };
  /** Absolute path to the running test YAML, used to resolve relative file paths for upload/saveStorageState. */
  testFilePath?: string;
  /** Network response log attached to the page; required for `expectResponse`. */
  responseLog?: ResponseLog;
  /** Timestamp of the start of this step (used as the default `since` for `expectResponse`). */
  stepStartTs?: number;
  /** When testing multiple viewport sizes, this is appended to screenshot filenames (e.g. "xl"). Test-runner only. */
  screenshotSizeSuffix?: string;
  /** Per-test slot map shared by measureElement (writes) and assertElement (reads). Runner creates a fresh Map per test. */
  measurements?: Map<string, ElementMeasurement>;
}

export async function executeActionWithRetry(
  page: Page,
  action: Action,
  index: number,
  options: ExecuteActionOptions,
): Promise<ActionExtras> {
  const { baseUrl, context, screenshotDir, debugMode, interactive, aiConfig, browserName, healing, testFilePath, responseLog, stepStartTs, screenshotSizeSuffix, measurements } = options;
  const extras: ActionExtras = {};

  const buildTrackPayload = (stepExtras?: Record<string, unknown>): IntegrationTrackedResource | null => {
    if (!('track' in action)) return null;
    const rawTrack = (action as { track?: Record<string, unknown> }).track;
    if (!rawTrack || typeof rawTrack !== 'object') return null;
    const track = interpolateTrackMetadata(rawTrack, context.variables) as Record<string, unknown>;
    if (typeof track.type !== 'string' || typeof track.id !== 'string') return null;

    const { includeStepContext, ...rest } = track;
    const payload: IntegrationTrackedResource = {
      type: track.type,
      id: track.id,
      ...rest,
    };
    if (includeStepContext) {
      payload.step = { index, ...action, ...stepExtras };
    }
    return payload;
  };

  while (true) {
    try {
      switch (action.type) {
        case 'navigate': {
          const interpolated = interpolateVariables(action.value, context.variables);
          const target = resolveUrl(interpolated, baseUrl);
          if (debugMode) {
            console.log(`[DEBUG] Navigating to: ${target}`);
          }
          await runNavigate(page, action.value, baseUrl, context);
          break;
        }
        case 'tap': {
          const tapAction = action as Extract<Action, { type: 'tap' }>;
          if (debugMode) {
            console.log(`[DEBUG] Tapping element:`, tapAction.target);
            if (tapAction.frame) console.log(`[DEBUG] In frame:`, tapAction.frame);
          }
          if (tapAction.frame) {
            const frameContext = getActionContext(page, tapAction.frame);
            const handle = resolveLocatorInContext(frameContext, tapAction.target);
            await handle.click();
            // Wait for page to stabilize after click
            const timing = getBrowserTimingConfig(browserName ?? 'chromium');
            await waitForPageStable(page, timing.networkIdleTimeout);
          } else {
            await checkErrorIf(page, tapAction.target, tapAction.errorIf);
            await runTap(page, tapAction.target, browserName);
          }
          break;
        }
        case 'input': {
          const inputAction = action as Extract<Action, { type: 'input' }>;
          if (debugMode) {
            const interpolated = interpolateVariables(inputAction.value, context.variables);
            console.log(`[DEBUG] Inputting value into element:`, inputAction.target);
            console.log(`[DEBUG] Value: ${interpolated}`);
            if (inputAction.frame) console.log(`[DEBUG] In frame:`, inputAction.frame);
          }
          if (inputAction.frame) {
            const frameContext = getActionContext(page, inputAction.frame);
            const handle = resolveLocatorInContext(frameContext, inputAction.target);
            const interpolated = interpolateVariables(inputAction.value, context.variables);
            await handle.fill(interpolated);
          } else {
            await checkErrorIf(page, inputAction.target, inputAction.errorIf);
            await runInput(page, inputAction.target, inputAction.value, context);
          }
          break;
        }
        case 'type': {
          const typeAction = action as Extract<Action, { type: 'type' }>;
          const interpolated = interpolateVariables(typeAction.value, context.variables);
          if (debugMode) {
            console.log(`[DEBUG] Typing value:`, typeAction.target ?? '(focused element)');
            console.log(`[DEBUG] Value: ${interpolated}`);
            if (typeAction.frame) console.log(`[DEBUG] In frame:`, typeAction.frame);
          }
          if (typeAction.target) {
            const frameContext = getActionContext(page, typeAction.frame);
            const handle = resolveLocatorInContext(frameContext, typeAction.target);
            await handle.pressSequentially(interpolated, { delay: typeAction.delay ?? 50 });
          } else {
            // No target: type into whatever currently has focus
            await page.keyboard.type(interpolated, { delay: typeAction.delay ?? 50 });
          }
          break;
        }
        case 'clear': {
          const clearAction = action as Extract<Action, { type: 'clear' }>;
          if (debugMode) {
            console.log(`[DEBUG] Clearing element:`, clearAction.target);
            if (clearAction.frame) console.log(`[DEBUG] In frame:`, clearAction.frame);
          }
          if (clearAction.frame) {
            const frameContext = getActionContext(page, clearAction.frame);
            const handle = resolveLocatorInContext(frameContext, clearAction.target);
            await handle.clear();
          } else {
            await checkErrorIf(page, clearAction.target, clearAction.errorIf);
            const handle = resolveLocator(page, clearAction.target);
            await handle.clear();
          }
          break;
        }
        case 'upload': {
          const uploadAction = action as Extract<Action, { type: 'upload' }>;
          if (!uploadAction.target && !uploadAction.trigger) {
            throw new Error('upload action requires either `target` (file input) or `trigger` (button)');
          }
          if (uploadAction.target && uploadAction.trigger) {
            throw new Error('upload action accepts `target` OR `trigger`, not both');
          }
          if (debugMode) {
            console.log(`[DEBUG] Uploading files:`, uploadAction.files);
            if (uploadAction.target) console.log(`[DEBUG] To input:`, uploadAction.target);
            if (uploadAction.trigger) console.log(`[DEBUG] Via trigger:`, uploadAction.trigger);
            if (uploadAction.frame) console.log(`[DEBUG] In frame:`, uploadAction.frame);
          }
          const resolved = await resolveUploadFiles(uploadAction.files, {
            testFilePath,
            variables: context.variables,
          });
          try {
            const pwFiles = await toPlaywrightFiles(resolved);
            if (uploadAction.target) {
              const ctx = uploadAction.frame
                ? getActionContext(page, uploadAction.frame)
                : page;
              if (!uploadAction.frame) {
                await checkErrorIf(page, uploadAction.target, uploadAction.errorIf);
              }
              const handle = resolveLocatorInContext(ctx, uploadAction.target);
              await handle.setInputFiles(pwFiles);
            } else if (uploadAction.trigger) {
              const ctx = uploadAction.frame
                ? getActionContext(page, uploadAction.frame)
                : page;
              if (!uploadAction.frame) {
                await checkErrorIf(page, uploadAction.trigger, uploadAction.errorIf);
              }
              const triggerHandle = resolveLocatorInContext(ctx, uploadAction.trigger);
              const [chooser] = await Promise.all([
                page.waitForEvent('filechooser'),
                triggerHandle.click(),
              ]);
              await chooser.setFiles(pwFiles);
            }
          } finally {
            await cleanupResolvedFiles(resolved);
          }
          break;
        }
        case 'hover': {
          const hoverAction = action as Extract<Action, { type: 'hover' }>;
          if (debugMode) {
            console.log(`[DEBUG] Hovering element:`, hoverAction.target);
            if (hoverAction.frame) console.log(`[DEBUG] In frame:`, hoverAction.frame);
          }
          if (hoverAction.frame) {
            const frameContext = getActionContext(page, hoverAction.frame);
            const handle = resolveLocatorInContext(frameContext, hoverAction.target);
            await handle.hover();
          } else {
            await checkErrorIf(page, hoverAction.target, hoverAction.errorIf);
            const handle = resolveLocator(page, hoverAction.target);
            await handle.hover();
          }
          break;
        }
        case 'select': {
          const interpolated = interpolateVariables(action.value, context.variables);
          if (debugMode) console.log(`[DEBUG] Selecting: ${interpolated}`);
          await checkErrorIf(page, action.target, action.errorIf);
          const handle = resolveLocator(page, action.target);
          await handle.selectOption(interpolated);
          break;
        }
        case 'check': {
          if (debugMode) console.log(`[DEBUG] Checking:`, action.target);
          await checkErrorIf(page, action.target, action.errorIf);
          const handle = resolveLocator(page, action.target);
          await handle.check();
          break;
        }
        case 'uncheck': {
          if (debugMode) console.log(`[DEBUG] Unchecking:`, action.target);
          await checkErrorIf(page, action.target, action.errorIf);
          const handle = resolveLocator(page, action.target);
          await handle.uncheck();
          break;
        }
        case 'press': {
          const pressAction = action as Extract<Action, { type: 'press' }>;
          if (debugMode) {
            console.log(`[DEBUG] Pressing key: ${pressAction.key}`);
            if (pressAction.frame) console.log(`[DEBUG] In frame:`, pressAction.frame);
          }
          if (pressAction.frame) {
            const frameContext = getActionContext(page, pressAction.frame);
            if (pressAction.target) {
              const handle = resolveLocatorInContext(frameContext, pressAction.target);
              await handle.press(pressAction.key);
            } else {
              // For frame-scoped keyboard press without target, focus the frame first
              // by clicking inside it, then press the key
              await frameContext.locator('body').first().press(pressAction.key);
            }
          } else {
            if (pressAction.target) {
              await checkErrorIf(page, pressAction.target, pressAction.errorIf);
              const handle = resolveLocator(page, pressAction.target);
              await handle.press(pressAction.key);
            } else {
              await page.keyboard.press(pressAction.key);
            }
          }
          break;
        }
        case 'focus': {
          const focusAction = action as Extract<Action, { type: 'focus' }>;
          if (debugMode) {
            console.log(`[DEBUG] Focusing:`, focusAction.target);
            if (focusAction.frame) console.log(`[DEBUG] In frame:`, focusAction.frame);
          }
          if (focusAction.frame) {
            const frameContext = getActionContext(page, focusAction.frame);
            const handle = resolveLocatorInContext(frameContext, focusAction.target);
            await handle.focus();
          } else {
            await checkErrorIf(page, focusAction.target, focusAction.errorIf);
            const handle = resolveLocator(page, focusAction.target);
            await handle.focus();
          }
          break;
        }
        case 'assert': {
          const assertAction = action as Extract<Action, { type: 'assert' }>;
          if (debugMode) {
            console.log(`[DEBUG] Asserting element:`, assertAction.target);
            if (assertAction.value) {
              const interpolated = interpolateVariables(assertAction.value, context.variables);
              console.log(`[DEBUG] Expected text contains: ${interpolated}`);
            }
            if (assertAction.frame) console.log(`[DEBUG] In frame:`, assertAction.frame);
          }
          if (assertAction.frame) {
            const frameContext = getActionContext(page, assertAction.frame);
            const handle = resolveLocatorInContext(frameContext, assertAction.target);
            await handle.waitFor({ state: 'visible' });
            if (assertAction.value) {
              const interpolated = interpolateVariables(assertAction.value, context.variables);
              const text = (await handle.textContent())?.trim() ?? '';
              if (!text.includes(interpolated)) {
                throw new Error(
                  `Assertion failed: expected element text to include "${interpolated}", got "${text}"`,
                );
              }
            }
          } else {
            await checkErrorIf(page, assertAction.target, assertAction.errorIf);
            await runAssert(page, assertAction.target, assertAction.value, context);
          }
          break;
        }
        case 'wait': {
          const waitAction = action as Extract<Action, { type: 'wait' }>;
          if (debugMode && waitAction.frame) {
            console.log(`[DEBUG] Waiting in frame:`, waitAction.frame);
          }
          if (waitAction.frame && waitAction.target) {
            const frameContext = getActionContext(page, waitAction.frame);
            const handle = resolveLocatorInContext(frameContext, waitAction.target);
            await handle.waitFor({ state: 'visible', timeout: waitAction.timeout });
          } else {
            if (waitAction.target && waitAction.errorIf) {
              await checkErrorIf(page, waitAction.target, waitAction.errorIf);
            }
            await runWait(page, waitAction);
          }
          break;
        }
        case 'scroll':
          if (action.target && action.errorIf) {
            await checkErrorIf(page, action.target, action.errorIf);
          }
          await runScroll(page, action);
          break;
        case 'screenshot': {
          const ssAction = action as Extract<Action, { type: 'screenshot' }>;
          const waitBefore = ssAction.waitBefore ?? 500;
          if (waitBefore > 0) {
            if (debugMode) {
              console.log(`[DEBUG] Screenshot: waiting ${waitBefore}ms for visual stability`);
            }
            await page.waitForTimeout(waitBefore);
          }
          // Multi-viewport runs append a size suffix to the filename so the
          // outputs from different sizes don't overwrite each other.
          const screenshotName = screenshotSizeSuffix && ssAction.name
            ? ssAction.name.replace(/\.png$/, `-${screenshotSizeSuffix}.png`)
            : ssAction.name;
          extras.screenshotPath = await runScreenshot(page, screenshotName, screenshotDir, index, browserName);
          break;
        }
        case 'evaluate': {
          const evalAction = action as Extract<Action, { type: 'evaluate' }>;
          const waitBefore = evalAction.waitBefore ?? 500;
          if (waitBefore > 0) {
            if (debugMode) {
              console.log(`[DEBUG] Evaluate: waiting ${waitBefore}ms for visual stability`);
            }
            await page.waitForTimeout(waitBefore);
          }
          // Wait for page to settle
          const timing = getBrowserTimingConfig(browserName ?? 'chromium');
          await waitForPageStable(page, timing.screenshotNetworkIdleTimeout);
          // Take screenshot
          await ensureScreenshotDir(screenshotDir);
          const evalScreenshotPath = path.join(screenshotDir, `evaluate-step-${index + 1}.png`);
          const screenshotBuffer = await page.screenshot({
            path: evalScreenshotPath,
            fullPage: evalAction.fullPage ?? true,
          });
          // Interpolate expected values
          const expectedRaw = evalAction.expected;
          const expectedArray = Array.isArray(expectedRaw)
            ? expectedRaw.map((e) => interpolateVariables(e, context.variables))
            : [interpolateVariables(expectedRaw, context.variables)];
          // Run evaluation. For agent mode, pass the live Page so the agent's
          // tools (scroll, query_dom, accessibility_snapshot, etc.) can interact
          // with it, plus the workflow directory for resolving relative paths
          // in `tools: ./my-tools.ts`.
          const workflowDir = testFilePath ? path.dirname(testFilePath) : process.cwd();
          const evalResult = await evaluate({
            expected: expectedArray,
            mode: evalAction.mode ?? 'auto',
            regex: evalAction.regex ?? false,
            prompt: evalAction.prompt,
            confidence: evalAction.confidence ?? 60,
            screenshotBuffer,
            screenshotPath: evalScreenshotPath,
            aiConfig,
            page,
            maxSteps: evalAction.maxSteps,
            customToolsPath: evalAction.tools,
            workflowDir,
          });
          if (debugMode) {
            console.log(`[DEBUG] Evaluate result: ${evalResult.passed ? 'PASSED' : 'FAILED'} (${evalResult.mode})`);
            console.log(`[DEBUG] Reason: ${evalResult.reason}`);
            if (evalResult.ocrText) {
              console.log(`[DEBUG] OCR text (first 200 chars): ${evalResult.ocrText.slice(0, 200)}`);
            }
          }
          if (!evalResult.passed) {
            throw new Error(`Evaluate failed (${evalResult.mode} mode): ${evalResult.reason}`);
          }
          extras.screenshotPath = evalScreenshotPath;
          extras.logOutput = `Evaluate passed (${evalResult.mode}): ${evalResult.reason}`;
          break;
        }
        case 'setVar': {
          let value: string;
          if (action.value) {
            value = interpolateVariables(action.value, context.variables);
          } else if (action.from === 'response') {
            throw new Error('setVar from response not yet implemented');
          } else if (action.from === 'element') {
            throw new Error('setVar from element not yet implemented');
          } else if (action.from === 'email') {
            throw new Error('Use email.extractCode or email.extractLink instead');
          } else {
            throw new Error('setVar requires value or from');
          }
          context.variables.set(action.name, value);
          break;
        }
        case 'email.waitFor': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          const mailbox = interpolateVariables(action.mailbox, context.variables);
          context.lastEmail = await context.emailClient.waitForEmail(mailbox, {
            timeout: action.timeout,
            subjectContains: action.subjectContains,
          });
          break;
        }
        case 'email.extractCode': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          if (!context.lastEmail) {
            throw new Error('No email loaded - call email.waitFor first');
          }
          const code = context.emailClient.extractCode(
            context.lastEmail,
            action.pattern ? new RegExp(action.pattern) : undefined,
          );
          if (!code) {
            throw new Error('No code found in email');
          }
          context.variables.set(action.saveTo, code);
          break;
        }
        case 'email.extractLink': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          if (!context.lastEmail) {
            throw new Error('No email loaded - call email.waitFor first');
          }
          const link = context.emailClient.extractLink(
            context.lastEmail,
            action.pattern ? new RegExp(action.pattern) : undefined,
          );
          if (!link) {
            throw new Error('No link found in email');
          }
          context.variables.set(action.saveTo, link);
          break;
        }
        case 'email.clear': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          const mailbox = interpolateVariables(action.mailbox, context.variables);
          await context.emailClient.clearMailbox(mailbox);
          break;
        }
        case 'appwrite.verifyEmail': {
          if (!context.appwriteContext.userId) {
            throw new Error('No user tracked. appwrite.verifyEmail requires a user signup to have occurred first.');
          }
          if (!context.appwriteConfig?.apiKey) {
            throw new Error('appwrite.verifyEmail requires appwrite.apiKey in config');
          }
          const { Client, Users } = await import('node-appwrite');
          const client = new Client()
            .setEndpoint(context.appwriteConfig.endpoint)
            .setProject(context.appwriteConfig.projectId)
            .setKey(context.appwriteConfig.apiKey);
          const users = new Users(client);
          await users.updateEmailVerification(context.appwriteContext.userId, true);
          console.log(`Verified email for user ${context.appwriteContext.userId}`);
          break;
        }
        case 'debug': {
          console.log('[DEBUG] Pausing execution - Playwright Inspector will open');
          await page.pause();
          break;
        }
        case 'waitForSelector': {
          const wsAction = action as Extract<Action, { type: 'waitForSelector' }>;
          const timeout = wsAction.timeout ?? 30000;

          if (debugMode) {
            console.log(`[DEBUG] Waiting for element to be ${wsAction.state}:`, wsAction.target);
            if (wsAction.frame) console.log(`[DEBUG] In frame:`, wsAction.frame);
          }

          let handle: PWLocator;
          if (wsAction.frame) {
            const frameContext = getActionContext(page, wsAction.frame);
            handle = resolveLocatorInContext(frameContext, wsAction.target);
          } else {
            if (wsAction.errorIf) {
              await checkErrorIf(page, wsAction.target, wsAction.errorIf);
            }
            handle = resolveLocator(page, wsAction.target);
          }

          switch (wsAction.state) {
            case 'visible':
            case 'hidden':
            case 'attached':
            case 'detached':
              await handle.waitFor({ state: wsAction.state, timeout });
              break;
            case 'enabled':
              await waitForCondition(
                () => handle.isEnabled(),
                timeout,
                `Element did not become enabled within ${timeout}ms`,
                browserName,
              );
              break;
            case 'disabled':
              await waitForCondition(
                () => handle.isDisabled(),
                timeout,
                `Element did not become disabled within ${timeout}ms`,
                browserName,
              );
              break;
          }
          break;
        }
        case 'conditional': {
          const condAction = action as Extract<Action, { type: 'conditional' }>;
          const handle = resolveLocator(page, condAction.condition.target);
          let conditionMet = false;

          if (debugMode) {
            console.log(`[DEBUG] Checking condition ${condAction.condition.type}:`, condAction.condition.target);
          }

          try {
            switch (condAction.condition.type) {
              case 'exists':
                await handle.waitFor({ state: 'attached', timeout: 500 });
                conditionMet = true;
                break;
              case 'notExists':
                try {
                  await handle.waitFor({ state: 'detached', timeout: 500 });
                  conditionMet = true;
                } catch {
                  conditionMet = false;
                }
                break;
              case 'visible':
                conditionMet = await handle.isVisible();
                break;
              case 'hidden':
                conditionMet = !(await handle.isVisible());
                break;
            }
          } catch {
            // Element not found - condition is false unless we're checking for 'notExists'
            conditionMet = condAction.condition.type === 'notExists';
          }

          if (debugMode) {
            console.log(`[DEBUG] Condition result: ${conditionMet}`);
          }

          const stepsToRun = conditionMet ? condAction.then : (condAction.else ?? []);
          for (const [nestedIdx, nestedAction] of stepsToRun.entries()) {
            if (debugMode) {
              console.log(`[DEBUG] Executing nested step ${nestedIdx + 1}: ${nestedAction.type}`);
            }
            await executeActionWithRetry(page, nestedAction, index, options);
          }
          break;
        }
        case 'log': {
          const logAction = action as Extract<Action, { type: 'log' }>;
          const format = logAction.format ?? 'text';
          let logOutput: string;

          if (logAction.message) {
            // Static message - interpolate variables
            logOutput = interpolateVariables(logAction.message, context.variables);
            console.log(`[LOG] ${logOutput}`);
          } else if (logAction.eval) {
            // JS expression evaluation
            const interpolated = interpolateVariables(logAction.eval, context.variables);
            try {
              const result = await page.evaluate(interpolated);
              logOutput = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
              console.log(`[LOG eval] ${logOutput}`);
            } catch (evalError) {
              logOutput = `[eval error] ${evalError instanceof Error ? evalError.message : String(evalError)}`;
              console.log(`[LOG] ${logOutput}`);
            }
          } else if (logAction.target) {
            // Element content extraction
            const frameContext = getActionContext(page, logAction.frame);
            const handle = resolveLocatorInContext(frameContext, logAction.target);

            switch (format) {
              case 'html':
                logOutput = await handle.innerHTML();
                break;
              case 'json':
                // Try to parse element's text as JSON and pretty-print
                const text = await handle.textContent() ?? '';
                try {
                  logOutput = JSON.stringify(JSON.parse(text), null, 2);
                } catch {
                  logOutput = text;
                }
                break;
              case 'text':
              default:
                logOutput = await handle.textContent() ?? '';
                break;
            }
            console.log(`[LOG element] ${logOutput}`);
          } else {
            logOutput = '(no content)';
          }

          // Store log output in extras so it can be captured in reports
          extras.logOutput = logOutput;
          break;
        }
        case 'fail': {
          const failAction = action as Extract<Action, { type: 'fail' }>;
          throw new Error(failAction.message);
        }
        case 'waitForBranch': {
          const wfbAction = action as Extract<Action, { type: 'waitForBranch' }>;
          const handle = resolveLocator(page, wfbAction.target);
          const timeout = wfbAction.timeout ?? 30000;
          const state = wfbAction.state ?? 'visible';
          const pollInterval = wfbAction.pollInterval ?? 100;

          if (debugMode) {
            console.log(`[DEBUG] waitForBranch: Waiting for element to be ${state}, timeout: ${timeout}ms`);
          }

          let elementAppeared = false;
          const startTime = Date.now();

          // Polling loop - does NOT throw on timeout
          while (Date.now() - startTime < timeout) {
            try {
              switch (state) {
                case 'visible':
                  if (await handle.isVisible()) {
                    elementAppeared = true;
                  }
                  break;
                case 'attached':
                  if ((await handle.count()) > 0) {
                    elementAppeared = true;
                  }
                  break;
                case 'enabled':
                  if (await handle.isEnabled().catch(() => false)) {
                    elementAppeared = true;
                  }
                  break;
              }
            } catch {
              // Element not found yet, continue polling
            }

            if (elementAppeared) break;
            await page.waitForTimeout(pollInterval);
          }

          if (debugMode) {
            console.log(`[DEBUG] waitForBranch result: ${elementAppeared ? 'appeared' : 'timeout'}`);
          }

          // Determine which branch to execute
          const branchToExecute = elementAppeared ? wfbAction.onAppear : wfbAction.onTimeout;

          // If no branch defined (onTimeout omitted and timed out), silently continue
          if (!branchToExecute) {
            if (debugMode) {
              console.log(`[DEBUG] No branch to execute, continuing silently`);
            }
            break;
          }

          // Execute the branch
          if (Array.isArray(branchToExecute)) {
            // Inline actions - execute each action recursively
            for (const [nestedIdx, nestedAction] of branchToExecute.entries()) {
              if (debugMode) {
                console.log(`[DEBUG] Executing branch step ${nestedIdx + 1}: ${nestedAction.type}`);
              }
              await executeActionWithRetry(page, nestedAction, index, options);
            }
          } else {
            // Workflow file reference - load and execute workflow
            const { loadWorkflowDefinition, loadTestDefinition } = await import('../../core/loader.js');

            // Resolve relative to cwd
            const workflowPath = path.resolve(process.cwd(), branchToExecute.workflow);
            const workflowDir = path.dirname(workflowPath);

            if (debugMode) {
              console.log(`[DEBUG] Executing workflow: ${workflowPath}`);
            }

            const workflow = await loadWorkflowDefinition(workflowPath);

            // Merge variables from branch definition
            if (branchToExecute.variables) {
              for (const [key, value] of Object.entries(branchToExecute.variables)) {
                const interpolated = interpolateVariables(value, context.variables);
                context.variables.set(key, interpolated);
              }
            }

            // Execute each test reference in the workflow
            for (const testRef of workflow.tests) {
              const testFilePath = path.resolve(workflowDir, testRef.file);

              if (debugMode) {
                console.log(`[DEBUG] Loading test from workflow: ${testFilePath}`);
              }

              const test = await loadTestDefinition(testFilePath);

              // Initialize test variables
              if (test.variables) {
                for (const [key, value] of Object.entries(test.variables)) {
                  const interpolated = interpolateVariables(value, context.variables);
                  context.variables.set(key, interpolated);
                }
              }

              // Execute each step in the test
              for (const [testStepIdx, testAction] of test.steps.entries()) {
                await executeActionWithRetry(page, testAction, testStepIdx, options);
              }
            }
          }
          break;
        }
        case 'saveStorageState': {
          const saveAction = action as Extract<Action, { type: 'saveStorageState' }>;
          if (saveAction.path) {
            const resolvedPath = interpolateVariables(saveAction.path, context.variables);
            const baseDir = testFilePath ? path.dirname(testFilePath) : process.cwd();
            const absPath = path.isAbsolute(resolvedPath) ? resolvedPath : path.resolve(baseDir, resolvedPath);
            await page.context().storageState({ path: absPath });
            if (debugMode) {
              console.log(`[DEBUG] Saved storage state to ${absPath}`);
            }
          } else if (saveAction.handler) {
            const resolvedHandler = interpolateVariables(saveAction.handler, context.variables);
            const baseDir = testFilePath ? path.dirname(testFilePath) : process.cwd();
            const absPath = path.isAbsolute(resolvedHandler) ? resolvedHandler : path.resolve(baseDir, resolvedHandler);
            let loadPath = absPath;
            if (absPath.endsWith('.ts')) {
              const jsPath = absPath.replace(/\.ts$/, '.js');
              try {
                await fs.access(jsPath);
                loadPath = jsPath;
              } catch {
                // Fall through to direct .ts import (requires tsx/ts-node in user's env)
              }
            }
            const mod = await import(`${loadPath}?t=${Date.now()}`);
            const fn = (mod.default ?? mod) as (ctx: {
              page: typeof page;
              context: ReturnType<typeof page.context>;
              variables: Map<string, string>;
            }) => Promise<void> | void;
            if (typeof fn !== 'function') {
              throw new Error(`saveStorageState handler at ${resolvedHandler} did not export a default function`);
            }
            await fn({
              page,
              context: page.context(),
              variables: context.variables,
            });
            if (debugMode) {
              console.log(`[DEBUG] Ran custom saveStorageState handler: ${resolvedHandler}`);
            }
          } else {
            throw new Error('saveStorageState requires either `path` or `handler` (schema should have caught this)');
          }
          break;
        }
        case 'assertCookies': {
          const cookieAction = action as Extract<Action, { type: 'assertCookies' }>;
          const filterUrl = cookieAction.url
            ? interpolateVariables(cookieAction.url, context.variables)
            : undefined;
          const jar = await page.context().cookies(filterUrl);
          const names = new Set(jar.map((c) => c.name));
          const problems: string[] = [];

          if (cookieAction.has) {
            for (const name of cookieAction.has) {
              if (!names.has(name)) problems.push(`expected cookie "${name}" to be present`);
            }
          }
          if (cookieAction.not) {
            for (const name of cookieAction.not) {
              if (names.has(name)) problems.push(`expected cookie "${name}" to be absent`);
            }
          }
          if (cookieAction.match) {
            for (const [name, pattern] of Object.entries(cookieAction.match)) {
              const c = jar.find((entry) => entry.name === name);
              if (!c) {
                problems.push(`expected cookie "${name}" to be present (for value match)`);
                continue;
              }
              const matcher = compileMatcher(interpolateVariables(pattern, context.variables), 'substr');
              if (!matcher(c.value)) {
                problems.push(`cookie "${name}" value "${c.value}" did not match pattern "${pattern}"`);
              }
            }
          }
          if (problems.length > 0) {
            throw new Error(`assertCookies failed:\n  - ${problems.join('\n  - ')}\n  (cookies seen: ${[...names].join(', ') || '<none>'})`);
          }
          break;
        }
        case 'expectResponse': {
          if (!responseLog) {
            throw new Error('expectResponse requires a responseLog to be attached (executor wiring issue)');
          }
          const respAction = action as Extract<Action, { type: 'expectResponse' }>;
          const urlPattern = interpolateVariables(respAction.url, context.variables);
          const urlMatch = compileMatcher(urlPattern, 'url');
          const headerMatchers = respAction.headers
            ? Object.entries(respAction.headers).map(([name, pattern]) => ({
                name: name.toLowerCase(),
                test: compileMatcher(interpolateVariables(pattern, context.variables), 'substr'),
                pattern,
              }))
            : [];
          const expectedStatus = respAction.status;

          let sinceTs: number;
          if (respAction.since === 'testStart') {
            sinceTs = 0;
          } else if (typeof respAction.since === 'number') {
            sinceTs = respAction.since;
          } else {
            sinceTs = stepStartTs ?? 0;
          }

          const timeout = respAction.timeout ?? 5000;
          const deadline = Date.now() + timeout;

          const findMatch = () => {
            for (const entry of responseLog.snapshot()) {
              if (entry.ts < sinceTs) continue;
              if (!urlMatch(entry.url)) continue;
              if (expectedStatus !== undefined && entry.status !== expectedStatus) continue;
              let headersOk = true;
              for (const h of headerMatchers) {
                const value = entry.headers[h.name];
                if (value === undefined || !h.test(value)) {
                  headersOk = false;
                  break;
                }
              }
              if (headersOk) return entry;
            }
            return null;
          };

          let match = findMatch();
          while (!match && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            match = findMatch();
          }

          if (!match) {
            const recent = responseLog.snapshot().slice(-5).map((e) => `${e.status} ${e.url}`).join('\n  ');
            throw new Error(
              `expectResponse timed out after ${timeout}ms.\n` +
              `  url pattern: ${urlPattern}\n` +
              (expectedStatus !== undefined ? `  expected status: ${expectedStatus}\n` : '') +
              (headerMatchers.length > 0 ? `  expected headers: ${headerMatchers.map((h) => `${h.name}=${h.pattern}`).join(', ')}\n` : '') +
              `  recent responses:\n  ${recent || '<none>'}`
            );
          }

          if (debugMode) {
            console.log(`[DEBUG] expectResponse matched: ${match.status} ${match.url}`);
          }
          break;
        }
        case 'measureElement': {
          const meAction = action as Extract<Action, { type: 'measureElement' }>;
          if (!measurements) {
            throw new Error('measureElement requires a measurements map in ExecuteActionOptions (executor wiring issue).');
          }
          if (meAction.waitBefore && meAction.waitBefore > 0) {
            await page.waitForTimeout(meAction.waitBefore);
          }
          const locator = page.locator(meAction.selector).first();
          const box = await locator.boundingBox();
          if (!box) {
            throw new Error(
              `measureElement "${meAction.name}": locator "${meAction.selector}" returned no bounding box ` +
              `(element detached, off-screen, or display:none).`,
            );
          }
          const styleValues: Record<string, string> = {};
          if (meAction.styles && meAction.styles.length > 0) {
            for (const prop of meAction.styles) {
              styleValues[prop] = await locator.evaluate(
                (el, p) => window.getComputedStyle(el).getPropertyValue(p),
                prop,
              );
            }
          }
          let pixels: Buffer | undefined;
          if (meAction.pixels) {
            pixels = await locator.screenshot();
          }
          measurements.set(meAction.name, { box, styles: styleValues, pixels });
          const summary = `measureElement "${meAction.name}": box=${box.width.toFixed(1)}x${box.height.toFixed(1)}@(${box.x.toFixed(1)},${box.y.toFixed(1)})${
            Object.keys(styleValues).length ? ` styles={${Object.entries(styleValues).map(([k, v]) => `${k}:${v}`).join(', ')}}` : ''
          }${pixels ? ` pixels=${pixels.byteLength}B` : ''}`;
          if (debugMode) {
            console.log(`[DEBUG] ${summary}`);
          }
          extras.logOutput = summary;
          break;
        }
        case 'assertElement': {
          const aeAction = action as Extract<Action, { type: 'assertElement' }>;
          if (!measurements) {
            throw new Error('assertElement requires a measurements map in ExecuteActionOptions (executor wiring issue).');
          }

          const locator = page.locator(aeAction.selector).first();
          const currentBox = await locator.boundingBox();
          if (!currentBox) {
            throw new Error(
              `assertElement: locator "${aeAction.selector}" returned no bounding box ` +
              `(element detached, off-screen, or display:none).`,
            );
          }

          let snapshot: ElementMeasurement | undefined;
          let expectedBox: Partial<{ x: number; y: number; width: number; height: number }> = {};
          let expectedStyles: Record<string, string> = {};
          if (aeAction.against) {
            snapshot = measurements.get(aeAction.against);
            if (!snapshot) {
              throw new Error(
                `assertElement: no measurement found for name "${aeAction.against}". ` +
                `Available: ${[...measurements.keys()].join(', ') || '<none>'}.`,
              );
            }
            expectedBox = snapshot.box;
            expectedStyles = snapshot.styles;
          } else if (aeAction.expected) {
            expectedBox = aeAction.expected;
            expectedStyles = aeAction.expected.styles ?? {};
          }

          const dx = currentBox.x - (expectedBox.x ?? currentBox.x);
          const dy = currentBox.y - (expectedBox.y ?? currentBox.y);
          const dw = currentBox.width - (expectedBox.width ?? currentBox.width);
          const dh = currentBox.height - (expectedBox.height ?? currentBox.height);

          const fmtBox = (b: typeof currentBox) => `${b.width.toFixed(1)}x${b.height.toFixed(1)}@(${b.x.toFixed(1)},${b.y.toFixed(1)})`;
          const ctxLine = aeAction.against
            ? `against "${aeAction.against}"=${fmtBox(snapshot!.box)}, current=${fmtBox(currentBox)}`
            : `against expected=${JSON.stringify(expectedBox)}, current=${fmtBox(currentBox)}`;

          switch (aeAction.comparator) {
            case 'equals': {
              const tol = aeAction.tolerance ?? 0;
              const fail = (label: string, actual: number, expected: number | undefined) =>
                expected !== undefined && Math.abs(actual - expected) > tol;
              if (
                fail('x', currentBox.x, expectedBox.x) ||
                fail('y', currentBox.y, expectedBox.y) ||
                fail('width', currentBox.width, expectedBox.width) ||
                fail('height', currentBox.height, expectedBox.height)
              ) {
                throw new Error(`assertElement equals failed (tolerance=${tol}px): ${ctxLine}`);
              }
              break;
            }
            case 'withinTolerance': {
              const tol = aeAction.tolerance ?? 1;
              const fail = (actual: number, expected: number | undefined) =>
                expected !== undefined && Math.abs(actual - expected) > tol;
              if (
                fail(currentBox.x, expectedBox.x) ||
                fail(currentBox.y, expectedBox.y) ||
                fail(currentBox.width, expectedBox.width) ||
                fail(currentBox.height, expectedBox.height)
              ) {
                throw new Error(`assertElement withinTolerance failed (±${tol}px): ${ctxLine}`);
              }
              break;
            }
            case 'moved': {
              const minD = aeAction.minDelta ?? 0.5;
              const axis = aeAction.axis ?? 'both';
              const movedX = Math.abs(dx) >= minD;
              const movedY = Math.abs(dy) >= minD;
              const ok = axis === 'x' ? movedX : axis === 'y' ? movedY : (movedX || movedY);
              if (!ok) {
                throw new Error(`assertElement moved failed (axis=${axis}, minDelta=${minD}px, dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}): ${ctxLine}`);
              }
              break;
            }
            case 'grew': {
              const minD = aeAction.minDelta ?? 0.5;
              const axis = aeAction.axis ?? 'both';
              const grewW = dw >= minD;
              const grewH = dh >= minD;
              const ok = axis === 'width' ? grewW : axis === 'height' ? grewH : (grewW || grewH);
              if (!ok) {
                throw new Error(`assertElement grew failed (axis=${axis}, minDelta=${minD}px, dw=${dw.toFixed(2)}, dh=${dh.toFixed(2)}): ${ctxLine}`);
              }
              break;
            }
            case 'shrank': {
              const minD = aeAction.minDelta ?? 0.5;
              const axis = aeAction.axis ?? 'both';
              const shrankW = dw <= -minD;
              const shrankH = dh <= -minD;
              const ok = axis === 'width' ? shrankW : axis === 'height' ? shrankH : (shrankW || shrankH);
              if (!ok) {
                throw new Error(`assertElement shrank failed (axis=${axis}, minDelta=${minD}px, dw=${dw.toFixed(2)}, dh=${dh.toFixed(2)}): ${ctxLine}`);
              }
              break;
            }
            case 'delta': {
              const constraints = aeAction.delta ?? {};
              const deltas: Record<string, number> = { x: dx, y: dy, width: dw, height: dh };
              const re = /^\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/;
              for (const [field, expr] of Object.entries(constraints)) {
                if (!(field in deltas)) {
                  throw new Error(`assertElement delta: unknown field "${field}" (allowed: x, y, width, height).`);
                }
                const m = re.exec(expr);
                if (!m) {
                  throw new Error(`assertElement delta: constraint "${field}: ${expr}" is not a valid comparison (e.g. ">0", ">=4", "==0").`);
                }
                const [, op, numStr] = m;
                const num = Number(numStr);
                const actual = deltas[field];
                const ok =
                  op === '==' ? actual === num :
                  op === '!=' ? actual !== num :
                  op === '>' ? actual > num :
                  op === '>=' ? actual >= num :
                  op === '<' ? actual < num :
                  /* <= */ actual <= num;
                if (!ok) {
                  throw new Error(`assertElement delta failed: ${field} delta=${actual.toFixed(2)} does not satisfy "${expr}". ${ctxLine}`);
                }
              }
              break;
            }
            case 'looksLike':
            case 'looksDifferent': {
              if (!snapshot?.pixels) {
                throw new Error(
                  `assertElement ${aeAction.comparator}: snapshot "${aeAction.against}" was not captured with pixels: true. ` +
                  `Set pixels: true on the matching measureElement step.`,
                );
              }
              const currentPng = await locator.screenshot();
              const { diffPngBuffers, PixelDiffSizeError } = await import('./pixelDiff.js');
              let diff;
              try {
                diff = diffPngBuffers(currentPng, snapshot.pixels, {
                  threshold: aeAction.diffThreshold ?? 0.1,
                });
              } catch (err) {
                if (err instanceof PixelDiffSizeError) {
                  if (aeAction.comparator === 'looksDifferent') {
                    extras.logOutput = `assertElement looksDifferent: dimensions changed (${err.aWidth}x${err.aHeight} vs ${err.bWidth}x${err.bHeight}) — counted as different.`;
                    break;
                  }
                  throw new Error(
                    `assertElement looksLike failed: ${err.message}`,
                  );
                }
                throw err;
              }
              const maxRatio = aeAction.maxDiffRatio ?? 0.01;
              const looksSame = diff.ratio <= maxRatio;
              if (aeAction.saveDiff) {
                const diffPath = path.isAbsolute(aeAction.saveDiff)
                  ? aeAction.saveDiff
                  : path.resolve(testFilePath ? path.dirname(testFilePath) : process.cwd(), aeAction.saveDiff);
                await fs.mkdir(path.dirname(diffPath), { recursive: true });
                await fs.writeFile(diffPath, diff.diffPng);
              }
              if (aeAction.comparator === 'looksLike' && !looksSame) {
                throw new Error(
                  `assertElement looksLike failed: ${diff.diffPixels}/${diff.totalPixels} pixels differ ` +
                  `(ratio ${(diff.ratio * 100).toFixed(2)}% > maxDiffRatio ${(maxRatio * 100).toFixed(2)}%). ` +
                  `${ctxLine}${aeAction.saveDiff ? ` (diff written to ${aeAction.saveDiff})` : ''}`,
                );
              }
              if (aeAction.comparator === 'looksDifferent' && looksSame) {
                throw new Error(
                  `assertElement looksDifferent failed: only ${diff.diffPixels}/${diff.totalPixels} pixels differ ` +
                  `(ratio ${(diff.ratio * 100).toFixed(2)}% ≤ maxDiffRatio ${(maxRatio * 100).toFixed(2)}%). ` +
                  `${ctxLine}`,
                );
              }
              extras.logOutput = `assertElement ${aeAction.comparator}: ${diff.diffPixels}/${diff.totalPixels} pixels differ (ratio ${(diff.ratio * 100).toFixed(2)}%)`;
              break;
            }
          }

          if (aeAction.styles && aeAction.styles.length > 0) {
            const problems: string[] = [];
            for (const a of aeAction.styles) {
              const actualValue = await locator.evaluate(
                (el, p) => window.getComputedStyle(el).getPropertyValue(p),
                a.property,
              );
              const ok = evaluateStyleAssertion(actualValue, a.op, a.value);
              if (!ok) {
                problems.push(`${a.property} ${a.op} "${a.value}" (actual: "${actualValue}")`);
              }
            }
            if (problems.length > 0) {
              throw new Error(`assertElement style assertions failed:\n  - ${problems.join('\n  - ')}`);
            }
          }

          if (!extras.logOutput) {
            extras.logOutput = `assertElement ${aeAction.comparator}: ${ctxLine}`;
          }
          // Snapshot styles round-trip: if `expected.styles` was given, verify them too.
          if (aeAction.expected?.styles) {
            const problems: string[] = [];
            for (const [prop, exp] of Object.entries(aeAction.expected.styles)) {
              const actualValue = await locator.evaluate(
                (el, p) => window.getComputedStyle(el).getPropertyValue(p),
                prop,
              );
              if (actualValue !== exp) {
                problems.push(`${prop}: expected "${exp}", got "${actualValue}"`);
              }
            }
            if (problems.length > 0) {
              throw new Error(`assertElement expected.styles failed:\n  - ${problems.join('\n  - ')}`);
            }
          }
          // Same for snapshot.styles when comparator is equals/withinTolerance and we're comparing
          // against a snapshot: each captured style must still match.
          if (
            snapshot &&
            (aeAction.comparator === 'equals' || aeAction.comparator === 'withinTolerance') &&
            Object.keys(expectedStyles).length > 0
          ) {
            const problems: string[] = [];
            for (const [prop, exp] of Object.entries(expectedStyles)) {
              const actualValue = await locator.evaluate(
                (el, p) => window.getComputedStyle(el).getPropertyValue(p),
                prop,
              );
              if (actualValue !== exp) {
                problems.push(`${prop}: snapshot "${exp}", current "${actualValue}"`);
              }
            }
            if (problems.length > 0) {
              throw new Error(`assertElement snapshot styles drift:\n  - ${problems.join('\n  - ')}`);
            }
          }
          break;
        }
        default:
          throw new Error(`Unsupported action type: ${(action as Action).type}`);
      }

      const trackedPayload = buildTrackPayload(extras as Record<string, unknown>);
      if (trackedPayload) {
        await trackResource(trackedPayload);
      }

      // Success - break out of retry loop
      return extras;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Try AI-assisted healing if enabled (before interactive mode)
      if (healing?.enabled && aiConfig && hasTarget(action)) {
        const maxAttempts = healing.maxAttempts ?? 3;
        console.log(`\n🔧 Attempting AI-assisted healing (max ${maxAttempts} attempts)...`);

        try {
          const pageContent = await page.content();
          const healingContext: HealingContext = {
            page,
            action,
            error: error.message,
            pageContent,
          };

          const healingResult = await runHealingAgent(healingContext, aiConfig, maxAttempts);

          if (healingResult.success && healingResult.fixedAction) {
            console.log(`✅ AI found fix: ${healingResult.explanation}`);

            // Retry with fixed action (disable healing to prevent infinite loops)
            const fixedExtras = await executeActionWithRetry(page, healingResult.fixedAction, index, {
              ...options,
              healing: { enabled: false },
            });
            return fixedExtras;
          } else {
            console.log(`❌ AI healing failed: ${healingResult.explanation}`);
          }
        } catch (healingError) {
          console.log(`❌ AI healing error: ${healingError instanceof Error ? healingError.message : String(healingError)}`);
        }
      }

      if (interactive && aiConfig && hasTarget(action)) {
        const choice = await handleInteractiveError(page, action, error, screenshotDir, index, aiConfig);

        switch (choice) {
          case 'retry':
            console.log('Retrying with AI suggestion...\n');
            // Note: In a full implementation, we would modify the action.target with the suggestion
            // For now, just retry with the same selector
            continue;
          case 'skip':
            console.log('Skipping step...\n');
            return extras;
          case 'debug':
            console.log('Opening Playwright Inspector...\n');
            await page.pause();
            continue;
          case 'abort':
          default:
            throw error;
        }
      }

      // Non-interactive mode or debug mode - handle normally
      if (debugMode) {
        console.error(`[DEBUG] Action failed: ${error.message}`);
        console.log('[DEBUG] Opening Playwright Inspector for debugging...');
        await page.pause();
      }

      throw error;
    }
  }
}

function hasTarget(action: Action): boolean {
  return 'target' in action && action.target !== undefined;
}

export const runWebTest = async (
  test: TestDefinition,
  options: WebRunOptions = {},
): Promise<WebRunResult> => {
  if (test.platform !== 'web') {
    throw new Error(`runWebTest only supports web platform, received ${test.platform}`);
  }

  const browserName = options.browser ?? 'chromium';
  const headless = !(options.headed ?? false);
  const screenshotDir = options.screenshotDir ?? defaultScreenshotDir;
  const defaultTimeout = options.defaultTimeoutMs ?? 30000;

  // Check if tracking is already set up by CLI
  const trackingAlreadySetUp = options.skipTrackingSetup ||
    (process.env.INTELLITESTER_TRACKING_OWNER === 'cli');

  let ownsTracking = false;
  let trackingServer: TrackingServer | null = null;
  let fileTracking: Awaited<ReturnType<typeof initFileTracking>> | null = null;
  const sessionId = options.sessionId ?? crypto.randomUUID();

  if (!trackingAlreadySetUp) {
    ownsTracking = true;
    // Start tracking server for SSR resource tracking
    trackingServer = new TrackingServer();
    await trackingServer.start();

    // Set env vars so the app can track resources
    process.env.INTELLITESTER_SESSION_ID = sessionId;
    process.env.INTELLITESTER_TRACK_URL = `http://localhost:${trackingServer.port}`;
    fileTracking = await initFileTracking({
      sessionId,
      trackDir: options.trackDir,
      cleanupConfig: test.config?.appwrite?.cleanup ? {
        provider: 'appwrite',
        scanUntracked: true,
        appwrite: {
          endpoint: test.config.appwrite.endpoint,
          projectId: test.config.appwrite.projectId,
          apiKey: test.config.appwrite.apiKey,
          cleanupOnFailure: test.config.appwrite.cleanupOnFailure,
        },
      } : undefined,
      providerConfig: test.config?.appwrite ? {
        provider: 'appwrite',
        endpoint: test.config.appwrite.endpoint,
        projectId: test.config.appwrite.projectId,
        apiKey: test.config.appwrite.apiKey,
      } : undefined,
    });
    process.env.INTELLITESTER_TRACK_FILE = fileTracking.trackFile;
  } else {
    console.log('Using existing tracking setup (owned by CLI)');
  }

  // Start webServer if configured (unless CLI already started it)
  if (options.webServer && !options.skipWebServerStart) {
    const requiresTrackingEnv = Boolean(
      test.config?.appwrite?.cleanup || test.config?.appwrite?.cleanupOnFailure
    );
    const wsEntries = Array.isArray(options.webServer) ? options.webServer : [options.webServer];
    const userExplicitlySetReuse = wsEntries.some((e) => e.reuseExistingServer !== undefined);
    const shouldForceNoReuse = ownsTracking && requiresTrackingEnv && !userExplicitlySetReuse;
    if (shouldForceNoReuse) {
      console.log('[Intellitester] Appwrite cleanup enabled; restarting server to inject tracking env.');
    }
    const normalized = wsEntries.map((entry) => ({
      ...entry,
      ...(shouldForceNoReuse ? { reuseExistingServer: false } : {}),
    }));
    await webServerManager.start(normalized.length === 1 ? normalized[0] : normalized);
  } else if (options.skipWebServerStart) {
    console.log('Using existing web server (owned by CLI)');
  }

  // Handle Ctrl+C and termination signals
  const cleanup = () => {
    if (ownsTracking) {
      trackingServer?.stop();
      webServerManager.kill();
      if (fileTracking) {
        void fileTracking.stop();
      }
      delete process.env.INTELLITESTER_TRACK_FILE;
    }
    process.exit(1);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Launch local browser
  console.log(`Launching ${browserName}${headless ? ' (headless)' : ' (visible)'}...`);
  const browser = await getBrowser(browserName).launch(getBrowserLaunchOptions({ headless, browser: browserName }));
  console.log(`Browser launched successfully`);

  // Determine viewport sizes to test
  const sizesToTest: Array<{ size: string; viewport: { width: number; height: number } }> = [];
  if (options.testSizes && options.testSizes.length > 0) {
    for (const size of options.testSizes) {
      const viewport = parseViewportSize(size);
      if (!viewport) {
        throw new Error(
          `Invalid viewport size: "${size}". Use predefined sizes (xs, sm, md, lg, xl) or "WxH" format (e.g., "1920x1080").`
        );
      }
      sizesToTest.push({ size, viewport });
    }
  } else {
    // Default: single run at 1920x1080
    sizesToTest.push({ size: 'default', viewport: { width: 1920, height: 1080 } });
  }

  const allResults: StepResult[] = [];
  let overallFailed = false;
  let lastExecutionContext: ExecutionContext | null = null;

  const debugMode = options.debug ?? false;
  const interactive = options.interactive ?? false;

  // Loop over each viewport size
  for (const { size, viewport } of sizesToTest) {
    if (sizesToTest.length > 1) {
      console.log(`Testing at viewport: ${size} (${viewport.width}x${viewport.height})`);
    }

    const browserContext = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      ...(options.storageState ? { storageState: options.storageState } : {}),
    });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(defaultTimeout);

    // Network response log for `expectResponse` action (bounded ring buffer).
    const responseLog = new ResponseLog();
    responseLog.attach(page);
    let lastStepEndTs = Date.now();

    // Initialize execution context with variables
    const executionContext: ExecutionContext = {
      variables: new Map<string, string>(),
      lastEmail: null,
      emailClient: null,
      appwriteContext: createTestContext(),
      appwriteConfig: test.config?.appwrite ? {
        endpoint: test.config.appwrite.endpoint,
        projectId: test.config.appwrite.projectId,
        apiKey: test.config.appwrite.apiKey,
      } : undefined,
    };

    // Initialize email client if configured
    if (test.config?.email) {
      const emailEndpoint = test.config.email.endpoint ?? process.env.INBUCKET_URL;
      if (!emailEndpoint) {
        throw new Error('Email testing requires endpoint in config or INBUCKET_URL env var');
      }
      executionContext.emailClient = new InbucketClient({
        endpoint: emailEndpoint,
      });
    }

    // Set up network interception for Appwrite API responses
    page.on('response', async (response) => {
      const url = response.url();
      const method = response.request().method();

      try {
        // Handle POST requests (resource creation)
        if (method === 'POST') {
          // User created
          if (APPWRITE_PATTERNS.userCreate.test(url)) {
            const data = await response.json();
            executionContext.appwriteContext.userId = data.$id;
            executionContext.appwriteContext.userEmail = data.email;
            return;
          }

          // Row created
          const rowMatch = url.match(APPWRITE_PATTERNS.rowCreate);
          if (rowMatch) {
            const data = await response.json();
            executionContext.appwriteContext.resources.push({
              type: 'row',
              id: data.$id,
              databaseId: rowMatch[1],
              tableId: rowMatch[2],
              createdAt: new Date().toISOString(),
            });
            return;
          }

          // File created
          const fileMatch = url.match(APPWRITE_PATTERNS.fileCreate);
          if (fileMatch) {
            const data = await response.json();
            executionContext.appwriteContext.resources.push({
              type: 'file',
              id: data.$id,
              bucketId: fileMatch[1],
              createdAt: new Date().toISOString(),
            });
            return;
          }

          // Team created
          const teamMatch = url.match(APPWRITE_PATTERNS.teamCreate);
          if (teamMatch) {
            const data = await response.json();
            executionContext.appwriteContext.resources.push({
              type: 'team',
              id: data.$id,
              createdAt: new Date().toISOString(),
            });
            return;
          }

          // Membership created
          const membershipMatch = url.match(APPWRITE_PATTERNS.membershipCreate);
          if (membershipMatch) {
            const data = await response.json();
            executionContext.appwriteContext.resources.push({
              type: 'membership',
              id: data.$id,
              teamId: membershipMatch[1],
              createdAt: new Date().toISOString(),
            });
            return;
          }

          // Message created
          const messageMatch = url.match(APPWRITE_PATTERNS.messageCreate);
          if (messageMatch) {
            const data = await response.json();
            executionContext.appwriteContext.resources.push({
              type: 'message',
              id: data.$id,
              createdAt: new Date().toISOString(),
            });
            return;
          }
        }

        // Handle PUT/PATCH requests (resource updates)
        if (method === 'PUT' || method === 'PATCH') {
          // Row updated
          const rowUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.rowUpdate);
          if (rowUpdateMatch) {
            const resourceId = rowUpdateMatch[3];
            const existingResource = executionContext.appwriteContext.resources.find(
              r => r.type === 'row' && r.id === resourceId
            );
            if (!existingResource) {
              // Resource was updated but not created in this test - track it for potential cleanup
              executionContext.appwriteContext.resources.push({
                type: 'row',
                id: resourceId,
                databaseId: rowUpdateMatch[1],
                tableId: rowUpdateMatch[2],
                createdAt: new Date().toISOString(),
              });
            }
            return;
          }

          // File updated
          const fileUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.fileUpdate);
          if (fileUpdateMatch) {
            const resourceId = fileUpdateMatch[2];
            const existingResource = executionContext.appwriteContext.resources.find(
              r => r.type === 'file' && r.id === resourceId
            );
            if (!existingResource) {
              // Resource was updated but not created in this test - track it for potential cleanup
              executionContext.appwriteContext.resources.push({
                type: 'file',
                id: resourceId,
                bucketId: fileUpdateMatch[1],
                createdAt: new Date().toISOString(),
              });
            }
            return;
          }

          // Team updated
          const teamUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.teamUpdate);
          if (teamUpdateMatch) {
            const resourceId = teamUpdateMatch[1];
            const existingResource = executionContext.appwriteContext.resources.find(
              r => r.type === 'team' && r.id === resourceId
            );
            if (!existingResource) {
              // Resource was updated but not created in this test - track it for potential cleanup
              executionContext.appwriteContext.resources.push({
                type: 'team',
                id: resourceId,
                createdAt: new Date().toISOString(),
              });
            }
            return;
          }
        }

        // Handle DELETE requests (mark resources as deleted)
        if (method === 'DELETE') {
          // Row deleted
          const rowDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.rowDelete);
          if (rowDeleteMatch) {
            const resourceId = rowDeleteMatch[3];
            const resource = executionContext.appwriteContext.resources.find(
              r => r.type === 'row' && r.id === resourceId
            );
            if (resource) {
              resource.deleted = true;
            }
            return;
          }

          // File deleted
          const fileDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.fileDelete);
          if (fileDeleteMatch) {
            const resourceId = fileDeleteMatch[2];
            const resource = executionContext.appwriteContext.resources.find(
              r => r.type === 'file' && r.id === resourceId
            );
            if (resource) {
              resource.deleted = true;
            }
            return;
          }

          // Team deleted
          const teamDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.teamDelete);
          if (teamDeleteMatch) {
            const resourceId = teamDeleteMatch[1];
            const resource = executionContext.appwriteContext.resources.find(
              r => r.type === 'team' && r.id === resourceId
            );
            if (resource) {
              resource.deleted = true;
            }
            return;
          }

          // Membership deleted
          const membershipDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.membershipDelete);
          if (membershipDeleteMatch) {
            const resourceId = membershipDeleteMatch[2];
            const resource = executionContext.appwriteContext.resources.find(
              r => r.type === 'membership' && r.id === resourceId
            );
            if (resource) {
              resource.deleted = true;
            }
            return;
          }
        }
      } catch {
        // Ignore parse errors for non-JSON responses
      }
    });

    // Initialize variables from test definition
    if (test.variables) {
      for (const [key, value] of Object.entries(test.variables)) {
        // Interpolate variable values to handle nested {{uuid}}
        const interpolated = interpolateVariables(value, executionContext.variables);
        executionContext.variables.set(key, interpolated);
      }
    }

    const sizeResults: StepResult[] = [];
    const measurements = new Map<string, ElementMeasurement>();

    let _sizeTestFailed = false;

    try {
      for (let index = 0; index < test.steps.length; index++) {
        // ts of when this iteration began == when the previous step ended.
        // Captured once at the top so every handler sees a stable value within
        // this iteration. On the first iteration this equals the test start ts.
        lastStepEndTs = Date.now();
        const action = test.steps[index];
        if (debugMode) {
          console.log(`[DEBUG] Executing step ${index + 1}: ${action.type}`);
        }
        safeCallback('onStepStart', options.onStepStart
          ? () => options.onStepStart!({ action, index, total: test.steps.length })
          : undefined);

        // Merge server-tracked resources before each action (only if we own tracking)
        const serverResources = trackingServer?.getResources(sessionId) ?? [];
        for (const resource of serverResources) {
          // Check for tracked users
          if (resource.type === 'user' && !executionContext.appwriteContext.userId) {
            executionContext.appwriteContext.userId = resource.id;
          }
          // Add to resources if not already tracked (only for known types)
          const knownTypes = ['row', 'file', 'user', 'team', 'membership', 'message'] as const;
          if (knownTypes.includes(resource.type as any)) {
            const exists = executionContext.appwriteContext.resources.some(
              r => r.type === resource.type && r.id === resource.id
            );
            if (!exists) {
              executionContext.appwriteContext.resources.push({
                type: resource.type as TrackedResource['type'],
                id: resource.id,
                databaseId: resource.databaseId as string | undefined,
                tableId: resource.tableId as string | undefined,
                bucketId: resource.bucketId as string | undefined,
                teamId: resource.teamId as string | undefined,
                createdAt: resource.createdAt || new Date().toISOString(),
              });
            }
          }
        }

        try {
          const stepStartTs = lastStepEndTs;
          const actionExtras = await executeActionWithRetry(page, action, index, {
            baseUrl: options.baseUrl ?? test.config?.web?.baseUrl,
            context: executionContext,
            screenshotDir,
            debugMode,
            interactive,
            aiConfig: options.aiConfig,
            browserName,
            healing: options.healing,
            testFilePath: options.testFilePath,
            responseLog,
            stepStartTs,
            screenshotSizeSuffix: sizesToTest.length > 1 ? size : undefined,
            measurements,
          });

          sizeResults.push({
            action,
            status: 'passed',
            logOutput: actionExtras.logOutput,
            ...(actionExtras.screenshotPath ? { screenshotPath: actionExtras.screenshotPath } : {}),
          });
          safeCallback('onStepComplete', options.onStepComplete
            ? () => options.onStepComplete!(sizeResults[sizeResults.length - 1], index, test.steps.length)
            : undefined);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sizeResults.push({ action, status: 'failed', error: message });
          safeCallback('onStepComplete', options.onStepComplete
            ? () => options.onStepComplete!(sizeResults[sizeResults.length - 1], index, test.steps.length)
            : undefined);
          _sizeTestFailed = true;
          overallFailed = true;
          // Don't throw - continue to next viewport size if there is one
          break;
        }
      }
    } finally {
      // Always close this browser context
      await browserContext.close();
    }

    // Add results with viewport prefix if multiple sizes
    for (const result of sizeResults) {
      if (sizesToTest.length > 1) {
        // Clone the result with size info in error message if failed
        if (result.status === 'failed' && result.error) {
          allResults.push({
            ...result,
            error: `[${size}] ${result.error}`,
          });
        } else {
          allResults.push(result);
        }
      } else {
        allResults.push(result);
      }
    }

    // Keep track of the last execution context for cleanup
    lastExecutionContext = executionContext;
  }

  // Cleanup after all viewport tests complete
  try {
    // Remove signal handlers
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);

    if (lastExecutionContext && ownsTracking && fileTracking) {
      await mergeFileTrackedResources(
        fileTracking.trackFile,
        lastExecutionContext.appwriteContext
      );

      // Run Appwrite cleanup if configured
      if (test.config?.appwrite?.cleanup) {
        const appwriteClient = new AppwriteTestClient({
          endpoint: test.config.appwrite.endpoint,
          projectId: test.config.appwrite.projectId,
          apiKey: test.config.appwrite.apiKey,
          cleanup: true,
        });

        const cleanupResult = await appwriteClient.cleanup(
          lastExecutionContext.appwriteContext,
          sessionId,
          process.cwd()
        );
        console.log('Cleanup result:', cleanupResult);
      }
    }

    // Only clean up tracking/web server if we own them
    if (ownsTracking) {
      if (fileTracking) {
        await fileTracking.stop();
      }
      delete process.env.INTELLITESTER_TRACK_FILE;

      // Stop tracking server
      trackingServer?.stop();

      // Stop webServer if it was started
      await webServerManager.stop();
    }

    await browser.close();
    await terminateOCRWorker();
  } catch (cleanupError) {
    console.error('Error during cleanup:', cleanupError);
  }

  return {
    status: overallFailed ? 'failed' : 'passed',
    steps: allResults,
    variables: lastExecutionContext?.variables,
  };
};
