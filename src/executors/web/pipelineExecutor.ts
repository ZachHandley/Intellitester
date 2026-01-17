import crypto from 'node:crypto';
import path from 'node:path';

import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
  type Page,
} from 'playwright';

import type {
  PipelineDefinition,
  PipelineResult,
  PipelineWorkflowResult,
  WorkflowReference,
} from '../../core/types';
import { interpolateVariables } from '../../core/interpolation';
import { getBrowserLaunchOptions } from './browserOptions.js';
import { loadWorkflowDefinition } from '../../core/loader';
import {
  runWorkflowWithContext,
  setupAppwriteTracking,
  type ExecutionContext,
  type WorkflowOptions,
} from './workflowExecutor';
import { createTestContext } from '../../integrations/appwrite';
import { startTrackingServer, type TrackingServer, initFileTracking, mergeFileTrackedResources } from '../../tracking';
import { type BrowserName } from './playwrightExecutor';
import { webServerManager } from './webServerManager.js';
import { loadCleanupHandlers, executeCleanup } from '../../core/cleanup/index.js';
import type { CleanupConfig } from '../../core/cleanup/types.js';

export interface PipelineOptions {
  headed?: boolean;
  browser?: BrowserName;
  interactive?: boolean;
  debug?: boolean;
  sessionId?: string;
  trackDir?: string;
}

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
 * Build execution order using topological sort (Kahn's algorithm).
 * Returns workflows in order respecting depends_on.
 * Throws if circular dependency detected.
 */
function buildExecutionOrder(workflows: WorkflowReference[]): WorkflowReference[] {
  // Build a map of id -> workflow for quick lookup
  const workflowMap = new Map<string, WorkflowReference>();
  const workflowIds: string[] = [];

  for (let i = 0; i < workflows.length; i++) {
    const workflow = workflows[i];
    // Use explicit id or generate one based on index
    const id = workflow.id ?? `workflow_${i}`;
    workflowIds.push(id);
    workflowMap.set(id, { ...workflow, id });
  }

  // Build adjacency list and in-degree count
  const adjacencyList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize
  for (const id of workflowIds) {
    adjacencyList.set(id, []);
    inDegree.set(id, 0);
  }

  // Build edges from depends_on
  for (const id of workflowIds) {
    const workflow = workflowMap.get(id)!;
    const deps = workflow.depends_on ?? [];

    for (const depId of deps) {
      if (!workflowMap.has(depId)) {
        throw new Error(
          `Workflow "${id}" depends on "${depId}" which does not exist in the pipeline`
        );
      }
      // depId -> id (depId must come before id)
      adjacencyList.get(depId)!.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm: start with nodes that have no dependencies
  const queue: string[] = [];
  for (const id of workflowIds) {
    if (inDegree.get(id) === 0) {
      queue.push(id);
    }
  }

  const sorted: WorkflowReference[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    sorted.push(workflowMap.get(currentId)!);

    // Reduce in-degree of dependents
    for (const dependentId of adjacencyList.get(currentId) ?? []) {
      const newInDegree = (inDegree.get(dependentId) ?? 1) - 1;
      inDegree.set(dependentId, newInDegree);

      if (newInDegree === 0) {
        queue.push(dependentId);
      }
    }
  }

  // Detect cycle: if not all nodes processed, there's a cycle
  if (sorted.length !== workflowIds.length) {
    const remaining = workflowIds.filter((id) => !sorted.some((w) => w.id === id));
    throw new Error(
      `Circular dependency detected in pipeline. Workflows involved: ${remaining.join(', ')}`
    );
  }

  return sorted;
}

/**
 * Infer cleanup configuration from pipeline config.
 */
function inferCleanupConfig(
  config: PipelineDefinition['config']
): CleanupConfig | undefined {
  if (!config) return undefined;

  // Check for new cleanup config first
  if (config.cleanup) {
    return config.cleanup as CleanupConfig;
  }

  // Backwards compatibility: convert old appwrite config
  if (config.appwrite?.cleanup) {
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

  return undefined;
}

/**
 * Execute a pipeline: multiple workflows in sequence with shared browser and deferred cleanup.
 *
 * @param pipeline - The pipeline definition to execute
 * @param pipelinePath - Path to the pipeline YAML file (used for resolving relative workflow paths)
 * @param options - Pipeline execution options
 * @returns PipelineResult with workflow results and cleanup data
 */
export async function runPipeline(
  pipeline: PipelineDefinition,
  pipelinePath: string,
  options: PipelineOptions = {}
): Promise<PipelineResult> {
  const pipelineDir = path.dirname(pipelinePath);
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const testStartTime = new Date().toISOString();
  const cleanupConfig = inferCleanupConfig(pipeline.config);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Pipeline: ${pipeline.name}`);
  console.log(`Session ID: ${sessionId}`);
  console.log(`${'='.repeat(60)}\n`);

  // 1. Build execution order (topological sort)
  let executionOrder: WorkflowReference[];
  try {
    executionOrder = buildExecutionOrder(pipeline.workflows);
    console.log(
      `Execution order: ${executionOrder.map((w) => w.id ?? w.file).join(' -> ')}\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to build execution order: ${message}`);
    return {
      status: 'failed',
      workflows: [],
      sessionId,
    };
  }

  // 2. Start tracking server
  let trackingServer: TrackingServer | null = null;
  try {
    trackingServer = await startTrackingServer({ port: 0 });
    console.log(`Tracking server started on port ${trackingServer.port}`);
  } catch (error) {
    console.warn('Failed to start tracking server:', error);
  }

  // 3. Set environment variables for the app under test
  if (trackingServer) {
    process.env.INTELLITESTER_SESSION_ID = sessionId;
    process.env.INTELLITESTER_TRACK_URL = `http://localhost:${trackingServer.port}`;
  }
  const fileTracking = await initFileTracking({
    sessionId,
    cwd: pipelineDir,
    cleanupConfig,
    trackDir: options.trackDir,
    providerConfig: pipeline.config?.appwrite ? {
      provider: 'appwrite',
      endpoint: pipeline.config.appwrite.endpoint,
      projectId: pipeline.config.appwrite.projectId,
      apiKey: pipeline.config.appwrite.apiKey,
    } : undefined,
  });
  process.env.INTELLITESTER_TRACK_FILE = fileTracking.trackFile;

  // 4. Start web server if configured
  if (pipeline.config?.webServer) {
    try {
      const requiresTrackingEnv = Boolean(
        pipeline.config?.appwrite?.cleanup || pipeline.config?.appwrite?.cleanupOnFailure
      );
      const effectiveWebServerConfig = requiresTrackingEnv
        ? { ...pipeline.config.webServer, reuseExistingServer: false }
        : pipeline.config.webServer;
      if (requiresTrackingEnv && pipeline.config.webServer.reuseExistingServer !== false) {
        console.log('[Intellitester] Appwrite cleanup enabled; restarting server to inject tracking env.');
      }
      await webServerManager.start({
        ...effectiveWebServerConfig,
        workdir: path.resolve(pipelineDir, effectiveWebServerConfig.workdir ?? effectiveWebServerConfig.cwd ?? '.'),
      });
    } catch (error) {
      console.error('Failed to start web server:', error);
      if (trackingServer) await trackingServer.stop();
      throw error;
    }
  }

  // 5. Handle cleanup on Ctrl+C
  const signalCleanup = async () => {
    console.log('\n\nInterrupted - cleaning up...');
    webServerManager.kill();
    if (trackingServer) await trackingServer.stop();
    await fileTracking.stop();
    delete process.env.INTELLITESTER_TRACK_FILE;
    process.exit(1);
  };
  process.on('SIGINT', signalCleanup);
  process.on('SIGTERM', signalCleanup);

  // 6. Launch browser ONCE for entire pipeline
  const browserName = options.browser ?? pipeline.config?.web?.browser ?? 'chromium';
  const headless = options.headed === true ? false : (pipeline.config?.web?.headless ?? true);
  const browser = await getBrowser(browserName).launch(getBrowserLaunchOptions({ headless, browser: browserName }));
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  page.setDefaultTimeout(30000);

  // 7. Create shared ExecutionContext for ALL workflows
  const executionContext: ExecutionContext = {
    variables: new Map<string, string>(),
    lastEmail: null,
    emailClient: null,
    appwriteContext: createTestContext(),
    appwriteConfig: pipeline.config?.appwrite
      ? {
          endpoint: pipeline.config.appwrite.endpoint,
          projectId: pipeline.config.appwrite.projectId,
          apiKey: pipeline.config.appwrite.apiKey,
        }
      : undefined,
  };

  // 8. Setup Appwrite tracking ONCE at the start if any workflow may need it
  if (pipeline.config?.appwrite) {
    setupAppwriteTracking(page, executionContext);
  }

  // Track workflow execution status
  const completedIds = new Set<string>();
  const failedIds = new Set<string>();
  const skippedIds = new Set<string>();
  const workflowResults: PipelineWorkflowResult[] = [];
  let pipelineFailed = false;
  let shouldStopPipeline = false;

  try {
    // 9. Execute workflows in order
    for (const workflowRef of executionOrder) {
      const workflowId = workflowRef.id ?? workflowRef.file;

      if (shouldStopPipeline) {
        // Mark remaining workflows as skipped
        workflowResults.push({
          id: workflowRef.id,
          file: workflowRef.file,
          status: 'skipped',
          error: 'Pipeline stopped due to previous failure',
        });
        skippedIds.add(workflowId);
        continue;
      }

      // Check if dependencies passed
      const deps = workflowRef.depends_on ?? [];
      const depsFailed = deps.some((id) => failedIds.has(id) || skippedIds.has(id));
      const depsNotMet = deps.some(
        (id) => !completedIds.has(id) && !failedIds.has(id) && !skippedIds.has(id)
      );

      if (depsFailed || depsNotMet) {
        const onFailure = workflowRef.on_failure ?? pipeline.on_failure;

        if (onFailure === 'skip') {
          console.log(`\nSkipping workflow "${workflowId}" - dependencies not met`);
          workflowResults.push({
            id: workflowRef.id,
            file: workflowRef.file,
            status: 'skipped',
            error: `Dependencies not met: ${deps.filter((d) => failedIds.has(d) || skippedIds.has(d)).join(', ')}`,
          });
          skippedIds.add(workflowId);
          continue;
        } else if (onFailure === 'fail') {
          console.log(
            `\nPipeline stopped - workflow "${workflowId}" dependencies failed`
          );
          workflowResults.push({
            id: workflowRef.id,
            file: workflowRef.file,
            status: 'failed',
            error: `Dependencies failed: ${deps.filter((d) => failedIds.has(d) || skippedIds.has(d)).join(', ')}`,
          });
          failedIds.add(workflowId);
          pipelineFailed = true;
          shouldStopPipeline = true;
          continue;
        }
        // 'ignore' falls through to run anyway
        console.log(
          `\nRunning workflow "${workflowId}" despite dependency failure (on_failure: ignore)`
        );
      }

      // Load and execute workflow
      const workflowFilePath = path.resolve(pipelineDir, workflowRef.file);
      console.log(`\n${'='.repeat(40)}`);
      console.log(`Workflow: ${workflowId}`);
      console.log(`File: ${workflowRef.file}`);
      console.log(`${'='.repeat(40)}`);

      try {
        const workflowDefinition = await loadWorkflowDefinition(workflowFilePath);

        // Apply workflow-level variables from pipeline
        if (workflowRef.variables) {
          for (const [key, value] of Object.entries(workflowRef.variables)) {
            // Use centralized interpolation for all built-in variables
            const interpolated = interpolateVariables(value, executionContext.variables);
            executionContext.variables.set(key, interpolated);
          }
        }

        // Execute workflow with shared context
        const workflowOptions: WorkflowOptions & {
          page: Page;
          executionContext: ExecutionContext;
          skipCleanup: boolean;
          sessionId: string;
          testStartTime: string;
        } = {
          ...options,
          page,
          executionContext,
          skipCleanup: true, // Defer cleanup to pipeline end
          sessionId,
          testStartTime,
          baseUrl: pipeline.config?.web?.baseUrl, // Pass pipeline's baseUrl as fallback
        };

        const result = await runWorkflowWithContext(
          workflowDefinition,
          workflowFilePath,
          workflowOptions
        );

        if (result.status === 'passed') {
          completedIds.add(workflowId);
          workflowResults.push({
            id: workflowRef.id,
            file: workflowRef.file,
            status: 'passed',
            workflowResult: result,
          });
        } else {
          failedIds.add(workflowId);
          pipelineFailed = true;
          workflowResults.push({
            id: workflowRef.id,
            file: workflowRef.file,
            status: 'failed',
            workflowResult: result,
            error: result.tests.find((t) => t.status === 'failed')?.error,
          });

          // Check if we should stop the pipeline
          const onFailure = workflowRef.on_failure ?? pipeline.on_failure;
          if (onFailure === 'fail') {
            console.log(`\nPipeline stopped due to workflow "${workflowId}" failure`);
            shouldStopPipeline = true;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to load/run workflow "${workflowId}": ${message}`);

        failedIds.add(workflowId);
        pipelineFailed = true;
        workflowResults.push({
          id: workflowRef.id,
          file: workflowRef.file,
          status: 'failed',
          error: message,
        });

        const onFailure = workflowRef.on_failure ?? pipeline.on_failure;
        if (onFailure === 'fail') {
          console.log(`\nPipeline stopped due to workflow "${workflowId}" failure`);
          shouldStopPipeline = true;
        }
      }
    }

    // 10. Collect server-tracked resources
    if (trackingServer) {
      const serverResources = trackingServer.getResources(sessionId);
      if (serverResources.length > 0) {
        console.log(`\nCollected ${serverResources.length} server-tracked resources`);
        // Cast to Appwrite-specific format - tracking server returns generic resources
        executionContext.appwriteContext.resources.push(...(serverResources as any));
      }
    }

    await mergeFileTrackedResources(fileTracking.trackFile, executionContext.appwriteContext);

    // 11. Run cleanup at end (respecting cleanup_on_failure)
    let cleanupResult: { success: boolean; deleted: string[]; failed: string[] } | undefined;

    if (cleanupConfig) {
      const shouldCleanup = pipelineFailed ? pipeline.cleanup_on_failure : true;

      if (shouldCleanup) {
        try {
          console.log('\n---');
          console.log('[Cleanup] Starting pipeline cleanup...');

          const { handlers, typeMappings, provider } = await loadCleanupHandlers(
            cleanupConfig,
            process.cwd()
          );

          // Convert tracked resources to generic format
          const genericResources = executionContext.appwriteContext.resources.map(
            (r) => ({ ...r })
          );

          // Build provider config
          const providerConfig: { provider: string; [key: string]: unknown } = {
            provider: cleanupConfig.provider || 'appwrite',
          };

          if (cleanupConfig.provider === 'appwrite' && cleanupConfig.appwrite) {
            const appwriteCleanupConfig = cleanupConfig.appwrite as any;
            providerConfig.endpoint = appwriteCleanupConfig.endpoint;
            providerConfig.projectId = appwriteCleanupConfig.projectId;
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
            console.log(
              `[Cleanup] Cleanup complete: ${cleanupResult.deleted.length} resources deleted`
            );
          } else {
            console.log(
              `[Cleanup] Cleanup partial: ${cleanupResult.deleted.length} deleted, ${cleanupResult.failed.length} failed`
            );
            for (const failed of cleanupResult.failed) {
              console.log(`   - ${failed}`);
            }
          }
        } catch (error) {
          console.error('[Cleanup] Cleanup failed:', error);
        }
      } else {
        console.log('\nSkipping cleanup (cleanup_on_failure is false)');
      }
    }

    // 12. Calculate final status
    const passedCount = workflowResults.filter((w) => w.status === 'passed').length;
    const failedCount = workflowResults.filter((w) => w.status === 'failed').length;
    const skippedCount = workflowResults.filter((w) => w.status === 'skipped').length;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Pipeline: ${pipelineFailed ? 'FAILED' : 'PASSED'}`);
    console.log(
      `Workflows: ${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped`
    );
    console.log(`${'='.repeat(60)}\n`);

    return {
      status: pipelineFailed ? 'failed' : 'passed',
      workflows: workflowResults,
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
    await webServerManager.stop();
    if (trackingServer) {
      await trackingServer.stop();
    }
    await fileTracking.stop();

    // Clean up env vars
    delete process.env.INTELLITESTER_SESSION_ID;
    delete process.env.INTELLITESTER_TRACK_URL;
    delete process.env.INTELLITESTER_TRACK_FILE;
  }
}
