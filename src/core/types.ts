import type { z } from 'zod';

import {
  ActionSchema,
  IntellitesterConfigSchema,
  LocatorSchema,
  TestConfigSchema,
  TestDefinitionSchema,
  errorIfSchema,
} from './schema';
import type {
  WorkflowDefinitionSchema,
} from './workflowSchema';

export type Locator = z.infer<typeof LocatorSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type TestConfig = z.infer<typeof TestConfigSchema>;
export type TestDefinition = z.infer<typeof TestDefinitionSchema>;
export type IntellitesterConfig = z.infer<typeof IntellitesterConfigSchema>;
export type WebServer = NonNullable<IntellitesterConfig['webServer']>;
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
