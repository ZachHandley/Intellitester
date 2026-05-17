import crypto from 'node:crypto';
import path from 'node:path';

import {
  chromium,
  firefox,
  webkit,
  type BrowserContextOptions,
  type BrowserType,
  type Page,
} from 'playwright';

import type { TestDefinition, WorkflowDefinition } from '../../core/types';
import { interpolateVariables } from '../../core/interpolation';
import { loadTestDefinition } from '../../core/loader';
import { InbucketClient } from '../../integrations/email/inbucketClient';
import type { Email } from '../../integrations/email/types';
import { getBrowserLaunchOptions, parseViewportSize } from './browserOptions.js';
import { executeActionWithRetry, resolveStorageStatePath } from './playwrightExecutor.js';
import { ResponseLog } from './responseLog.js';
import {
  createTestContext,
  APPWRITE_PATTERNS,
  APPWRITE_UPDATE_PATTERNS,
  APPWRITE_DELETE_PATTERNS,
} from '../../integrations/appwrite';
import type { TestContext } from '../../integrations/appwrite/types';
import { startTrackingServer, type TrackingServer, initFileTracking, mergeFileTrackedResources } from '../../tracking';
import { type BrowserName, type StepResult } from './playwrightExecutor';
import { webServerManager, type WebServerInput } from './webServerManager.js';
import type { AIConfig } from '../../ai/types';
import { loadCleanupHandlers, executeCleanup } from '../../core/cleanup/index.js';
import type { CleanupConfig } from '../../core/cleanup/types.js';
import type { WorkflowConfig } from '../../core/workflowSchema.js';
import type { ExecutorOptions } from '../../core/options.js';
import { terminateOCRWorker } from '../../ai/evaluator';

/**
 * Options for running a workflow.
 * Extends base ExecutorOptions with workflow-specific options.
 */
export interface WorkflowOptions extends Omit<ExecutorOptions, 'storageState'> {
  /** AI configuration for interactive/healing mode */
  aiConfig?: AIConfig;
  /** Web server configuration */
  webServer?: WebServerInput;
  /** Fallback baseUrl from pipeline config */
  baseUrl?: string;
  /** Playwright storageState (cookies/localStorage) to apply on every new context. File path string or inline {cookies, origins} object. CLI flag is string-only; YAML config can be either. */
  storageState?: BrowserContextOptions['storageState'];
  /** Fallback Appwrite configuration from pipeline config */
  appwriteConfig?: {
    endpoint: string;
    projectId: string;
    apiKey: string;
  };
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
 *
 * The per-action dispatch is delegated to `executeActionWithRetry` so the
 * workflow path stays structurally in sync with the standalone test path.
 * Adding a new action type to `executeActionWithRetry` automatically makes
 * it work here too.
 */
async function runTestInWorkflow(
  test: TestDefinition,
  page: Page,
  context: ExecutionContext,
  options: WorkflowOptions,
  _workflowDir: string,
  testFilePath: string,
  workflowBaseUrl?: string
): Promise<{ status: 'passed' | 'failed'; steps: StepResult[] }> {
  const results: StepResult[] = [];
  const debugMode = options.debug ?? false;
  const screenshotDir = defaultScreenshotDir;
  const browserName = (options.browser ?? 'chromium') as BrowserName;
  const baseUrl = test.config?.web?.baseUrl || workflowBaseUrl;

  // Network response log for `expectResponse`; the executor reads from it.
  const responseLog = new ResponseLog();
  responseLog.attach(page);

  try {
    for (const [index, action] of test.steps.entries()) {
      const stepStartTs = Date.now();
      if (debugMode) {
        console.log(`  [DEBUG] Step ${index + 1}: ${action.type}`);
      }

      try {
        const actionExtras = await executeActionWithRetry(page, action, index, {
          baseUrl,
          context,
          screenshotDir,
          debugMode,
          interactive: false,
          aiConfig: options.aiConfig,
          browserName,
          testFilePath,
          responseLog,
          stepStartTs,
        });
        results.push({ action, status: 'passed', logOutput: actionExtras.logOutput });
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
  console.log('[Debug] inferCleanupConfig called');
  console.log('[Debug] config:', config ? JSON.stringify(config, null, 2) : 'undefined');

  if (!config) {
    console.log('[Debug] Config is undefined/null, returning undefined');
    return undefined;
  }

  // Check for new cleanup config first
  if (config.cleanup) {
    console.log('[Debug] Found config.cleanup, returning it');
    return config.cleanup;
  }

  // Backwards compatibility: convert old appwrite config
  console.log('[Debug] Checking config.appwrite?.cleanup:', config.appwrite?.cleanup);
  if (config.appwrite?.cleanup) {
    console.log('[Debug] Found config.appwrite.cleanup, returning cleanup config');
    return {
      provider: 'appwrite',
      scanUntracked: true,
      appwrite: {
        endpoint: config.appwrite.endpoint,
        projectId: config.appwrite.projectId,
        apiKey: config.appwrite.apiKey,
        cleanupOnFailure: config.appwrite.cleanupOnFailure,
      },
    };
  }

  console.log('[Debug] No cleanup config found, returning undefined');
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
  // Workflow config wins; otherwise fall back to options.appwriteConfig (e.g. from pipeline).
  const effectiveAppwriteConfig = workflow.config?.appwrite
    ? {
        endpoint: workflow.config.appwrite.endpoint,
        projectId: workflow.config.appwrite.projectId,
        apiKey: workflow.config.appwrite.apiKey,
      }
    : options.appwriteConfig;
  if (effectiveAppwriteConfig) {
    // Update executionContext with appwrite config if not already set
    if (!executionContext.appwriteConfig) {
      executionContext.appwriteConfig = effectiveAppwriteConfig;
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

      // Run test with shared browser context (baseUrl: workflow → pipeline → undefined)
      const effectiveBaseUrl = workflow.config?.web?.baseUrl || options.baseUrl;
      if (options.debug) {
        console.log(`  [DEBUG] Effective baseUrl for test: ${effectiveBaseUrl ?? '(none)'}`);
        console.log(`  [DEBUG]   - workflow.config?.web?.baseUrl: ${workflow.config?.web?.baseUrl ?? '(undefined)'}`);
        console.log(`  [DEBUG]   - options.baseUrl: ${options.baseUrl ?? '(undefined)'}`);
      }
      const result = await runTestInWorkflow(test, page, executionContext, options, workflowDir, testFilePath, effectiveBaseUrl);

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
              userEmail: executionContext.appwriteContext.userEmail,
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
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const testStartTime = new Date().toISOString();
  const cleanupConfig = inferCleanupConfig(workflow.config);

  // 1. Check if tracking is already set up by CLI (e.g., --preview mode)
  const trackingAlreadySetUp = options.skipTrackingSetup ||
    (process.env.INTELLITESTER_TRACKING_OWNER === 'cli');

  let ownsTracking = false;
  let trackingServer: TrackingServer | null = null;
  let fileTracking: { trackFile: string; stop: () => Promise<void> } | null = null;

  if (!trackingAlreadySetUp) {
    ownsTracking = true;
    // Start tracking server
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
    // Workflow config wins; otherwise fall back to options.appwriteConfig (e.g. from pipeline).
    const trackingAppwrite = workflow.config?.appwrite
      ? {
          endpoint: workflow.config.appwrite.endpoint,
          projectId: workflow.config.appwrite.projectId,
          apiKey: workflow.config.appwrite.apiKey,
        }
      : options.appwriteConfig;
    fileTracking = await initFileTracking({
      sessionId,
      cleanupConfig,
      trackDir: options.trackDir,
      providerConfig: trackingAppwrite ? {
        provider: 'appwrite',
        endpoint: trackingAppwrite.endpoint,
        projectId: trackingAppwrite.projectId,
        apiKey: trackingAppwrite.apiKey,
      } : undefined,
    });
    process.env.INTELLITESTER_TRACK_FILE = fileTracking.trackFile;
  } else {
    console.log('Using existing tracking setup (owned by CLI)');
  }

  // 3. Start web server if configured (workflow config takes precedence over global)
  const webServerConfig = workflow.config?.webServer ?? options.webServer;
  const skipWebServer = options.skipWebServerStart;

  console.log(`[Debug] webServerConfig: ${webServerConfig ? 'set' : 'not set'}, skipWebServer: ${skipWebServer}`);

  if (webServerConfig && !skipWebServer) {
    try {
      // Use workflow dir for workflow-defined webServer, process.cwd() for global config
      const serverCwd = workflow.config?.webServer ? workflowDir : process.cwd();

      // Only force restart if we own tracking AND user didn't explicitly set reuseExistingServer
      const requiresTrackingEnv = Boolean(
        workflow.config?.appwrite?.cleanup || workflow.config?.appwrite?.cleanupOnFailure
      );
      const wsEntries = Array.isArray(webServerConfig) ? webServerConfig : [webServerConfig];
      const userExplicitlySetReuse = wsEntries.some((e) => e.reuseExistingServer !== undefined);
      const shouldForceNoReuse = requiresTrackingEnv && !userExplicitlySetReuse && ownsTracking;
      if (shouldForceNoReuse) {
        console.log('[Intellitester] Appwrite cleanup enabled; restarting server to inject tracking env.');
      }

      const normalized = wsEntries.map((entry) => ({
        ...entry,
        workdir: path.resolve(serverCwd, entry.workdir ?? entry.cwd ?? '.'),
        ...(shouldForceNoReuse ? { reuseExistingServer: false } : {}),
      }));
      await webServerManager.start(normalized.length === 1 ? normalized[0] : normalized);
    } catch (error) {
      console.error('Failed to start web server:', error);
      if (trackingServer) await trackingServer.stop();
      throw error;
    }
  } else if (skipWebServer) {
    console.log('Using existing web server (started by CLI)');
  }

  // Handle cleanup on Ctrl+C (only clean up resources we own)
  const signalCleanup = async () => {
    console.log('\n\nInterrupted - cleaning up...');
    if (ownsTracking) {
      if (!skipWebServer) webServerManager.kill(); // Synchronous kill for signal handlers
      if (trackingServer) await trackingServer.stop();
      if (fileTracking) await fileTracking.stop();
      delete process.env.INTELLITESTER_TRACK_FILE;
    }
    process.exit(1);
  };
  process.on('SIGINT', signalCleanup);
  process.on('SIGTERM', signalCleanup);

  // 4. Launch browser ONCE for entire workflow
  // Workflow config wins; otherwise fall back to options.browser (e.g. from pipeline/CLI).
  const browserName = workflow.config?.web?.browser ?? options.browser ?? 'chromium';
  const headless = options.headed === true ? false : (workflow.config?.web?.headless ?? true);
  console.log(`Launching ${browserName}${headless ? ' (headless)' : ' (visible)'}...`);
  const browser = await getBrowser(browserName).launch(getBrowserLaunchOptions({ headless, browser: browserName }));
  console.log(`Browser launched successfully`);

  // Determine viewport sizes to test
  // Workflow config wins; otherwise fall back to options.testSizes (e.g. from pipeline/CLI).
  const workflowTestSizes = workflow.config?.web?.testSizes;
  const testSizes = (workflowTestSizes && workflowTestSizes.length > 0)
    ? workflowTestSizes
    : (options.testSizes && options.testSizes.length > 0
      ? options.testSizes
      : ['1920x1080']); // Default to standard desktop size

  // Validate all viewport sizes upfront
  const viewportSizes: Array<{ size: string; viewport: { width: number; height: number } }> = [];
  for (const size of testSizes) {
    const viewport = parseViewportSize(size);
    if (!viewport) {
      throw new Error(
        `Invalid viewport size: "${size}". Use named sizes (xs, sm, md, lg, xl) or WIDTHxHEIGHT format (e.g., "1920x1080")`
      );
    }
    viewportSizes.push({ size, viewport });
  }

  // Track all results across viewport sizes
  const allTestResults: WorkflowTestResult[] = [];
  let anyFailed = false;
  let _lastCleanupResult: { success: boolean; deleted: string[]; failed: string[] } | undefined;

  // Create browser context (will be replaced for each size)
  // Workflow config wins (resolved against workflow file dir); otherwise fall back to
  // options.storageState (CLI string resolves against cwd; inline object passes through).
  const optionsStorageState: BrowserContextOptions['storageState'] | undefined =
    typeof options.storageState === 'string'
      ? (path.isAbsolute(options.storageState) ? options.storageState : path.resolve(process.cwd(), options.storageState))
      : options.storageState;
  const workflowStorageState = resolveStorageStatePath(
    workflow.config?.web?.storageState as BrowserContextOptions['storageState'],
    workflowDir,
  );
  const storageState: BrowserContextOptions['storageState'] | undefined =
    workflowStorageState ?? optionsStorageState;
  let browserContext = await browser.newContext({
    viewport: viewportSizes[0].viewport,
    ...(storageState ? { storageState } : {}),
  });
  let page = await browserContext.newPage();
  page.setDefaultTimeout(30000);

  // 5. Create shared execution context
  // Workflow config wins; otherwise fall back to options.appwriteConfig (e.g. from pipeline).
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
      : options.appwriteConfig,
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
    // 6. Run workflow for each viewport size
    for (let sizeIndex = 0; sizeIndex < viewportSizes.length; sizeIndex++) {
      const { size, viewport } = viewportSizes[sizeIndex];

      // Create new browser context for each size (after first)
      if (sizeIndex > 0) {
        await browserContext.close();
        browserContext = await browser.newContext({
          viewport,
          ...(storageState ? { storageState } : {}),
        });
        page = await browserContext.newPage();
        page.setDefaultTimeout(30000);

        // Re-setup Appwrite tracking for new page if configured
        if (workflow.config?.appwrite) {
          setupAppwriteTracking(page, executionContext);
        }
      }

      console.log(`\nTesting workflow at viewport: ${size} (${viewport.width}x${viewport.height})`);

      const result = await runWorkflowWithContext(workflow, workflowFilePath, {
        ...options,
        page,
        executionContext,
        skipCleanup: true,
        sessionId,
        testStartTime,
      });

      // Prefix test results with viewport size if testing multiple sizes
      const sizePrefix = viewportSizes.length > 1 ? `[${size}] ` : '';
      for (const testResult of result.tests) {
        allTestResults.push({
          ...testResult,
          file: sizePrefix + testResult.file,
        });
      }

      if (result.status === 'failed') {
        anyFailed = true;
      }
    }

    // Combine results - use the final result's structure
    const result: { status: 'passed' | 'failed'; tests: WorkflowTestResult[]; sessionId: string; workflowFailed: boolean } = {
      status: anyFailed ? 'failed' : 'passed',
      tests: allTestResults,
      sessionId,
      workflowFailed: anyFailed,
    };

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

    if (fileTracking) {
      await mergeFileTrackedResources(fileTracking.trackFile, executionContext.appwriteContext);
    } else if (process.env.INTELLITESTER_TRACK_FILE) {
      // CLI owns tracking, use its track file
      await mergeFileTrackedResources(process.env.INTELLITESTER_TRACK_FILE, executionContext.appwriteContext);
    }

    // 8. Cleanup resources using the extensible cleanup system
    let cleanupResult: { success: boolean; deleted: string[]; failed: string[] } | undefined;

    console.log('[Debug] About to check cleanupConfig:', cleanupConfig ? 'truthy' : 'falsy');
    console.log('[Debug] cleanupConfig value:', cleanupConfig ? JSON.stringify(cleanupConfig, null, 2) : 'undefined');

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
              userEmail: executionContext.appwriteContext.userEmail,
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

    // Cleanup OCR worker
    await terminateOCRWorker();

    // Only clean up resources we own
    if (ownsTracking) {
      // Stop servers
      if (!skipWebServer) await webServerManager.stop();
      if (trackingServer) {
        await trackingServer.stop();
      }
      if (fileTracking) {
        await fileTracking.stop();
      }

      // Clean up env vars
      delete process.env.INTELLITESTER_SESSION_ID;
      delete process.env.INTELLITESTER_TRACK_URL;
      delete process.env.INTELLITESTER_TRACK_FILE;
    }
  }
}
