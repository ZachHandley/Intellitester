import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'Value cannot be empty');

// Reference to a test file in the workflow
const testReferenceSchema = z.object({
  file: nonEmptyString,
  id: nonEmptyString.optional(), // Optional ID for referencing in variables
  variables: z.record(z.string(), z.string()).optional(), // Override/inject variables
});

// Workflow-specific web config
const workflowWebConfigSchema = z.object({
  baseUrl: nonEmptyString.url().optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional(),
  headless: z.boolean().optional(),
});

// Workflow-specific Appwrite config
const workflowAppwriteConfigSchema = z.object({
  endpoint: nonEmptyString.url(),
  projectId: nonEmptyString,
  apiKey: nonEmptyString,
  cleanup: z.boolean().default(true), // Backwards compatibility
  cleanupOnFailure: z.boolean().default(true), // Backwards compatibility
});

// Cleanup discovery configuration for workflows
const workflowCleanupDiscoverSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string()).default(['./tests/cleanup']),
  pattern: z.string().default('**/*.ts'),
}).optional();

// Workflow cleanup configuration
const workflowCleanupConfigSchema = z.object({
  provider: z.string().optional(),
  parallel: z.boolean().default(false),
  retries: z.number().min(1).max(10).default(3),
  types: z.record(z.string(), z.string()).optional(),
  handlers: z.array(z.string()).optional(),
  discover: workflowCleanupDiscoverSchema,
}).passthrough(); // Allow provider-specific configs like appwrite: {...}

// Workflow-specific web server config
const workflowWebServerSchema = z.object({
  command: nonEmptyString.optional(),
  auto: z.boolean().optional(),
  url: nonEmptyString.url(),
  reuseExistingServer: z.boolean().default(true),
  timeout: z.number().int().positive().default(30000),
});

// Workflow configuration
const workflowConfigSchema = z.object({
  web: workflowWebConfigSchema.optional(),
  appwrite: workflowAppwriteConfigSchema.optional(),
  cleanup: workflowCleanupConfigSchema.optional(),
  webServer: workflowWebServerSchema.optional(),
});

// Main workflow definition schema
export const WorkflowDefinitionSchema = z.object({
  name: nonEmptyString,
  platform: z.enum(['web', 'android', 'ios']).default('web'),
  config: workflowConfigSchema.optional(),
  continueOnFailure: z.boolean().default(false),
  tests: z.array(testReferenceSchema).min(1, 'Workflow must contain at least one test'),
});

// Export inferred types
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type TestReference = z.infer<typeof testReferenceSchema>;
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
export type WorkflowWebConfig = z.infer<typeof workflowWebConfigSchema>;
export type WorkflowAppwriteConfig = z.infer<typeof workflowAppwriteConfigSchema>;
export type WorkflowCleanupConfig = z.infer<typeof workflowCleanupConfigSchema>;
export type WorkflowWebServerConfig = z.infer<typeof workflowWebServerSchema>;
