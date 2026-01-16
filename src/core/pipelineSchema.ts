import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'Value cannot be empty');

// Workflow reference within a pipeline
const workflowReferenceSchema = z.object({
  file: nonEmptyString.describe('Path to the workflow file'),
  id: nonEmptyString.optional().describe('Optional ID for referencing this workflow in dependencies'),
  depends_on: z.array(nonEmptyString).optional().describe('IDs of workflows that must complete before this one'),
  on_failure: z.enum(['skip', 'fail', 'ignore']).optional().describe('How to handle failure of this workflow'),
  variables: z.record(z.string(), z.string()).optional().describe('Variables to inject or override for this workflow'),
}).describe('Reference to a workflow file');

// Pipeline-specific web config (matches workflow web config pattern)
const pipelineWebConfigSchema = z.object({
  baseUrl: nonEmptyString.url().optional().describe('Base URL for all workflows in this pipeline'),
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe('Browser to use for all web tests'),
  headless: z.boolean().optional().describe('Run browser in headless mode'),
}).describe('Web platform configuration for the pipeline');

// Pipeline-specific Appwrite config
const pipelineAppwriteConfigSchema = z.object({
  endpoint: nonEmptyString.url().describe('Appwrite API endpoint'),
  projectId: nonEmptyString.describe('Appwrite project ID'),
  apiKey: nonEmptyString.describe('Appwrite API key'),
  cleanup: z.boolean().default(true).describe('Enable automatic cleanup of created resources'),
  cleanupOnFailure: z.boolean().default(true).describe('Clean up resources even when workflows fail'),
}).describe('Appwrite backend configuration for the pipeline');

// Pipeline cleanup discovery configuration
const pipelineCleanupDiscoverSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable auto-discovery of cleanup handlers'),
  paths: z.array(z.string()).default(['./tests/cleanup']).describe('Directories to search for cleanup handlers'),
  pattern: z.string().default('**/*.ts').describe('Glob pattern for handler files'),
}).optional().describe('Auto-discovery configuration for cleanup handlers');

// Pipeline cleanup configuration
const pipelineCleanupConfigSchema = z.object({
  provider: z.string().optional().describe('Cleanup provider to use'),
  parallel: z.boolean().default(false).describe('Run cleanup tasks in parallel'),
  retries: z.number().min(1).max(10).default(3).describe('Number of retry attempts for failed cleanup operations'),
  types: z.record(z.string(), z.string()).optional().describe('Map resource types to cleanup handler methods'),
  handlers: z.array(z.string()).optional().describe('Explicit paths to custom cleanup handler files'),
  discover: pipelineCleanupDiscoverSchema,
  scanUntracked: z.boolean().optional().describe('Scan for untracked resources using provider heuristics'),
  on_failure: z.boolean().default(true).describe('Run cleanup even if pipeline fails'),
}).passthrough().describe('Resource cleanup configuration'); // Allow provider-specific configs like appwrite: {...}

// Pipeline-specific web server config
const pipelineWebServerSchema = z.object({
  command: nonEmptyString.optional().describe('Command to start the web server'),
  auto: z.boolean().optional().describe('Auto-detect server start command from package.json'),
  url: nonEmptyString.url().describe('URL to wait for before starting workflows'),
  reuseExistingServer: z.boolean().default(true).describe('Use existing server if already running at the URL'),
  timeout: z.number().int().positive().default(30000).describe('Timeout in milliseconds to wait for server to start'),
  workdir: nonEmptyString.optional().describe('Working directory for the web server command'),
  cwd: nonEmptyString.optional().describe('Deprecated: use workdir instead'),
}).describe('Configuration for starting a web server before workflows');

// Pipeline configuration (similar to workflow config)
const pipelineConfigSchema = z.object({
  web: pipelineWebConfigSchema.optional(),
  appwrite: pipelineAppwriteConfigSchema.optional(),
  cleanup: pipelineCleanupConfigSchema.optional(),
  webServer: pipelineWebServerSchema.optional(),
}).describe('Pipeline-level configuration that applies to all workflows');

// Main pipeline definition schema
export const PipelineDefinitionSchema = z.object({
  name: nonEmptyString.describe('The name of the pipeline'),
  platform: z.enum(['web', 'android', 'ios']).default('web').describe('The platform to run the pipeline on'),
  config: pipelineConfigSchema.optional(),
  on_failure: z.enum(['skip', 'fail', 'ignore']).default('skip').describe('Default failure handling for workflows'),
  cleanup_on_failure: z.boolean().default(true).describe('Run cleanup even when pipeline fails'),
  workflows: z.array(workflowReferenceSchema).min(1, 'Pipeline must contain at least one workflow').describe('List of workflow files to execute in this pipeline'),
}).describe('Schema for IntelliTester pipeline files that orchestrate multiple workflows');

// Export inferred types
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;
export type WorkflowReference = z.infer<typeof workflowReferenceSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type PipelineWebConfig = z.infer<typeof pipelineWebConfigSchema>;
export type PipelineAppwriteConfig = z.infer<typeof pipelineAppwriteConfigSchema>;
export type PipelineCleanupConfig = z.infer<typeof pipelineCleanupConfigSchema>;
export type PipelineWebServerConfig = z.infer<typeof pipelineWebServerSchema>;
