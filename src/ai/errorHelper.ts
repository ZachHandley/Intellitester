import type { Action, Locator } from '../core/types';
import type { AIConfig } from './types';
import { createAIProvider } from './provider';

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
      return action.target ? `wait for element (${formatLocator(action.target)})` : `wait ${action.timeout}ms`;
    case 'scroll':
      return action.target ? `scroll to element (${formatLocator(action.target)})` : `scroll ${action.direction || 'down'}`;
    default:
      return action.type;
  }
}

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

  try {
    const provider = createAIProvider(aiConfig);

    const systemPrompt = `You are an expert at analyzing web automation errors and suggesting better element selectors.
Your task is to analyze failed actions and suggest better selectors based on the page content and error message.

Return your response in the following JSON format:
{
  "hasSuggestion": boolean,
  "suggestedSelector": {
    "testId": "string (optional)",
    "text": "string (optional)",
    "css": "string (optional)",
    "role": "string (optional)",
    "name": "string (optional)"
  },
  "explanation": "string explaining why this selector is better"
}

Prefer selectors in this order:
1. testId (most reliable)
2. text (good for user-facing elements)
3. role with name (semantic and accessible)
4. css (last resort, but can be precise)

Do not suggest xpath unless absolutely necessary.`;

    const prompt = `Action failed: ${formatAction(action)}

Error message:
${error}

Page content (truncated to 10000 chars):
${pageContent.slice(0, 10000)}

${screenshot ? '[Screenshot attached but not analyzed in this implementation]' : ''}

Please analyze the error and suggest a better selector that would work reliably. Focus on:
- What went wrong with the current selector
- What selector would be more reliable
- Why the suggested selector is better

Return ONLY valid JSON, no additional text.`;

    const response = await provider.generateCompletion(prompt, systemPrompt);

    // Extract JSON from response (in case AI returns markdown code blocks)
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(jsonStr) as ErrorSuggestion;
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      hasSuggestion: false,
      explanation: `Failed to generate AI suggestion: ${message}`,
    };
  }
}
