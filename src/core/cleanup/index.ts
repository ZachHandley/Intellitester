export * from './types.js';
import type { CleanupHandler } from './types.js';

export { executeCleanup, createCleanupExecutor, type ExtendedCleanupOptions } from './executor.js';
export { loadCleanupHandlers, resolveHandler } from './loader.js';
export { saveFailedCleanup, loadFailedCleanups, removeFailedCleanup, type FailedCleanup } from './persistence.js';

/**
 * Helper for defining cleanup handlers in user files.
 * Provides type safety for custom cleanup handler definitions.
 *
 * @example
 * // In cleanup.ts
 * import { defineCleanupHandlers } from 'intellitester/cleanup';
 *
 * export default defineCleanupHandlers({
 *   async deleteUser(resource) {
 *     // cleanup logic
 *   },
 *   async deleteTeam(resource) {
 *     // cleanup logic
 *   }
 * });
 */
export function defineCleanupHandlers<T extends Record<string, CleanupHandler>>(handlers: T): T {
  return handlers;
}
