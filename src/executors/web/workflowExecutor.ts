import crypto from 'node:crypto';
import path from 'node:path';
import { type ChildProcess } from 'node:child_process';

import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
  type Page,
} from 'playwright';

import type { Action, TestDefinition, WorkflowDefinition } from '../../core/types';
import { interpolateVariables } from '../../core/interpolation';
import { loadTestDefinition } from '../../core/loader';
import { InbucketClient } from '../../integrations/email/inbucketClient';
import type { Email } from '../../integrations/email/types';
import { getBrowserLaunchOptions } from './browserOptions.js';
import {
  createTestContext,
  APPWRITE_PATTERNS,
  APPWRITE_UPDATE_PATTERNS,
  APPWRITE_DELETE_PATTERNS,
} from '../../integrations/appwrite';
import type { TestContext } from '../../integrations/appwrite/types';
import { startTrackingServer, type TrackingServer } from '../../tracking';
import { startWebServer, killServer, type BrowserName, type StepResult, type WebServerConfig } from './playwrightExecutor';
import type { AIConfig } from '../../ai/types';
import { loadCleanupHandlers, executeCleanup } from '../../core/cleanup/index.js';
import type { CleanupConfig } from '../../core/cleanup/types.js';
import type { WorkflowConfig } from '../../core/workflowSchema.js';

export interface WorkflowOptions {
  headed?: boolean;
  browser?: BrowserName;
  interactive?: boolean;
  debug?: boolean;
  aiConfig?: AIConfig;
  webServer?: WebServerConfig;
}

export interface WorkflowWithContextOptions extends WorkflowOptions {
  page: Page;
  executionContext: ExecutionContext;
  skipCleanup?: boolean;
  sessionId?: string;
  testStartTime?: string;  // ISO timestamp when the test started
}

export interface WorkflowTestResult {
  id?: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  steps: StepResult[];
  error?: string;
}

export interface WorkflowResult {
  status: 'passed' | 'failed';
  tests: WorkflowTestResult[];
  sessionId: string;
  cleanupResult?: { success: boolean; deleted: string[]; failed: string[] };
}

export interface ExecutionContext {
  variables: Map<string, string>;
  lastEmail: Email | null;
  emailClient: InbucketClient | null;
  appwriteContext: TestContext;
  appwriteConfig?: {
    endpoint: string;
    projectId: string;
    apiKey: string;
  };
}

const defaultScreenshotDir = path.join(process.cwd(), 'artifacts', 'screenshots');

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

/**
 * Interpolates variables from the execution context and previous test results.
 * Supports syntax: {{testId.varName}} for cross-test references and {{varName}} for current test variables.
 */
function interpolateWorkflowVariables(
  value: string,
  currentVariables: Map<string, string>,
  testResults: WorkflowTestResult[]
): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    // Handle {{testId.varName}} syntax
    if (path.includes('.') && !path.includes(':')) {
      const [testId, _varName] = path.split('.', 2);
      const _testResult = testResults.find((t) => t.id === testId);

      // Check if the test result has variables in steps
      // Variables are stored in the execution context during test run
      // For now, we'll return the match if we can't find the variable
      // TODO: Store test-level variables in test results for cross-test access
      console.warn(`Cross-test variable interpolation {{${path}}} not yet fully implemented`);
      return match;
    }

    // Use the centralized interpolation for built-in variables
    const result = interpolateVariables(`{{${path}}}`, currentVariables);
    return result;
  });
}

/**
 * Runs a single test within the workflow context (shared browser, shared variables).
 */
async function runTestInWorkflow(
  test: TestDefinition,
  page: Page,
  context: ExecutionContext,
  options: WorkflowOptions,
  _workflowDir: string,
  workflowBaseUrl?: string
): Promise<{ status: 'passed' | 'failed'; steps: StepResult[] }> {
  const results: StepResult[] = [];
  const debugMode = options.debug ?? false;
  const screenshotDir = defaultScreenshotDir;

  // Import action execution functions from playwrightExecutor
  // For now, we'll duplicate the core action logic here
  // TODO: Refactor playwrightExecutor to export shared functions

  const resolveUrl = (value: string, baseUrl?: string): string => {
    if (!baseUrl) return value;
    try {
      const url = new URL(value, baseUrl);
      return url.toString();
    } catch {
      return value;
    }
  };

  // Use the centralized interpolation function with context variables
  const interpolate = (value: string): string => {
    return interpolateVariables(value, context.variables);
  };

  const resolveLocator = (locator: any) => {
    if (locator.testId) return page.getByTestId(locator.testId);
    if (locator.text) return page.getByText(locator.text);
    if (locator.css) return page.locator(locator.css);
    if (locator.xpath) return page.locator(`xpath=${locator.xpath}`);
    if (locator.role) {
      const options: { name?: string } = {};
      if (locator.name) options.name = locator.name;
      return page.getByRole(locator.role as any, options);
    }
    if (locator.description) return page.getByText(locator.description);
    throw new Error('No usable selector found for locator');
  };

  try {
    for (const [index, action] of test.steps.entries()) {
      if (debugMode) {
        console.log(`  [DEBUG] Step ${index + 1}: ${action.type}`);
      }

      try {
        switch (action.type) {
          case 'navigate': {
            const interpolated = interpolate(action.value);
            const baseUrl = test.config?.web?.baseUrl ?? workflowBaseUrl;
            const target = resolveUrl(interpolated, baseUrl);
            if (debugMode) console.log(`  [DEBUG] Navigating to: ${target}`);
            await page.goto(target);
            break;
          }
          case 'tap': {
            if (debugMode) console.log(`  [DEBUG] Tapping element:`, action.target);
            const handle = resolveLocator(action.target);
            await handle.click();
            break;
          }
          case 'input': {
            const interpolated = interpolate(action.value);
            if (debugMode) console.log(`  [DEBUG] Input: ${interpolated}`);
            const handle = resolveLocator(action.target);
            await handle.fill(interpolated);
            break;
          }
          case 'clear': {
            if (debugMode) console.log(`  [DEBUG] Clearing element:`, action.target);
            const handle = resolveLocator(action.target);
            await handle.clear();
            break;
          }
          case 'hover': {
            if (debugMode) console.log(`  [DEBUG] Hovering element:`, action.target);
            const handle = resolveLocator(action.target);
            await handle.hover();
            break;
          }
          case 'select': {
            const interpolated = interpolate(action.value);
            if (debugMode) console.log(`  [DEBUG] Selecting: ${interpolated}`);
            const handle = resolveLocator(action.target);
            await handle.selectOption(interpolated);
            break;
          }
          case 'check': {
            if (debugMode) console.log(`  [DEBUG] Checking:`, action.target);
            const handle = resolveLocator(action.target);
            await handle.check();
            break;
          }
          case 'uncheck': {
            if (debugMode) console.log(`  [DEBUG] Unchecking:`, action.target);
            const handle = resolveLocator(action.target);
            await handle.uncheck();
            break;
          }
          case 'press': {
            if (debugMode) console.log(`  [DEBUG] Pressing key: ${action.key}`);
            if (action.target) {
              const handle = resolveLocator(action.target);
              await handle.press(action.key);
            } else {
              await page.keyboard.press(action.key);
            }
            break;
          }
          case 'focus': {
            if (debugMode) console.log(`  [DEBUG] Focusing:`, action.target);
            const handle = resolveLocator(action.target);
            await handle.focus();
            break;
          }
          case 'assert': {
            if (debugMode) console.log(`  [DEBUG] Assert:`, action.target);
            const handle = resolveLocator(action.target);
            await handle.waitFor({ state: 'visible' });
            if (action.value) {
              const interpolated = interpolate(action.value);
              const text = (await handle.textContent())?.trim() ?? '';
              if (!text.includes(interpolated)) {
                throw new Error(
                  `Assertion failed: expected "${interpolated}", got "${text}"`
                );
              }
            }
            break;
          }
          case 'wait': {
            if (action.target) {
              const handle = resolveLocator(action.target);
              await handle.waitFor({ state: 'visible', timeout: action.timeout });
            } else {
              await page.waitForTimeout(action.timeout ?? 1000);
            }
            break;
          }
          case 'scroll': {
            if (action.target) {
              const handle = resolveLocator(action.target);
              await handle.scrollIntoViewIfNeeded();
            } else {
              const amount = action.amount ?? 500;
              const direction = action.direction ?? 'down';
              const deltaY = direction === 'up' ? -amount : amount;
              await page.evaluate((value) => window.scrollBy(0, value), deltaY);
            }
            break;
          }
          case 'screenshot': {
            const filename = action.name ?? `step-${index + 1}.png`;
            const filePath = path.join(screenshotDir, filename);
            await page.screenshot({ path: filePath, fullPage: true });
            results.push({ action, status: 'passed', screenshotPath: filePath });
            continue;
          }
          case 'setVar': {
            let value: string;
            if (action.value) {
              value = interpolate(action.value);
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
            if (debugMode) console.log(`  [DEBUG] Set variable ${action.name} = ${value}`);
            break;
          }
          case 'email.waitFor': {
            if (!context.emailClient) {
              throw new Error('Email client not configured');
            }
            const mailbox = interpolate(action.mailbox);
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
              action.pattern ? new RegExp(action.pattern) : undefined
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
              action.pattern ? new RegExp(action.pattern) : undefined
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
            const mailbox = interpolate(action.mailbox);
            await context.emailClient.clearMailbox(mailbox);
            break;
          }
          case 'appwrite.verifyEmail': {
            if (!context.appwriteContext.userId) {
              throw new Error('No user tracked. appwrite.verifyEmail requires a user signup first.');
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
            if (debugMode) console.log(`  [DEBUG] Verified email for user ${context.appwriteContext.userId}`);
            break;
          }
          case 'debug': {
            console.log('  [DEBUG] Pausing execution - Playwright Inspector will open');
            await page.pause();
            break;
          }
          case 'waitForSelector': {
            const handle = resolveLocator(action.target);
            const timeout = action.timeout ?? 30000;

            if (debugMode) {
              console.log(`  [DEBUG] Waiting for element to be ${action.state}:`, action.target);
            }

            const waitForCondition = async (
              checkFn: () => Promise<boolean>,
              timeoutMs: number,
              errorMessage: string,
            ): Promise<void> => {
              const start = Date.now();
              while (Date.now() - start < timeoutMs) {
                if (await checkFn()) return;
                await new Promise((r) => setTimeout(r, 100));
              }
              throw new Error(errorMessage);
            };

            switch (action.state) {
              case 'visible':
              case 'hidden':
              case 'attached':
              case 'detached':
                await handle.waitFor({ state: action.state, timeout });
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
            const handle = resolveLocator(action.condition.target);
            let conditionMet = false;

            if (debugMode) {
              console.log(`  [DEBUG] Checking condition ${action.condition.type}:`, action.condition.target);
            }

            try {
              switch (action.condition.type) {
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
              conditionMet = action.condition.type === 'notExists';
            }

            if (debugMode) {
              console.log(`  [DEBUG] Condition result: ${conditionMet}`);
            }

            // Execute nested steps - recursive call to handle nested actions
            const stepsToRun = conditionMet ? action.then : (action.else ?? []);
            for (const nestedAction of stepsToRun) {
              // For nested actions, we need to execute them inline
              // This is a simplified version - complex nesting would require refactoring
              switch (nestedAction.type) {
                case 'screenshot': {
                  const filename = nestedAction.name ?? `conditional-step.png`;
                  const filePath = path.join(screenshotDir, filename);
                  await page.screenshot({ path: filePath, fullPage: true });
                  results.push({ action: nestedAction, status: 'passed', screenshotPath: filePath });
                  break;
                }
                case 'fail': {
                  throw new Error(nestedAction.message);
                }
                default:
                  throw new Error(`Nested action type ${nestedAction.type} in conditional not yet supported`);
              }
            }
            break;
          }
          case 'fail': {
            throw new Error(action.message);
          }
          default:
            throw new Error(`Unsupported action type: ${(action as Action).type}`);
        }

        results.push({ action, status: 'passed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ action, status: 'failed', error: message });
        throw error;
      }
    }

    return {
      status: 'passed',
      steps: results,
    };
  } catch {
    return {
      status: 'failed',
      steps: results,
    };
  }
}

/**
 * Sets up network interception for Appwrite API tracking.
 */
export function setupAppwriteTracking(page: Page, context: ExecutionContext): void {
  page.on('response', async (response) => {
    const url = response.url();
    const method = response.request().method();

    try {
      // Handle POST requests (resource creation)
      if (method === 'POST') {
        if (APPWRITE_PATTERNS.userCreate.test(url)) {
          const data = await response.json();
          context.appwriteContext.userId = data.$id;
          context.appwriteContext.userEmail = data.email;
          return;
        }

        const rowMatch = url.match(APPWRITE_PATTERNS.rowCreate);
        if (rowMatch) {
          const data = await response.json();
          context.appwriteContext.resources.push({
            type: 'row',
            id: data.$id,
            databaseId: rowMatch[1],
            tableId: rowMatch[2],
            createdAt: new Date().toISOString(),
          });
          return;
        }

        const fileMatch = url.match(APPWRITE_PATTERNS.fileCreate);
        if (fileMatch) {
          const data = await response.json();
          context.appwriteContext.resources.push({
            type: 'file',
            id: data.$id,
            bucketId: fileMatch[1],
            createdAt: new Date().toISOString(),
          });
          return;
        }

        const teamMatch = url.match(APPWRITE_PATTERNS.teamCreate);
        if (teamMatch) {
          const data = await response.json();
          context.appwriteContext.resources.push({
            type: 'team',
            id: data.$id,
            createdAt: new Date().toISOString(),
          });
          return;
        }

        const membershipMatch = url.match(APPWRITE_PATTERNS.membershipCreate);
        if (membershipMatch) {
          const data = await response.json();
          context.appwriteContext.resources.push({
            type: 'membership',
            id: data.$id,
            teamId: membershipMatch[1],
            createdAt: new Date().toISOString(),
          });
          return;
        }

        const messageMatch = url.match(APPWRITE_PATTERNS.messageCreate);
        if (messageMatch) {
          const data = await response.json();
          context.appwriteContext.resources.push({
            type: 'message',
            id: data.$id,
            createdAt: new Date().toISOString(),
          });
          return;
        }
      }

      // Handle PUT/PATCH requests (resource updates)
      if (method === 'PUT' || method === 'PATCH') {
        const rowUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.rowUpdate);
        if (rowUpdateMatch) {
          const resourceId = rowUpdateMatch[3];
          const existing = context.appwriteContext.resources.find(
            (r) => r.type === 'row' && r.id === resourceId
          );
          if (!existing) {
            context.appwriteContext.resources.push({
              type: 'row',
              id: resourceId,
              databaseId: rowUpdateMatch[1],
              tableId: rowUpdateMatch[2],
              createdAt: new Date().toISOString(),
            });
          }
          return;
        }

        const fileUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.fileUpdate);
        if (fileUpdateMatch) {
          const resourceId = fileUpdateMatch[2];
          const existing = context.appwriteContext.resources.find(
            (r) => r.type === 'file' && r.id === resourceId
          );
          if (!existing) {
            context.appwriteContext.resources.push({
              type: 'file',
              id: resourceId,
              bucketId: fileUpdateMatch[1],
              createdAt: new Date().toISOString(),
            });
          }
          return;
        }

        const teamUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.teamUpdate);
        if (teamUpdateMatch) {
          const resourceId = teamUpdateMatch[1];
          const existing = context.appwriteContext.resources.find(
            (r) => r.type === 'team' && r.id === resourceId
          );
          if (!existing) {
            context.appwriteContext.resources.push({
              type: 'team',
              id: resourceId,
              createdAt: new Date().toISOString(),
            });
          }
          return;
        }
      }

      // Handle DELETE requests
      if (method === 'DELETE') {
        const rowDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.rowDelete);
        if (rowDeleteMatch) {
          const resource = context.appwriteContext.resources.find(
            (r) => r.type === 'row' && r.id === rowDeleteMatch[3]
          );
          if (resource) resource.deleted = true;
          return;
        }

        const fileDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.fileDelete);
        if (fileDeleteMatch) {
          const resource = context.appwriteContext.resources.find(
            (r) => r.type === 'file' && r.id === fileDeleteMatch[2]
          );
          if (resource) resource.deleted = true;
          return;
        }

        const teamDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.teamDelete);
        if (teamDeleteMatch) {
          const resource = context.appwriteContext.resources.find(
            (r) => r.type === 'team' && r.id === teamDeleteMatch[1]
          );
          if (resource) resource.deleted = true;
          return;
        }

        const membershipDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.membershipDelete);
        if (membershipDeleteMatch) {
          const resource = context.appwriteContext.resources.find(
            (r) => r.type === 'membership' && r.id === membershipDeleteMatch[2]
          );
          if (resource) resource.deleted = true;
          return;
        }
      }
    } catch {
      // Ignore parse errors for non-JSON responses
    }
  });
}

/**
 * Infer cleanup configuration from workflow config.
 * Provides backwards compatibility by converting old Appwrite config to new cleanup config.
 */
function inferCleanupConfig(config: WorkflowConfig | undefined): CleanupConfig | undefined {
  if (!config) return undefined;

  // Check for new cleanup config first
  if (config.cleanup) {
    return config.cleanup;
  }

  // Backwards compatibility: convert old appwrite config
  if (config.appwrite?.cleanup) {
    return {
      provider: 'appwrite',
      appwrite: {
        endpoint: config.appwrite.endpoint,
        projectId: config.appwrite.projectId,
        apiKey: config.appwrite.apiKey,
        cleanupOnFailure: config.appwrite.cleanupOnFailure,
      },
    };
  }

  return undefined;
}

/**
 * Result from runWorkflowWithContext, includes internal state for cleanup handling.
 */
export interface WorkflowWithContextResult extends WorkflowResult {
  workflowFailed: boolean;
}

/**
 * Runs a workflow with an externally provided page and execution context.
 * This is useful for pipeline execution where multiple workflows share the same browser session.
 *
 * @param workflow - The workflow definition to execute
 * @param workflowFilePath - Path to the workflow file (used for resolving relative test paths)
 * @param options - Options including the page, executionContext, and skipCleanup flag
 * @returns WorkflowWithContextResult with test results and cleanup data
 */
export async function runWorkflowWithContext(
  workflow: WorkflowDefinition,
  workflowFilePath: string,
  options: WorkflowWithContextOptions
): Promise<WorkflowWithContextResult> {
  const { page, executionContext, skipCleanup = false, sessionId: providedSessionId, testStartTime: providedTestStartTime } = options;
  const workflowDir = path.dirname(workflowFilePath);
  const sessionId = providedSessionId ?? crypto.randomUUID();
  const testStartTime = providedTestStartTime ?? new Date().toISOString();

  console.log(`\nStarting workflow: ${workflow.name}`);
  console.log(`Session ID: ${sessionId}\n`);

  // Set up Appwrite network tracking if configured
  if (workflow.config?.appwrite) {
    // Update executionContext with appwrite config if not already set
    if (!executionContext.appwriteConfig) {
      executionContext.appwriteConfig = {
        endpoint: workflow.config.appwrite.endpoint,
        projectId: workflow.config.appwrite.projectId,
        apiKey: workflow.config.appwrite.apiKey,
      };
    }
    setupAppwriteTracking(page, executionContext);
  }

  // Load workflow-level variables (only if not already set by parent pipeline)
  if (workflow.variables) {
    for (const [key, value] of Object.entries(workflow.variables)) {
      // Don't overwrite variables already set by pipeline
      if (!executionContext.variables.has(key)) {
        const interpolated = interpolateVariables(value, executionContext.variables);
        executionContext.variables.set(key, interpolated);
      }
    }
  }

  // Run tests in sequence
  const testResults: WorkflowTestResult[] = [];
  let workflowFailed = false;

  for (const [index, testRef] of workflow.tests.entries()) {
    const testFilePath = path.resolve(workflowDir, testRef.file);
    console.log(`\n[${index + 1}/${workflow.tests.length}] Running: ${testRef.file}`);

    if (testRef.id) {
      console.log(`  Test ID: ${testRef.id}`);
    }

    try {
      // Load test definition
      const test = await loadTestDefinition(testFilePath);

      // Merge test variables with workflow-injected variables
      if (testRef.variables) {
        for (const [key, value] of Object.entries(testRef.variables)) {
          // Interpolate cross-test variables
          const interpolated = interpolateWorkflowVariables(
            value,
            executionContext.variables,
            testResults
          );

          // Store in test definition
          if (!test.variables) test.variables = {};
          test.variables[key] = interpolated;

          // Also store in execution context
          executionContext.variables.set(key, interpolated);
        }
      }

      // Initialize test variables in execution context
      if (test.variables) {
        for (const [key, value] of Object.entries(test.variables)) {
          // Use centralized interpolation for all built-in variables
          const interpolated = interpolateVariables(value, executionContext.variables);
          executionContext.variables.set(key, interpolated);
        }
      }

      // Run test with shared browser context
      const result = await runTestInWorkflow(test, page, executionContext, options, workflowDir, workflow.config?.web?.baseUrl);

      const testResult: WorkflowTestResult = {
        id: testRef.id,
        file: testRef.file,
        status: result.status,
        steps: result.steps,
      };

      testResults.push(testResult);

      if (result.status === 'passed') {
        console.log(`  ✓ Passed (${result.steps.length} steps)`);
      } else {
        console.log(`  ✗ Failed`);
        const failedStep = result.steps.find((s) => s.status === 'failed');
        if (failedStep) {
          console.log(`  Error: ${failedStep.error}`);
          testResult.error = failedStep.error;
        }

        // Stop on failure unless continueOnFailure is set
        if (!workflow.continueOnFailure) {
          workflowFailed = true;
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ Failed to load/run test: ${message}`);

      testResults.push({
        id: testRef.id,
        file: testRef.file,
        status: 'failed',
        steps: [],
        error: message,
      });

      if (!workflow.continueOnFailure) {
        workflowFailed = true;
        break;
      }
    }
  }

  // Skip cleanup if requested (e.g., pipeline will handle it)
  let cleanupResult: { success: boolean; deleted: string[]; failed: string[] } | undefined;

  if (!skipCleanup) {
    const cleanupConfig = inferCleanupConfig(workflow.config);

    if (cleanupConfig) {
      // Determine if we should cleanup based on test status
      const appwriteConfig = cleanupConfig.appwrite as { cleanupOnFailure?: boolean } | undefined;
      const cleanupOnFailure = appwriteConfig?.cleanupOnFailure ?? true;
      const shouldCleanup = workflowFailed ? cleanupOnFailure : true;

      if (shouldCleanup) {
        try {
          console.log('\n[Cleanup] Starting cleanup...');

          const { handlers, typeMappings, provider } = await loadCleanupHandlers(
            cleanupConfig,
            process.cwd()
          );

          // Convert Appwrite-specific TrackedResource to generic TrackedResource
          const genericResources = executionContext.appwriteContext.resources.map((r) => ({
            ...r,
          }));

          // Build provider config (without secrets!)
          const providerConfig: { provider: string; [key: string]: unknown } = {
            provider: cleanupConfig.provider || 'appwrite',
          };

          // Add provider-specific non-secret config
          if (cleanupConfig.provider === 'appwrite' && cleanupConfig.appwrite) {
            const appwriteCleanupConfig = cleanupConfig.appwrite as any;
            providerConfig.endpoint = appwriteCleanupConfig.endpoint;
            providerConfig.projectId = appwriteCleanupConfig.projectId;
            // Note: NOT including apiKey for security
          } else if (cleanupConfig.provider === 'postgres' && cleanupConfig.postgres) {
            const pgConfig = cleanupConfig.postgres as any;
            // Only store connection details, not password
            const connString = pgConfig.connectionString as string;
            if (connString) {
              // Parse and remove password from connection string
              try {
                const url = new URL(connString.replace('postgresql://', 'http://'));
                providerConfig.host = url.hostname;
                providerConfig.port = url.port;
                providerConfig.database = url.pathname.slice(1);
                providerConfig.user = url.username;
                // Note: NOT including password
              } catch {
                // If parsing fails, just note that it's configured
                providerConfig.configured = true;
              }
            }
          } else if (cleanupConfig.provider === 'mysql' && cleanupConfig.mysql) {
            const mysqlConfig = cleanupConfig.mysql as any;
            providerConfig.host = mysqlConfig.host;
            providerConfig.port = mysqlConfig.port;
            providerConfig.database = mysqlConfig.database;
            providerConfig.user = mysqlConfig.user;
            // Note: NOT including password
          } else if (cleanupConfig.provider === 'sqlite' && cleanupConfig.sqlite) {
            const sqliteConfig = cleanupConfig.sqlite as any;
            providerConfig.database = sqliteConfig.database;
            // Note: SQLite doesn't have passwords
          }

          cleanupResult = await executeCleanup(
            genericResources,
            handlers,
            typeMappings,
            {
              parallel: cleanupConfig.parallel ?? false,
              retries: cleanupConfig.retries ?? 3,
              sessionId,
              testStartTime,
              userId: executionContext.appwriteContext.userId,
              providerConfig,
              cwd: process.cwd(),
              config: cleanupConfig,
              provider,
            }
          );

          if (cleanupResult.success) {
            console.log(`[Cleanup] Cleanup complete: ${cleanupResult.deleted.length} resources deleted`);
          } else {
            console.log(`[Cleanup] Cleanup partial: ${cleanupResult.deleted.length} deleted, ${cleanupResult.failed.length} failed`);
            for (const failed of cleanupResult.failed) {
              console.log(`   - ${failed}`);
            }
          }
        } catch (error) {
          console.error('[Cleanup] Cleanup failed:', error);
        }
      } else {
        console.log('\nSkipping cleanup (cleanupOnFailure is false)');
      }
    }
  }

  const overallStatus = testResults.every((t) => t.status === 'passed') ? 'passed' : 'failed';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Workflow: ${overallStatus === 'passed' ? '✓ PASSED' : '✗ FAILED'}`);
  console.log(`Tests: ${testResults.filter(t => t.status === 'passed').length}/${testResults.length} passed`);
  console.log(`${'='.repeat(60)}\n`);

  return {
    status: overallStatus,
    tests: testResults,
    sessionId,
    cleanupResult,
    workflowFailed,
  };
}

/**
 * Runs a workflow: multiple tests in sequence with shared browser session.
 * This is the main entry point that manages browser lifecycle, tracking server, and cleanup.
 */
export async function runWorkflow(
  workflow: WorkflowDefinition,
  workflowFilePath: string,
  options: WorkflowOptions = {}
): Promise<WorkflowResult> {
  const workflowDir = path.dirname(workflowFilePath);
  const sessionId = crypto.randomUUID();
  const testStartTime = new Date().toISOString();

  // 1. Start tracking server
  let trackingServer: TrackingServer | null = null;
  try {
    trackingServer = await startTrackingServer({ port: 0 });
    console.log(`Tracking server started on port ${trackingServer.port}`);
  } catch (error) {
    console.warn('Failed to start tracking server:', error);
  }

  // 2. Set environment variables for the app under test
  if (trackingServer) {
    process.env.INTELLITESTER_SESSION_ID = sessionId;
    process.env.INTELLITESTER_TRACK_URL = `http://localhost:${trackingServer.port}`;
  }

  // 3. Start web server if configured (workflow config takes precedence over global)
  let serverProcess: ChildProcess | null = null;
  const webServerConfig = workflow.config?.webServer ?? options.webServer;
  if (webServerConfig) {
    try {
      // Use workflow dir for workflow-defined webServer, process.cwd() for global config
      const serverCwd = workflow.config?.webServer ? workflowDir : process.cwd();
      serverProcess = await startWebServer({
        ...webServerConfig,
        cwd: serverCwd,
      });
    } catch (error) {
      console.error('Failed to start web server:', error);
      if (trackingServer) await trackingServer.stop();
      throw error;
    }
  }

  // Handle cleanup on Ctrl+C
  const signalCleanup = async () => {
    console.log('\n\nInterrupted - cleaning up...');
    killServer(serverProcess);
    if (trackingServer) await trackingServer.stop();
    process.exit(1);
  };
  process.on('SIGINT', signalCleanup);
  process.on('SIGTERM', signalCleanup);

  // 4. Launch browser ONCE for entire workflow
  const browserName = options.browser ?? workflow.config?.web?.browser ?? 'chromium';
  const headless = options.headed === true ? false : (workflow.config?.web?.headless ?? true);
  console.log(`Launching ${browserName}${headless ? ' (headless)' : ' (visible)'}...`);
  const browser = await getBrowser(browserName).launch(getBrowserLaunchOptions({ headless }));
  console.log(`Browser launched successfully`);
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  page.setDefaultTimeout(30000);

  // 5. Create shared execution context
  const executionContext: ExecutionContext = {
    variables: new Map<string, string>(),
    lastEmail: null,
    emailClient: null,
    appwriteContext: createTestContext(),
    appwriteConfig: workflow.config?.appwrite
      ? {
          endpoint: workflow.config.appwrite.endpoint,
          projectId: workflow.config.appwrite.projectId,
          apiKey: workflow.config.appwrite.apiKey,
        }
      : undefined,
  };

  // 5b. Load workflow-level variables into execution context
  if (workflow.variables) {
    for (const [key, value] of Object.entries(workflow.variables)) {
      // Use centralized interpolation for all built-in variables
      const interpolated = interpolateVariables(value, executionContext.variables);
      executionContext.variables.set(key, interpolated);
    }
  }

  try {
    // 6. Run workflow with context (skipCleanup=true so we can collect tracking resources first)
    const result = await runWorkflowWithContext(workflow, workflowFilePath, {
      ...options,
      page,
      executionContext,
      skipCleanup: true,
      sessionId,
      testStartTime,
    });

    // 7. Collect server-tracked resources AFTER workflow execution
    if (trackingServer) {
      const serverResources = trackingServer.getResources(sessionId);
      if (serverResources.length > 0) {
        console.log(`\nCollected ${serverResources.length} server-tracked resources`);
        // Cast generic tracked resources to Appwrite-specific format
        // The tracking server is now generic, so we trust the tracked data is valid
        executionContext.appwriteContext.resources.push(...(serverResources as any));
      }
    }

    // 8. Cleanup resources using the extensible cleanup system
    let cleanupResult: { success: boolean; deleted: string[]; failed: string[] } | undefined;

    const cleanupConfig = inferCleanupConfig(workflow.config);

    if (cleanupConfig) {
      // Determine if we should cleanup based on test status
      const appwriteConfig = cleanupConfig.appwrite as { cleanupOnFailure?: boolean } | undefined;
      const cleanupOnFailure = appwriteConfig?.cleanupOnFailure ?? true;
      const shouldCleanup = result.workflowFailed ? cleanupOnFailure : true;

      if (shouldCleanup) {
        try {
          console.log('\n[Cleanup] Starting cleanup...');

          const { handlers, typeMappings, provider } = await loadCleanupHandlers(
            cleanupConfig,
            process.cwd()
          );

          // Convert Appwrite-specific TrackedResource to generic TrackedResource
          const genericResources = executionContext.appwriteContext.resources.map((r) => ({
            ...r,
          }));

          // Build provider config (without secrets!)
          const providerConfig: { provider: string; [key: string]: unknown } = {
            provider: cleanupConfig.provider || 'appwrite',
          };

          // Add provider-specific non-secret config
          if (cleanupConfig.provider === 'appwrite' && cleanupConfig.appwrite) {
            const appwriteCleanupConfig = cleanupConfig.appwrite as any;
            providerConfig.endpoint = appwriteCleanupConfig.endpoint;
            providerConfig.projectId = appwriteCleanupConfig.projectId;
            // Note: NOT including apiKey for security
          } else if (cleanupConfig.provider === 'postgres' && cleanupConfig.postgres) {
            const pgConfig = cleanupConfig.postgres as any;
            // Only store connection details, not password
            const connString = pgConfig.connectionString as string;
            if (connString) {
              // Parse and remove password from connection string
              try {
                const url = new URL(connString.replace('postgresql://', 'http://'));
                providerConfig.host = url.hostname;
                providerConfig.port = url.port;
                providerConfig.database = url.pathname.slice(1);
                providerConfig.user = url.username;
                // Note: NOT including password
              } catch {
                // If parsing fails, just note that it's configured
                providerConfig.configured = true;
              }
            }
          } else if (cleanupConfig.provider === 'mysql' && cleanupConfig.mysql) {
            const mysqlConfig = cleanupConfig.mysql as any;
            providerConfig.host = mysqlConfig.host;
            providerConfig.port = mysqlConfig.port;
            providerConfig.database = mysqlConfig.database;
            providerConfig.user = mysqlConfig.user;
            // Note: NOT including password
          } else if (cleanupConfig.provider === 'sqlite' && cleanupConfig.sqlite) {
            const sqliteConfig = cleanupConfig.sqlite as any;
            providerConfig.database = sqliteConfig.database;
            // Note: SQLite doesn't have passwords
          }

          cleanupResult = await executeCleanup(
            genericResources,
            handlers,
            typeMappings,
            {
              parallel: cleanupConfig.parallel ?? false,
              retries: cleanupConfig.retries ?? 3,
              sessionId,
              testStartTime,
              userId: executionContext.appwriteContext.userId,
              providerConfig,
              cwd: process.cwd(),
              config: cleanupConfig,
              provider,
            }
          );

          if (cleanupResult.success) {
            console.log(`[Cleanup] Cleanup complete: ${cleanupResult.deleted.length} resources deleted`);
          } else {
            console.log(`[Cleanup] Cleanup partial: ${cleanupResult.deleted.length} deleted, ${cleanupResult.failed.length} failed`);
            for (const failed of cleanupResult.failed) {
              console.log(`   - ${failed}`);
            }
          }
        } catch (error) {
          console.error('[Cleanup] Cleanup failed:', error);
        }
      } else {
        console.log('\nSkipping cleanup (cleanupOnFailure is false)');
      }
    }

    return {
      status: result.status,
      tests: result.tests,
      sessionId,
      cleanupResult,
    };
  } finally {
    // Remove signal handlers
    process.off('SIGINT', signalCleanup);
    process.off('SIGTERM', signalCleanup);

    // Close browser
    await browserContext.close();
    await browser.close();

    // Stop servers
    killServer(serverProcess);
    if (trackingServer) {
      await trackingServer.stop();
    }

    // Clean up env vars
    delete process.env.INTELLITESTER_SESSION_ID;
    delete process.env.INTELLITESTER_TRACK_URL;
  }
}
