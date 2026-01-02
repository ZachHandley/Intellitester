/**
 * Test generator that converts natural language to YAML test definitions
 */

import { parse } from 'yaml';
import type { z } from 'zod';
import { TestDefinitionSchema } from '../core/schema';
import type { AIConfig } from '../ai/types';
import { createAIProvider } from '../ai/provider';
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
  source?: SourceConfig | null; // null = explicitly disabled, undefined = auto-detect
}

export interface GeneratorResult {
  success: boolean;
  test?: z.infer<typeof TestDefinitionSchema>;
  yaml?: string;
  error?: string;
  attempts?: number;
}

/**
 * Strips markdown code blocks from YAML content
 */
function cleanYamlResponse(response: string): string {
  // Remove markdown YAML code blocks
  let cleaned = response.replace(/```ya?ml\n?/gi, '').replace(/```\n?/g, '');

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Generates a test definition from natural language description
 *
 * @param naturalLanguage - The natural language test description
 * @param options - Generator configuration options
 * @returns Promise resolving to the generation result
 */
export async function generateTest(
  naturalLanguage: string,
  options: GeneratorOptions,
): Promise<GeneratorResult> {
  const provider = createAIProvider(options.aiConfig);

  // Scan source if configured (default to auto-detect)
  let systemPrompt = SYSTEM_PROMPT;
  if (options.source !== null) {
    // null = explicitly disabled
    const sourceConfig = options.source ?? {}; // empty = auto-detect
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
  const maxRetries = options.maxRetries ?? 3;

  let lastError: Error | undefined;
  let lastYaml: string | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Build retry-specific prompt with feedback from previous attempt
      let promptWithFeedback = userPrompt;
      if (attempt > 0 && lastError) {
        promptWithFeedback = `${userPrompt}\n\nPrevious attempt failed with error: ${lastError.message}\n\nPlease fix the issue and generate valid YAML.`;
      }

      // Generate completion from AI using the system prompt (possibly source-aware)
      const response = await provider.generateCompletion(promptWithFeedback, systemPrompt);

      // Clean the response
      const yaml = cleanYamlResponse(response);
      lastYaml = yaml;

      // Parse YAML
      const parsed = parse(yaml);

      // Validate against schema
      const validated = TestDefinitionSchema.parse(parsed);

      // Success!
      return {
        success: true,
        test: validated,
        yaml,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If this was the last retry, return failure
      if (attempt === maxRetries - 1) {
        return {
          success: false,
          error: `Failed to generate valid test after ${maxRetries} attempts. Last error: ${lastError.message}`,
          yaml: lastYaml,
          attempts: maxRetries,
        };
      }

      // Otherwise, continue to next retry
    }
  }

  // This should never be reached, but TypeScript wants it
  return {
    success: false,
    error: 'Unknown error occurred during test generation',
    attempts: maxRetries,
  };
}
