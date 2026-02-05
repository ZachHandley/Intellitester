/**
 * Shared Zod schemas used across workflow, pipeline, and config definitions.
 * Single source of truth for common configuration structures.
 */
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'Value cannot be empty');

/**
 * Unified web server configuration schema.
 * Used by workflows, pipelines, and the main config.
 */
export const WebServerConfigSchema = z.object({
  /** Command to start the web server */
  command: nonEmptyString.optional().describe('Command to start the web server'),
  /** Auto-detect server start command from package.json */
  auto: z.boolean().optional().describe('Auto-detect server start command from package.json'),
  /** Serve a static directory instead of running a command */
  static: z.string().optional().describe('Serve a static directory instead of running a command'),
  /** URL to wait for before starting tests */
  url: nonEmptyString.url().describe('URL to wait for before starting tests'),
  /** Port number for the web server */
  port: z.number().int().positive().optional().describe('Port number for the web server'),
  /** Working directory for the web server command */
  workdir: nonEmptyString.optional().describe('Working directory for the web server command'),
  /** @deprecated Use workdir instead */
  cwd: nonEmptyString.optional().describe('Deprecated: use workdir instead'),
  /** Use existing server if already running at the URL */
  reuseExistingServer: z.boolean().default(true).describe('Use existing server if already running at the URL'),
  /** Timeout in milliseconds to wait for server to start */
  timeout: z.number().int().positive().default(30000).describe('Timeout in milliseconds to wait for server to start'),
  /** Idle timeout for server shutdown (used by preview mode) */
  idleTimeout: z.number().int().positive().optional().describe('Idle timeout in milliseconds for server shutdown'),
}).describe('Configuration for starting a web server before tests');

/** Type inferred from WebServerConfigSchema */
export type WebServerConfig = z.infer<typeof WebServerConfigSchema>;

/**
 * Web server schema with validation requiring command, auto, or static.
 * Used by the main intellitester.config.yaml.
 */
export const WebServerConfigWithValidationSchema = WebServerConfigSchema.refine(
  (config) => config.command || config.auto || config.static,
  { message: 'WebServerConfig requires command, auto: true, or static directory' }
);

/**
 * Cleanup discovery configuration schema.
 * Used by both workflow and pipeline cleanup configs.
 */
export const CleanupDiscoverSchema = z.object({
  /** Enable auto-discovery of cleanup handlers */
  enabled: z.boolean().default(true).describe('Enable auto-discovery of cleanup handlers'),
  /** Directories to search for cleanup handlers */
  paths: z.array(z.string()).default(['./tests/cleanup']).describe('Directories to search for cleanup handlers'),
  /** Glob pattern for handler files */
  pattern: z.string().default('**/*.ts').describe('Glob pattern for handler files'),
}).optional().describe('Auto-discovery configuration for cleanup handlers');

export type CleanupDiscoverConfig = z.infer<typeof CleanupDiscoverSchema>;

/**
 * Base cleanup configuration schema (shared fields).
 * Extended by workflow and pipeline cleanup schemas.
 */
export const BaseCleanupConfigSchema = z.object({
  /** Cleanup provider to use (sqlite, postgres, appwrite, etc.) */
  provider: z.string().optional().describe('Cleanup provider to use'),
  /** Run cleanup tasks in parallel */
  parallel: z.boolean().default(false).describe('Run cleanup tasks in parallel'),
  /** Number of retry attempts for failed cleanup operations */
  retries: z.number().min(1).max(10).default(3).describe('Number of retry attempts for failed cleanup operations'),
  /** Map resource types to cleanup handler methods */
  types: z.record(z.string(), z.string()).optional().describe('Map resource types to cleanup handler methods'),
  /** Explicit paths to custom cleanup handler files */
  handlers: z.array(z.string()).optional().describe('Explicit paths to custom cleanup handler files'),
  /** Auto-discovery configuration */
  discover: CleanupDiscoverSchema,
  /** Scan for untracked resources using provider heuristics */
  scanUntracked: z.boolean().optional().describe('Scan for untracked resources using provider heuristics'),
}).passthrough(); // Allow provider-specific configs like appwrite: {...}, sqlite: {...}

export type BaseCleanupConfig = z.infer<typeof BaseCleanupConfigSchema>;

/**
 * Web platform configuration schema (shared between workflow and pipeline).
 */
export const WebPlatformConfigSchema = z.object({
  /** Base URL for all tests */
  baseUrl: nonEmptyString.url().optional().describe('Base URL for all tests'),
  /** Browser to use for all web tests */
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe('Browser to use for all web tests'),
  /** Run browser in headless mode */
  headless: z.boolean().optional().describe('Run browser in headless mode'),
  /** Viewport sizes to test (Tailwind breakpoints) */
  testSizes: z.array(z.enum(['xs', 'sm', 'md', 'lg', 'xl'])).optional()
    .describe('Viewport sizes to test (Tailwind breakpoints). Tests run once per size.'),
}).describe('Web platform configuration');

export type WebPlatformConfig = z.infer<typeof WebPlatformConfigSchema>;

/**
 * Appwrite configuration schema (shared between workflow and pipeline).
 */
export const AppwriteConfigSchema = z.object({
  /** Appwrite API endpoint */
  endpoint: nonEmptyString.url().describe('Appwrite API endpoint'),
  /** Appwrite project ID */
  projectId: nonEmptyString.describe('Appwrite project ID'),
  /** Appwrite API key */
  apiKey: nonEmptyString.describe('Appwrite API key'),
  /** Enable automatic cleanup of created resources */
  cleanup: z.boolean().default(true).describe('Enable automatic cleanup of created resources'),
  /** Clean up resources even when tests fail */
  cleanupOnFailure: z.boolean().default(true).describe('Clean up resources even when tests fail'),
}).describe('Appwrite backend configuration');

export type AppwriteConfig = z.infer<typeof AppwriteConfigSchema>;
