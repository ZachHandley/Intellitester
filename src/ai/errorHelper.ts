import { ChatMessage, Workflow } from 'blazen';
import type { Context, JsToolDef } from 'blazen';
import { z } from 'zod';
import type { Action, Locator } from '../core/types';
import type { AIConfig } from './types';
import { buildModel, buildCompletionOptions } from './provider';

export interface ErrorSuggestion {
  hasSuggestion: boolean;
  suggestedSelector?: {
    testId?: string;
    text?: string;
    css?: string;
    role?: string;
    name?: string;
  };
  explanation: string;
}

const SuggestionToolArgs = z.object({
  hasSuggestion: z.boolean(),
  suggestedSelector: z
    .object({
      testId: z.string().optional(),
      text: z.string().optional(),
      css: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  explanation: z.string(),
});

function formatLocator(locator: Locator): string {
  const parts: string[] = [];
  if (locator.testId) parts.push(`testId: "${locator.testId}"`);
  if (locator.text) parts.push(`text: "${locator.text}"`);
  if (locator.css) parts.push(`css: "${locator.css}"`);
  if (locator.xpath) parts.push(`xpath: "${locator.xpath}"`);
  if (locator.role) parts.push(`role: "${locator.role}"`);
  if (locator.name) parts.push(`name: "${locator.name}"`);
  if (locator.description) parts.push(`description: "${locator.description}"`);
  return parts.join(', ');
}

function formatAction(action: Action): string {
  switch (action.type) {
    case 'tap':
      return `tap on element (${formatLocator(action.target)})`;
    case 'input':
      return `input into element (${formatLocator(action.target)})`;
    case 'assert':
      return `assert element exists (${formatLocator(action.target)})`;
    case 'wait':
      return action.target
        ? `wait for element (${formatLocator(action.target)})`
        : `wait ${action.timeout}ms`;
    case 'scroll':
      return action.target
        ? `scroll to element (${formatLocator(action.target)})`
        : `scroll ${action.direction || 'down'}`;
    case 'evaluate': {
      const evaluateAction = action as Extract<Action, { type: 'evaluate' }>;
      return `evaluate page state (expected: ${
        Array.isArray(evaluateAction.expected)
          ? evaluateAction.expected.join(', ')
          : evaluateAction.expected
      })`;
    }
    default:
      return action.type;
  }
}

const SUBMIT_SUGGESTION_TOOL: JsToolDef = {
  name: 'submit_suggestion',
  description:
    'Submit your analysis of the failed web action and suggested better selector. Always call this exactly once.',
  parameters: {
    type: 'object',
    properties: {
      hasSuggestion: {
        type: 'boolean',
        description: 'Whether a better selector can be suggested.',
      },
      suggestedSelector: {
        type: 'object',
        description: 'The replacement selector. Provide at least one field.',
        properties: {
          testId: { type: 'string' },
          text: { type: 'string' },
          css: { type: 'string' },
          role: { type: 'string' },
          name: { type: 'string' },
        },
      },
      explanation: {
        type: 'string',
        description: 'Why this selector is better than the failing one.',
      },
    },
    required: ['hasSuggestion', 'explanation'],
  },
};

export async function getAISuggestion(
  error: string,
  action: Action,
  pageContent: string,
  screenshot?: Buffer,
  aiConfig?: AIConfig,
): Promise<ErrorSuggestion> {
  if (!aiConfig) {
    return {
      hasSuggestion: false,
      explanation: 'AI configuration not provided. Cannot generate suggestions.',
    };
  }

  const model = buildModel(aiConfig);
  const options = buildCompletionOptions(aiConfig);

  const systemPrompt = `You are an expert at analyzing web automation errors and suggesting better element selectors.

Prefer selectors in this order:
1. testId (most reliable)
2. text (good for user-facing elements)
3. role with name (semantic and accessible)
4. css (last resort, but can be precise)

Do not suggest xpath unless absolutely necessary. Always submit your final answer by calling the submit_suggestion tool exactly once.`;

  const userPrompt = `Action failed: ${formatAction(action)}

Error message:
${error}

Page content (truncated to 10000 chars):
${pageContent.slice(0, 10000)}

${screenshot ? '[Screenshot attached but not analyzed in this implementation]' : ''}

Analyze the error and submit a better selector via the submit_suggestion tool. Focus on what went wrong, what would be more reliable, and why.`;

  const wf = new Workflow('ai-error-suggestion');

  wf.addStep('ask', ['blazen::StartEvent'], async (_event: Record<string, unknown>, _ctx: Context) => {
    try {
      const response = await model.completeWithOptions(
        [ChatMessage.system(systemPrompt), ChatMessage.user(userPrompt)],
        { ...options, tools: [SUBMIT_SUGGESTION_TOOL] },
      );

      const call = response.toolCalls?.[0];
      if (!call || call.name !== 'submit_suggestion') {
        return {
          type: 'blazen::StopEvent',
          result: {
            hasSuggestion: false,
            explanation: 'AI did not submit a structured suggestion.',
          } satisfies ErrorSuggestion,
        };
      }

      const parsed = SuggestionToolArgs.safeParse(call.arguments);
      if (!parsed.success) {
        return {
          type: 'blazen::StopEvent',
          result: {
            hasSuggestion: false,
            explanation: `AI suggestion did not match expected schema: ${parsed.error.message}`,
          } satisfies ErrorSuggestion,
        };
      }
      return { type: 'blazen::StopEvent', result: parsed.data satisfies ErrorSuggestion };
    } catch (err) {
      return {
        type: 'blazen::StopEvent',
        result: {
          hasSuggestion: false,
          explanation: `Failed to generate AI suggestion: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ErrorSuggestion,
      };
    }
  });

  const result = await wf.run({});
  return result.data as ErrorSuggestion;
}
