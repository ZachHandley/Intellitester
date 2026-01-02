import { glob } from 'glob';
import path from 'path';
import fs from 'fs';
import type { CleanupHandler, CleanupConfig, CleanupProvider } from './types.js';
import { providerFactories, getDefaultTypeMappings } from '../../providers/index.js';

/**
 * Load all cleanup handlers based on configuration
 *
 * Loading order (later overrides earlier):
 * 1. Built-in provider methods
 * 2. intellitester.cleanup.ts at project root
 * 3. Discovery paths (default: tests/cleanup/**\/*.ts)
 * 4. Explicit handler files from config
 *
 * @param config - Cleanup configuration object
 * @param cwd - Current working directory (defaults to process.cwd())
 *
 * @example
 * ```typescript
 * // Basic usage with a provider
 * const { handlers, typeMappings } = await loadCleanupHandlers({
 *   provider: 'sqlite',
 *   sqlite: { database: './test.db' },
 *   types: {
 *     user: 'sqlite.deleteUser',
 *     team: 'sqlite.deleteRow'
 *   }
 * });
 *
 * // With custom discovery paths
 * const { handlers, typeMappings } = await loadCleanupHandlers({
 *   provider: 'postgres',
 *   postgres: { connectionString: 'postgresql://...' },
 *   discover: {
 *     enabled: true,
 *     paths: ['./tests/cleanup', './e2e/cleanup'],
 *     pattern: '**\/*.cleanup.ts'
 *   },
 *   handlers: ['./custom-cleanup.ts']
 * });
 * ```
 *
 * @returns Object containing loaded handlers map and type mappings
 */
export async function loadCleanupHandlers(
  config: CleanupConfig,
  cwd: string = process.cwd()
): Promise<{
  handlers: Map<string, CleanupHandler>;
  typeMappings: Record<string, string>;
  provider?: CleanupProvider;
}> {
  const handlers = new Map<string, CleanupHandler>();
  let typeMappings: Record<string, string> = {};
  let provider: CleanupProvider | undefined;

  // 1. Load built-in provider methods
  if (config.provider) {
    const providerConfig = config[config.provider] as Record<string, unknown> | undefined;
    if (!providerConfig) {
      throw new Error(`Provider "${config.provider}" specified but no configuration found`);
    }

    const factory = providerFactories[config.provider];
    if (!factory) {
      throw new Error(`Unknown provider: ${config.provider}. Available: ${Object.keys(providerFactories).join(', ')}`);
    }

    provider = factory(providerConfig);
    await provider.configure(providerConfig);

    // Register provider methods
    for (const [methodName, handler] of Object.entries(provider.methods)) {
      handlers.set(`${provider.name}.${methodName}`, handler);
    }

    // Get default type mappings for this provider
    typeMappings = { ...getDefaultTypeMappings(config.provider) };
  }

  // 2. Auto-discover intellitester.cleanup.ts at root
  const rootCleanupPath = path.join(cwd, 'intellitester.cleanup.ts');
  const rootHandlers = await tryLoadHandlerFile(rootCleanupPath);
  if (rootHandlers) {
    mergeHandlers(handlers, rootHandlers);
  }

  // 3. Auto-discover from discovery paths
  if (config.discover?.enabled !== false) {
    const discoveryPaths = config.discover?.paths ?? ['./tests/cleanup'];
    const pattern = config.discover?.pattern ?? '**/*.ts';

    for (const basePath of discoveryPaths) {
      const absoluteBase = path.isAbsolute(basePath) ? basePath : path.join(cwd, basePath);

      try {
        const files = await glob(pattern, {
          cwd: absoluteBase,
          absolute: true,
          ignore: ['**/*.d.ts', '**/node_modules/**']
        });

        for (const file of files) {
          const fileHandlers = await tryLoadHandlerFile(file);
          if (fileHandlers) {
            mergeHandlers(handlers, fileHandlers);
          }
        }
      } catch {
        // Directory doesn't exist or no matches - that's fine
      }
    }
  }

  // 4. Load explicit handler files
  for (const handlerPath of config.handlers ?? []) {
    const absolutePath = path.isAbsolute(handlerPath)
      ? handlerPath
      : path.join(cwd, handlerPath);

    const fileHandlers = await tryLoadHandlerFile(absolutePath);
    if (fileHandlers) {
      mergeHandlers(handlers, fileHandlers);
    } else {
      console.warn(`Warning: Could not load cleanup handler file: ${handlerPath}`);
    }
  }

  // Merge config.types over default mappings
  if (config.types) {
    typeMappings = { ...typeMappings, ...config.types };
  }

  return { handlers, typeMappings, provider };
}

/**
 * Try to load a handler file, returning null if it doesn't exist or fails
 */
async function tryLoadHandlerFile(filePath: string): Promise<Record<string, CleanupHandler> | null> {
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return null;
    }

    // For TypeScript files, we need to handle them appropriately
    // In a built environment, look for the .js equivalent
    let loadPath = filePath;
    if (filePath.endsWith('.ts')) {
      // In production, TypeScript files will be compiled to .js
      // Try to load the compiled .js version from dist if running compiled
      const jsPath = filePath.replace(/\.ts$/, '.js');
      if (fs.existsSync(jsPath)) {
        loadPath = jsPath;
      } else {
        // Running in development with tsx/ts-node
        // Try direct import which works with these tools
        loadPath = filePath;
      }
    }

    // Use dynamic import with cache busting for fresh load
    const module = await import(`${loadPath}?t=${Date.now()}`);

    // Handle default export or named exports
    if (module.default && typeof module.default === 'object') {
      return module.default as Record<string, CleanupHandler>;
    }

    // Filter to only include function exports
    const handlers: Record<string, CleanupHandler> = {};
    for (const [key, value] of Object.entries(module)) {
      if (typeof value === 'function' && key !== 'default') {
        handlers[key] = value as CleanupHandler;
      }
    }

    return Object.keys(handlers).length > 0 ? handlers : null;
  } catch {
    // File doesn't exist or failed to load
    return null;
  }
}

/**
 * Merge handlers from a file into the main handlers map
 */
function mergeHandlers(
  target: Map<string, CleanupHandler>,
  source: Record<string, CleanupHandler>
): void {
  for (const [key, handler] of Object.entries(source)) {
    target.set(key, handler);
  }
}

/**
 * Get a handler by key, checking both direct keys and provider.method format
 */
export function resolveHandler(
  handlers: Map<string, CleanupHandler>,
  typeMappings: Record<string, string>,
  resourceType: string
): CleanupHandler | null {
  // First check type mappings
  const mappedKey = typeMappings[resourceType];
  if (mappedKey && handlers.has(mappedKey)) {
    return handlers.get(mappedKey)!;
  }

  // Then check for direct handler
  if (handlers.has(resourceType)) {
    return handlers.get(resourceType)!;
  }

  return null;
}
