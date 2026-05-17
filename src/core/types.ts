import type { z } from 'zod';

import {
  ActionSchema,
  IntellitesterConfigSchema,
  LocatorSchema,
  TestConfigSchema,
  TestDefinitionSchema,
  errorIfSchema,
  webServerEntrySchema,
} from './schema';
import type {
  WorkflowDefinitionSchema,
} from './workflowSchema';

export type Locator = z.infer<typeof LocatorSchema>;
export type Action = z.infer<typeof ActionSchema>;
type RawTestConfig = z.infer<typeof TestConfigSchema>;
// Loaders fill `ai.model` from the per-provider default when missing, so
// consumers can treat it as required (see parseIntellitesterConfig /
// parseTestDefinition in loader.ts).
type WithAiModelFilled<T extends { ai?: unknown }> = Omit<T, 'ai'> & {
  ai?: NonNullable<T['ai']> & { model: string };
};
export type TestConfig = WithAiModelFilled<RawTestConfig>;
type RawTestDefinition = z.infer<typeof TestDefinitionSchema>;
export type TestDefinition = Omit<RawTestDefinition, 'config'> & {
  config?: TestConfig;
};
type RawIntellitesterConfig = z.infer<typeof IntellitesterConfigSchema>;
export type IntellitesterConfig = WithAiModelFilled<RawIntellitesterConfig>;
export type WebServer = NonNullable<IntellitesterConfig['webServer']>;
export type WebServerEntry = z.infer<typeof webServerEntrySchema>;
export type PreviewConfig = NonNullable<IntellitesterConfig['preview']>;
export type ErrorIf = z.infer<typeof errorIfSchema>;

// Workflow types are exported from workflowSchema.ts
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// Pipeline types - re-exported from pipelineSchema.ts
export type {
  PipelineDefinition,
  WorkflowReference,
  PipelineConfig,
  PipelineWebConfig,
  PipelineAppwriteConfig,
  PipelineCleanupConfig,
  PipelineWebServerConfig,
} from './pipelineSchema.js';

// Import WorkflowResult for use in pipeline result types
import type { WorkflowResult } from '../executors/web/workflowExecutor.js';

// Pipeline execution result types
export interface PipelineWorkflowResult {
  id?: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  workflowResult?: WorkflowResult;
  error?: string;
}

export interface PipelineResult {
  status: 'passed' | 'failed';
  workflows: PipelineWorkflowResult[];
  sessionId: string;
  cleanupResult?: { success: boolean; deleted: string[]; failed: string[] };
}

// Re-export WorkflowResult for convenience
export type { WorkflowResult } from '../executors/web/workflowExecutor.js';
