import crypto from 'node:crypto';
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
import prompts from 'prompts';

import type { Action, Locator, TestDefinition, ErrorIf } from '../../core/types';
import { interpolateVariables } from '../../core/interpolation';
import { InbucketClient } from '../../integrations/email/inbucketClient';
import type { Email } from '../../integrations/email/types';
import { AppwriteTestClient, createTestContext, APPWRITE_PATTERNS, APPWRITE_UPDATE_PATTERNS, APPWRITE_DELETE_PATTERNS, type TrackedResource } from '../../integrations/appwrite';
import { getBrowserLaunchOptions } from './browserOptions.js';
import { getAISuggestion } from '../../ai/errorHelper';
import { TrackingServer, initFileTracking, mergeFileTrackedResources } from '../../tracking';
import { track as trackResource } from '../../integration/index.js';
import type { TrackedResource as IntegrationTrackedResource } from '../../integration/index.js';
import { webServerManager, type WebServerConfig } from './webServerManager.js';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export type { WebServerConfig };

export interface WebRunOptions {
  baseUrl?: string;
  browser?: BrowserName;
  headed?: boolean;
  screenshotDir?: string;
  defaultTimeoutMs?: number;
  webServer?: WebServerConfig;
  debug?: boolean;
  interactive?: boolean;
  aiConfig?: import('../../ai/types').AIConfig;
  sessionId?: string;
  trackDir?: string;
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
      `[data-testid="${locator.testId}"], #${CSS.escape(locator.testId)}, .${CSS.escape(locator.testId)}`
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

const runTap = async (page: Page, locator: Locator): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.click();
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
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await checkFn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(errorMessage);
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

  // Wait for network to be idle (or max 5 seconds)
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
    // Timeout is fine - proceed with screenshot anyway
  });

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

async function executeActionWithRetry(
  page: Page,
  action: Action,
  index: number,
  options: {
    baseUrl?: string;
    context: ExecutionContext;
    screenshotDir: string;
    debugMode: boolean;
    interactive: boolean;
    aiConfig?: import('../../ai/types').AIConfig;
  },
): Promise<void> {
  const { baseUrl, context, screenshotDir, debugMode, interactive, aiConfig } = options;
  const buildTrackPayload = (stepExtras?: Record<string, unknown>): IntegrationTrackedResource | null => {
    if (!('track' in action)) return null;
    const track = (action as { track?: Record<string, unknown> }).track;
    if (!track || typeof track !== 'object') return null;
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
          if (debugMode) {
            console.log(`[DEBUG] Tapping element:`, action.target);
          }
          await checkErrorIf(page, action.target, action.errorIf);
          await runTap(page, action.target);
          break;
        }
        case 'input': {
          if (debugMode) {
            const interpolated = interpolateVariables(action.value, context.variables);
            console.log(`[DEBUG] Inputting value into element:`, action.target);
            console.log(`[DEBUG] Value: ${interpolated}`);
          }
          await checkErrorIf(page, action.target, action.errorIf);
          await runInput(page, action.target, action.value, context);
          break;
        }
        case 'clear': {
          if (debugMode) console.log(`[DEBUG] Clearing element:`, action.target);
          await checkErrorIf(page, action.target, action.errorIf);
          const handle = resolveLocator(page, action.target);
          await handle.clear();
          break;
        }
        case 'hover': {
          if (debugMode) console.log(`[DEBUG] Hovering element:`, action.target);
          await checkErrorIf(page, action.target, action.errorIf);
          const handle = resolveLocator(page, action.target);
          await handle.hover();
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
          if (debugMode) console.log(`[DEBUG] Pressing key: ${action.key}`);
          if (action.target) {
            await checkErrorIf(page, action.target, action.errorIf);
            const handle = resolveLocator(page, action.target);
            await handle.press(action.key);
          } else {
            await page.keyboard.press(action.key);
          }
          break;
        }
        case 'focus': {
          if (debugMode) console.log(`[DEBUG] Focusing:`, action.target);
          await checkErrorIf(page, action.target, action.errorIf);
          const handle = resolveLocator(page, action.target);
          await handle.focus();
          break;
        }
        case 'assert': {
          if (debugMode) {
            console.log(`[DEBUG] Asserting element:`, action.target);
            if (action.value) {
              const interpolated = interpolateVariables(action.value, context.variables);
              console.log(`[DEBUG] Expected text contains: ${interpolated}`);
            }
          }
          await checkErrorIf(page, action.target, action.errorIf);
          await runAssert(page, action.target, action.value, context);
          break;
        }
        case 'wait':
          if (action.target && action.errorIf) {
            await checkErrorIf(page, action.target, action.errorIf);
          }
          await runWait(page, action);
          break;
        case 'scroll':
          if (action.target && action.errorIf) {
            await checkErrorIf(page, action.target, action.errorIf);
          }
          await runScroll(page, action);
          break;
        case 'screenshot':
          throw new Error('Screenshot action should be handled separately');
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
          if (wsAction.errorIf) {
            await checkErrorIf(page, wsAction.target, wsAction.errorIf);
          }
          const handle = resolveLocator(page, wsAction.target);
          const timeout = wsAction.timeout ?? 30000;

          if (debugMode) {
            console.log(`[DEBUG] Waiting for element to be ${wsAction.state}:`, wsAction.target);
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
              );
              break;
            case 'disabled':
              await waitForCondition(
                () => handle.isDisabled(),
                timeout,
                `Element did not become disabled within ${timeout}ms`,
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
            await executeActionWithRetry(page, nestedAction, index, {
              baseUrl,
              context,
              screenshotDir,
              debugMode,
              interactive,
              aiConfig,
            });
          }
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
              await executeActionWithRetry(page, nestedAction, index, {
                baseUrl,
                context,
                screenshotDir,
                debugMode,
                interactive,
                aiConfig,
              });
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
                await executeActionWithRetry(page, testAction, testStepIdx, {
                  baseUrl,
                  context,
                  screenshotDir,
                  debugMode,
                  interactive,
                  aiConfig,
                });
              }
            }
          }
          break;
        }
        default:
          throw new Error(`Unsupported action type: ${(action as Action).type}`);
      }

      const trackedPayload = buildTrackPayload();
      if (trackedPayload) {
        await trackResource(trackedPayload);
      }

      // Success - break out of retry loop
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

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
            return;
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

  // Start tracking server for SSR resource tracking
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const trackingServer = new TrackingServer();
  await trackingServer.start();

  // Set env vars so the app can track resources
  process.env.INTELLITESTER_SESSION_ID = sessionId;
  process.env.INTELLITESTER_TRACK_URL = `http://localhost:${trackingServer.port}`;
  const fileTracking = await initFileTracking({
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

  // Start webServer if configured
  if (options.webServer) {
    const requiresTrackingEnv = Boolean(
      test.config?.appwrite?.cleanup || test.config?.appwrite?.cleanupOnFailure
    );
    const webServerConfig = requiresTrackingEnv
      ? { ...options.webServer, reuseExistingServer: false }
      : options.webServer;
    if (requiresTrackingEnv && options.webServer.reuseExistingServer !== false) {
      console.log('[Intellitester] Appwrite cleanup enabled; restarting server to inject tracking env.');
    }
    await webServerManager.start(webServerConfig);
  }

  // Handle Ctrl+C and termination signals
  const cleanup = () => {
    trackingServer.stop();
    webServerManager.kill();
    void fileTracking.stop();
    delete process.env.INTELLITESTER_TRACK_FILE;
    process.exit(1);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Launch local browser
  console.log(`Launching ${browserName}${headless ? ' (headless)' : ' (visible)'}...`);
  const browser = await getBrowser(browserName).launch(getBrowserLaunchOptions({ headless, browser: browserName }));
  console.log(`Browser launched successfully`);

  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  page.setDefaultTimeout(defaultTimeout);

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

  const results: StepResult[] = [];
  const debugMode = options.debug ?? false;
  const interactive = options.interactive ?? false;
  const buildTrackPayload = (
    action: Action,
    index: number,
    stepExtras?: Record<string, unknown>
  ): IntegrationTrackedResource | null => {
    if (!('track' in action)) return null;
    const track = (action as { track?: Record<string, unknown> }).track;
    if (!track || typeof track !== 'object') return null;
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

  try {
    for (const [index, action] of test.steps.entries()) {
      if (debugMode) {
        console.log(`[DEBUG] Executing step ${index + 1}: ${action.type}`);
      }

      // Merge server-tracked resources before each action
      const serverResources = trackingServer.getResources(sessionId);
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
        // Handle screenshot separately since it has special return handling
        if (action.type === 'screenshot') {
          const ssAction = action as Extract<Action, { type: 'screenshot' }>;
          const waitBefore = ssAction.waitBefore ?? 500;

          if (waitBefore > 0) {
            if (debugMode) {
              console.log(`[DEBUG] Screenshot: waiting ${waitBefore}ms for visual stability`);
            }
            await page.waitForTimeout(waitBefore);
          }

          const screenshotPath = await runScreenshot(page, ssAction.name, screenshotDir, index);
          results.push({ action, status: 'passed', screenshotPath });
          const trackedPayload = buildTrackPayload(action, index, { screenshotPath });
          if (trackedPayload) {
            await trackResource(trackedPayload);
          }
          continue;
        }

        // Use the new executeActionWithRetry for all other actions
        await executeActionWithRetry(page, action, index, {
          baseUrl: options.baseUrl ?? test.config?.web?.baseUrl,
          context: executionContext,
          screenshotDir,
          debugMode,
          interactive,
          aiConfig: options.aiConfig,
        });

        results.push({ action, status: 'passed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ action, status: 'failed', error: message });
        throw error;
      }
    }
  } finally {
    // Remove signal handlers
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);

    await mergeFileTrackedResources(
      fileTracking.trackFile,
      executionContext.appwriteContext
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
        executionContext.appwriteContext,
        sessionId,
        process.cwd()
      );
      console.log('Cleanup result:', cleanupResult);
    }

    await fileTracking.stop();
    delete process.env.INTELLITESTER_TRACK_FILE;

    await browserContext.close();
    await browser.close();

    // Stop tracking server
    trackingServer.stop();

    // Stop webServer if it was started
    await webServerManager.stop();
  }

  return {
    status: results.every((step) => step.status === 'passed') ? 'passed' : 'failed',
    steps: results,
    variables: executionContext.variables,
  };
};
