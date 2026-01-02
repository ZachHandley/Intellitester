import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'Value cannot be empty');

// Workflow reference within a pipeline
const workflowReferenceSchema = z.object({
  file: nonEmptyString,
  id: nonEmptyString.optional(),
  depends_on: z.array(nonEmptyString).optional(),
  on_failure: z.enum(['skip', 'fail', 'ignore']).optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

// Pipeline-specific web config (matches workflow web config pattern)
const pipelineWebConfigSchema = z.object({
  baseUrl: nonEmptyString.url().optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional(),
  headless: z.boolean().optional(),
});

// Pipeline-specific Appwrite config
const pipelineAppwriteConfigSchema = z.object({
  endpoint: nonEmptyString.url(),
  projectId: nonEmptyString,
  apiKey: nonEmptyString,
  cleanup: z.boolean().default(true),
  cleanupOnFailure: z.boolean().default(true),
});

// Pipeline cleanup discovery configuration
const pipelineCleanupDiscoverSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string()).default(['./tests/cleanup']),
  pattern: z.string().default('**/*.ts'),
}).optional();

// Pipeline cleanup configuration
const pipelineCleanupConfigSchema = z.object({
  provider: z.string().optional(),
  parallel: z.boolean().default(false),
  retries: z.number().min(1).max(10).default(3),
  types: z.record(z.string(), z.string()).optional(),
  handlers: z.array(z.string()).optional(),
  discover: pipelineCleanupDiscoverSchema,
  on_failure: z.boolean().default(true), // Run cleanup even if pipeline fails
}).passthrough(); // Allow provider-specific configs like appwrite: {...}

// Pipeline-specific web server config
const pipelineWebServerSchema = z.object({
  command: nonEmptyString.optional(),
  auto: z.boolean().optional(),
  url: nonEmptyString.url(),
  reuseExistingServer: z.boolean().default(true),
  timeout: z.number().int().positive().default(30000),
});

// Pipeline configuration (similar to workflow config)
const pipelineConfigSchema = z.object({
  web: pipelineWebConfigSchema.optional(),
  appwrite: pipelineAppwriteConfigSchema.optional(),
  cleanup: pipelineCleanupConfigSchema.optional(),
  webServer: pipelineWebServerSchema.optional(),
});

// Main pipeline definition schema
export const PipelineDefinitionSchema = z.object({
  name: nonEmptyString,
  platform: z.enum(['web', 'android', 'ios']).default('web'),
  config: pipelineConfigSchema.optional(),
  on_failure: z.enum(['skip', 'fail', 'ignore']).default('skip'),
  cleanup_on_failure: z.boolean().default(true),
  workflows: z.array(workflowReferenceSchema).min(1, 'Pipeline must contain at least one workflow'),
});

// Export inferred types
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;
export type WorkflowReference = z.infer<typeof workflowReferenceSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type PipelineWebConfig = z.infer<typeof pipelineWebConfigSchema>;
export type PipelineAppwriteConfig = z.infer<typeof pipelineAppwriteConfigSchema>;
export type PipelineCleanupConfig = z.infer<typeof pipelineCleanupConfigSchema>;
export type PipelineWebServerConfig = z.infer<typeof pipelineWebServerSchema>;
