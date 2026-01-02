import type { TrackedResource } from '../../integration/index.js';
import type { CleanupHandler, CleanupResult, ExecutorOptions, CleanupConfig, CleanupProvider } from './types.js';
import { resolveHandler } from './loader.js';
import { saveFailedCleanup } from './persistence.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extended options for cleanup execution including provider and config
 */
export interface ExtendedCleanupOptions extends ExecutorOptions {
  config?: CleanupConfig;
  provider?: CleanupProvider;
}

/**
 * Execute cleanup for all tracked resources
 *
 * @param resources - Array of tracked resources to clean up
 * @param handlers - Map of handler names to cleanup functions
 * @param typeMappings - Map of resource types to handler names
 * @param options - Executor options (parallel, retries, config, provider)
 */
export async function executeCleanup(
  resources: TrackedResource[],
  handlers: Map<string, CleanupHandler>,
  typeMappings: Record<string, string>,
  options: ExtendedCleanupOptions = {}
): Promise<CleanupResult> {
  const { parallel = false, retries = 3, config, provider } = options;
  const deleted: string[] = [];
  const failed: string[] = [];

  // Sort by creation time (reverse) - delete newest first (LIFO)
  const sorted = [...resources].sort((a, b) => {
    // Handle optional createdAt field (present at runtime from tracking server)
    const aCreatedAt = 'createdAt' in a ? (a.createdAt as string | undefined) : undefined;
    const bCreatedAt = 'createdAt' in b ? (b.createdAt as string | undefined) : undefined;

    const timeA = aCreatedAt ? new Date(aCreatedAt).getTime() : 0;
    const timeB = bCreatedAt ? new Date(bCreatedAt).getTime() : 0;

    return timeB - timeA;
  });

  const deleteResource = async (resource: TrackedResource): Promise<boolean> => {
    const resourceLabel = `${resource.type}:${resource.id}`;

    // Skip already deleted resources (deleted field may be set dynamically)
    const isDeleted = 'deleted' in resource ? (resource.deleted as boolean | undefined) : false;
    if (isDeleted) {
      deleted.push(`${resourceLabel} (already deleted)`);
      return true;
    }

    // Resolve the handler
    const handler = resolveHandler(handlers, typeMappings, resource.type);

    if (!handler) {
      failed.push(`${resourceLabel} (no handler for type "${resource.type}")`);
      console.warn(`No cleanup handler for resource type: ${resource.type}`);
      return false;
    }

    // Retry with exponential backoff
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await handler(resource);
        deleted.push(resourceLabel);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (attempt === retries) {
          failed.push(`${resourceLabel} (${errorMessage})`);
          console.warn(
            `Failed to delete ${resourceLabel} after ${retries} attempts:`,
            errorMessage
          );
          return false;
        }

        // Exponential backoff: 100ms, 200ms, 400ms, 800ms...
        const delay = 100 * Math.pow(2, attempt - 1);
        console.debug(
          `Cleanup attempt ${attempt}/${retries} failed for ${resourceLabel}, ` +
          `retrying in ${delay}ms...`
        );
        await sleep(delay);
      }
    }

    return false;
  };

  if (parallel) {
    // Parallel execution
    const results = await Promise.allSettled(sorted.map(deleteResource));

    // Log any unexpected rejections (shouldn't happen since deleteResource handles errors)
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const resource = sorted[index];
        console.error(
          `Unexpected error cleaning up ${resource.type}:${resource.id}:`,
          result.reason
        );
      }
    });
  } else {
    // Sequential execution
    for (const resource of sorted) {
      await deleteResource(resource);
    }
  }

  // After tracked cleanup, scan for untracked resources if configured
  if (config?.scanUntracked && provider?.cleanupUntracked) {
    console.log('\n[Cleanup] Scanning for untracked resources...');

    try {
      const untrackedResult = await provider.cleanupUntracked({
        testStartTime: options.testStartTime ?? new Date().toISOString(),
        userId: options.userId,
        sessionId: options.sessionId,
      });

      if (untrackedResult.deleted.length > 0) {
        console.log(`[Cleanup] Cleaned up ${untrackedResult.deleted.length} untracked resources`);
        deleted.push(...untrackedResult.deleted);
      }

      if (untrackedResult.failed.length > 0) {
        console.log(`[Cleanup] Failed to clean up ${untrackedResult.failed.length} untracked resources`);
        failed.push(...untrackedResult.failed);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[Cleanup] Untracked resource scan failed: ${errorMessage}`);
    }
  }

  const result: CleanupResult = {
    success: failed.length === 0,
    deleted,
    failed,
  };

  // Save failed cleanups for retry if there were failures
  if (failed.length > 0 && options.sessionId && options.providerConfig) {
    try {
      // Extract the resources that failed
      const failedResources = sorted.filter((resource) => {
        const resourceLabel = `${resource.type}:${resource.id}`;
        return failed.some((f) => f.startsWith(resourceLabel));
      });

      await saveFailedCleanup(
        {
          sessionId: options.sessionId,
          timestamp: new Date().toISOString(),
          resources: failedResources,
          providerConfig: options.providerConfig,
          errors: failed,
        },
        options.cwd
      );
    } catch (error) {
      // Don't fail the cleanup if we can't save the failed cleanup file
      console.warn('Failed to save cleanup persistence file:', error);
    }
  }

  return result;
}

/**
 * Create a cleanup executor with pre-configured handlers and options
 */
export function createCleanupExecutor(
  handlers: Map<string, CleanupHandler>,
  typeMappings: Record<string, string>,
  options: ExecutorOptions = {}
) {
  return {
    /**
     * Execute cleanup for resources
     */
    cleanup: (resources: TrackedResource[]) =>
      executeCleanup(resources, handlers, typeMappings, options),

    /**
     * Execute cleanup for a single resource
     */
    cleanupOne: async (resource: TrackedResource): Promise<boolean> => {
      const result = await executeCleanup([resource], handlers, typeMappings, options);
      return result.success;
    },
  };
}
