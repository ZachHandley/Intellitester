/**
 * Test generator that converts natural language to YAML test definitions.
 *
 * Runs as a Blazen Workflow: scan source → run an agentic generate step that
 * uses a `submit_test_yaml` tool, parsing + Zod-validating each submission and
 * feeding any error back to the model until the budget is exhausted.
 */

import { ChatMessage, Workflow, runAgent } from 'blazen';
import type { Context, JsToolDef } from 'blazen';
import { parse } from 'yaml';
import type { z } from 'zod';
import { TestDefinitionSchema } from '../core/schema';
import type { AIConfig } from '../ai/types';
import { buildModel, buildCompletionOptions } from '../ai/provider';
import {
  SYSTEM_PROMPT,
  buildPrompt,
  buildSourceAwareSystemPrompt,
  type PromptContext,
} from './prompts';
import { scanProjectSource, type SourceConfig } from './sourceScanner';

export interface GeneratorOptions {
  aiConfig: AIConfig;
  baseUrl?: string;
  platform?: 'web' | 'android' | 'ios';
  additionalContext?: string;
  maxRetries?: number;
  source?: SourceConfig | null;
  onProgress?: (event: GenerateProgressEvent) => void;
}

export interface GenerateProgressEvent {
  type: 'GenerateProgress';
  message: string;
}

export interface GeneratorResult {
  success: boolean;
  test?: z.infer<typeof TestDefinitionSchema>;
  yaml?: string;
  error?: string;
  attempts?: number;
}

interface GenerateEventPayload {
  systemPrompt: string;
  userPrompt: string;
}

const SUBMIT_TEST_YAML_TOOL: JsToolDef = {
  name: 'submit_test_yaml',
  description:
    'Submit your final YAML test definition for validation. The system will parse the YAML and validate it against the TestDefinition schema; if validation fails, the error message is returned and you can try again.',
  parameters: {
    type: 'object',
    properties: {
      yaml: {
        type: 'string',
        description: 'The complete YAML test definition document.',
      },
    },
    required: ['yaml'],
  },
};

export async function generateTest(
  naturalLanguage: string,
  options: GeneratorOptions,
): Promise<GeneratorResult> {
  const maxRetries = options.maxRetries ?? 3;
  const model = buildModel(options.aiConfig);
  const completionOptions = buildCompletionOptions(options.aiConfig);

  const wf = new Workflow('test-generation');

  wf.addStep(
    'scan',
    ['blazen::StartEvent'],
    async (_event: Record<string, unknown>, ctx: Context) => {
      let systemPrompt = SYSTEM_PROMPT;

      if (options.source !== null) {
        await ctx.writeEventToStream({
          type: 'GenerateProgress',
          message: 'Scanning project source...',
        });
        const sourceConfig = options.source ?? {};
        const scanResult = await scanProjectSource(sourceConfig);
        if (scanResult.allElements.length > 0) {
          systemPrompt = buildSourceAwareSystemPrompt(scanResult);
        }
      }

      const context: PromptContext = {
        baseUrl: options.baseUrl,
        platform: options.platform,
        additionalContext: options.additionalContext,
      };
      const userPrompt = buildPrompt(naturalLanguage, context);

      await ctx.writeEventToStream({
        type: 'GenerateProgress',
        message: 'Asking the model for a test definition...',
      });

      const payload: GenerateEventPayload = { systemPrompt, userPrompt };
      return { type: 'GenerateEvent', ...payload };
    },
  );

  wf.addStep(
    'generate',
    ['GenerateEvent'],
    async (event: Record<string, unknown>, ctx: Context) => {
      const { systemPrompt, userPrompt } = event as unknown as GenerateEventPayload;

      const captured: Array<{ test: z.infer<typeof TestDefinitionSchema>; yaml: string }> = [];
      let lastError: string | null = null;
      let lastYaml: string | undefined;

      const agentResult = await runAgent(
        model,
        [ChatMessage.system(systemPrompt), ChatMessage.user(userPrompt)],
        [SUBMIT_TEST_YAML_TOOL],
        async (toolName: string, args: unknown) => {
          if (toolName !== 'submit_test_yaml') {
            return { error: `Unknown tool: ${toolName}` };
          }
          const submission = args as { yaml?: unknown };
          if (typeof submission.yaml !== 'string') {
            lastError = 'submit_test_yaml called without a yaml string';
            return { status: 'invalid', error: lastError };
          }
          lastYaml = submission.yaml;
          try {
            const parsed = parse(submission.yaml);
            const validated = TestDefinitionSchema.parse(parsed);
            captured.push({ test: validated, yaml: submission.yaml });
            await ctx.writeEventToStream({
              type: 'GenerateProgress',
              message: 'Validation passed.',
            });
            return { status: 'valid' };
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            await ctx.writeEventToStream({
              type: 'GenerateProgress',
              message: `Validation failed: ${lastError}. Retrying...`,
            });
            return { status: 'invalid', error: lastError };
          }
        },
        {
          maxIterations: maxRetries,
          temperature: completionOptions.temperature,
          maxTokens: completionOptions.maxTokens,
        },
      );

      const hit = captured[0];
      if (hit) {
        const result: GeneratorResult = {
          success: true,
          test: hit.test,
          yaml: hit.yaml,
          attempts: agentResult.iterations,
        };
        return { type: 'blazen::StopEvent', result };
      }

      const result: GeneratorResult = {
        success: false,
        error: lastError
          ? `Failed to generate valid test after ${agentResult.iterations} attempts. Last error: ${lastError}`
          : 'Model did not submit any test YAML',
        yaml: lastYaml,
        attempts: agentResult.iterations,
      };
      return { type: 'blazen::StopEvent', result };
    },
  );

  const onProgress = options.onProgress;
  const result = onProgress
    ? await wf.runStreaming({}, (event: Record<string, unknown>) => {
        if (event.type === 'GenerateProgress' && typeof event.message === 'string') {
          onProgress({ type: 'GenerateProgress', message: event.message });
        }
      })
    : await wf.run({});

  return result.data as GeneratorResult;
}
