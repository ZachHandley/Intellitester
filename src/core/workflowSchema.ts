import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'Value cannot be empty');

// Reference to a test file in the workflow
const testReferenceSchema = z.object({
  file: nonEmptyString.describe('Path to the test file relative to the workflow file'),
  id: nonEmptyString.optional().describe('Optional ID for referencing this test in variables or dependencies'),
  variables: z.record(z.string(), z.string()).optional().describe('Variables to inject or override for this specific test'),
}).describe('Reference to a test file');

// Workflow-specific web config
const workflowWebConfigSchema = z.object({
  baseUrl: nonEmptyString.url().optional().describe('Base URL for all tests in this workflow'),
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe('Browser to use for all web tests'),
  headless: z.boolean().optional().describe('Run browser in headless mode'),
}).describe('Web platform configuration for the workflow');

// Workflow-specific Appwrite config
const workflowAppwriteConfigSchema = z.object({
  endpoint: nonEmptyString.url().describe('Appwrite API endpoint'),
  projectId: nonEmptyString.describe('Appwrite project ID'),
  apiKey: nonEmptyString.describe('Appwrite API key'),
  cleanup: z.boolean().default(true).describe('Enable automatic cleanup of created resources'),
  cleanupOnFailure: z.boolean().default(true).describe('Clean up resources even when tests fail'),
}).describe('Appwrite backend configuration for the workflow');

// Cleanup discovery configuration for workflows
const workflowCleanupDiscoverSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable auto-discovery of cleanup handlers'),
  paths: z.array(z.string()).default(['./tests/cleanup']).describe('Directories to search for cleanup handlers'),
  pattern: z.string().default('**/*.ts').describe('Glob pattern for handler files'),
}).optional().describe('Auto-discovery configuration for cleanup handlers');

// Workflow cleanup configuration
const workflowCleanupConfigSchema = z.object({
  provider: z.string().optional().describe('Cleanup provider to use'),
  parallel: z.boolean().default(false).describe('Run cleanup tasks in parallel'),
  retries: z.number().min(1).max(10).default(3).describe('Number of retry attempts for failed cleanup operations'),
  types: z.record(z.string(), z.string()).optional().describe('Map resource types to cleanup handler methods'),
  handlers: z.array(z.string()).optional().describe('Explicit paths to custom cleanup handler files'),
  discover: workflowCleanupDiscoverSchema,
  scanUntracked: z.boolean().optional().describe('Scan for untracked resources using provider heuristics'),
}).passthrough().describe('Resource cleanup configuration'); // Allow provider-specific configs like appwrite: {...}

// Workflow-specific web server config
const workflowWebServerSchema = z.object({
  command: nonEmptyString.optional().describe('Command to start the web server'),
  auto: z.boolean().optional().describe('Auto-detect server start command from package.json'),
  url: nonEmptyString.url().describe('URL to wait for before starting tests'),
  reuseExistingServer: z.boolean().default(true).describe('Use existing server if already running at the URL'),
  timeout: z.number().int().positive().default(30000).describe('Timeout in milliseconds to wait for server to start'),
  workdir: nonEmptyString.optional().describe('Working directory for the web server command'),
  cwd: nonEmptyString.optional().describe('Deprecated: use workdir instead'),
}).describe('Configuration for starting a web server before tests');

// Workflow configuration
const workflowConfigSchema = z.object({
  web: workflowWebConfigSchema.optional(),
  appwrite: workflowAppwriteConfigSchema.optional(),
  cleanup: workflowCleanupConfigSchema.optional(),
  webServer: workflowWebServerSchema.optional(),
}).describe('Workflow-level configuration that applies to all tests');

// Main workflow definition schema
export const WorkflowDefinitionSchema = z.object({
  name: nonEmptyString.describe('The name of the workflow'),
  platform: z.enum(['web', 'android', 'ios']).default('web').describe('The platform to run the workflow on'),
  variables: z.record(z.string(), z.string()).optional().describe('Workflow-level variables available to all tests'),
  config: workflowConfigSchema.optional(),
  continueOnFailure: z.boolean().default(false).describe('Continue running subsequent tests even if a test fails'),
  tests: z.array(testReferenceSchema).min(1, 'Workflow must contain at least one test').describe('List of test files to execute in this workflow'),
}).describe('Schema for IntelliTester workflow files that orchestrate multiple tests');

// Export inferred types
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type TestReference = z.infer<typeof testReferenceSchema>;
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
export type WorkflowWebConfig = z.infer<typeof workflowWebConfigSchema>;
export type WorkflowAppwriteConfig = z.infer<typeof workflowAppwriteConfigSchema>;
export type WorkflowCleanupConfig = z.infer<typeof workflowCleanupConfigSchema>;
export type WorkflowWebServerConfig = z.infer<typeof workflowWebServerSchema>;
