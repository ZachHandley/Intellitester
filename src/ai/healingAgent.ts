import type { Page } from 'playwright';
import type { Action, Locator } from '../core/types';
import type { AIConfig } from './types';
import { createAIProvider } from './provider';

export interface HealingContext {
  page: Page;
  action: Action;
  error: string;
  pageContent: string;
}

export interface HealingResult {
  success: boolean;
  fixedAction?: Action;
  attempts: number;
  explanation: string;
}

interface SelectorCheckResult {
  found: boolean;
  count: number;
  texts?: string[];
  error?: string;
}

async function checkSelector(page: Page, selector: string): Promise<SelectorCheckResult> {
  try {
    const count = await page.locator(selector).count();
    if (count === 0) return { found: false, count: 0 };

    const texts = await page.locator(selector).allTextContents();
    return { found: true, count, texts: texts.slice(0, 5) };
  } catch (e) {
    return { found: false, count: 0, error: String(e) };
  }
}

async function checkByText(page: Page, text: string): Promise<SelectorCheckResult> {
  try {
    const locator = page.getByText(text, { exact: false });
    const count = await locator.count();
    if (count === 0) return { found: false, count: 0 };
    return { found: true, count };
  } catch (e) {
    return { found: false, count: 0, error: String(e) };
  }
}

async function checkByRole(page: Page, role: string, name?: string): Promise<SelectorCheckResult> {
  try {
    const locator = page.getByRole(role as Parameters<Page['getByRole']>[0], name ? { name } : undefined);
    const count = await locator.count();
    if (count === 0) return { found: false, count: 0 };
    return { found: true, count };
  } catch (e) {
    return { found: false, count: 0, error: String(e) };
  }
}

async function checkTestId(page: Page, testId: string): Promise<SelectorCheckResult> {
  try {
    const selector = `[data-testid="${testId}"], #${CSS.escape(testId)}`;
    const count = await page.locator(selector).count();
    return { found: count > 0, count };
  } catch (e) {
    return { found: false, count: 0, error: String(e) };
  }
}

function extractLocatorFromResponse(response: string): Locator | null {
  // Try to extract JSON from the response
  const jsonMatch = response.match(/\{[\s\S]*?"(?:testId|text|css|role)"[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.testId || parsed.text || parsed.css || parsed.role) {
      return parsed as Locator;
    }
  } catch {
    // Try to extract from code blocks
    const codeMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeMatch) {
      try {
        const parsed = JSON.parse(codeMatch[1]);
        if (parsed.testId || parsed.text || parsed.css || parsed.role) {
          return parsed as Locator;
        }
      } catch {
        // Fallback patterns
      }
    }
  }

  // Fallback: Try to extract specific selector patterns
  const cssMatch = response.match(/css['":\s]+['"]([^'"]+)['"]/i);
  if (cssMatch) return { css: cssMatch[1] };

  const textMatch = response.match(/text['":\s]+['"]([^'"]+)['"]/i);
  if (textMatch) return { text: textMatch[1] };

  const testIdMatch = response.match(/testId['":\s]+['"]([^'"]+)['"]/i);
  if (testIdMatch) return { testId: testIdMatch[1] };

  return null;
}

export async function runHealingAgent(
  context: HealingContext,
  aiConfig: AIConfig,
  maxAttempts: number = 3,
): Promise<HealingResult> {
  const provider = createAIProvider(aiConfig);

  // Get current target info from action
  const currentTarget = 'target' in context.action ? context.action.target : null;

  const systemPrompt = `You are debugging a failing web test action. Your goal is to analyze the page and suggest a working selector.

When suggesting a selector, respond with a JSON object containing ONE of these fields:
- testId: for data-testid attributes (most reliable)
- text: for visible text content
- css: for CSS selectors
- role: for ARIA roles (with optional "name" field)

Example responses:
{"testId": "submit-button"}
{"text": "Sign In"}
{"css": "button.primary"}
{"role": "button", "name": "Submit"}

Prefer selectors in this order of reliability:
1. testId - most stable, unlikely to change
2. text - good for buttons, links
3. role + name - good for accessible elements
4. css - last resort, more brittle

Respond ONLY with the JSON selector object, no other text.`;

  let attempts = 0;
  let lastExplanation = '';

  while (attempts < maxAttempts) {
    attempts++;

    // Build context with validation results
    const validationResults: string[] = [];

    // If we have a current target, check what's wrong with it
    if (currentTarget) {
      if (currentTarget.testId) {
        const result = await checkTestId(context.page, currentTarget.testId);
        validationResults.push(`testId "${currentTarget.testId}": ${result.found ? `found ${result.count} elements` : 'NOT FOUND'}`);
      }
      if (currentTarget.text) {
        const result = await checkByText(context.page, currentTarget.text);
        validationResults.push(`text "${currentTarget.text}": ${result.found ? `found ${result.count} elements` : 'NOT FOUND'}`);
      }
      if (currentTarget.css) {
        const result = await checkSelector(context.page, currentTarget.css);
        validationResults.push(`css "${currentTarget.css}": ${result.found ? `found ${result.count} elements` : 'NOT FOUND'}`);
      }
      if (currentTarget.role) {
        const result = await checkByRole(context.page, currentTarget.role, currentTarget.name);
        validationResults.push(`role "${currentTarget.role}"${currentTarget.name ? ` name="${currentTarget.name}"` : ''}: ${result.found ? `found ${result.count} elements` : 'NOT FOUND'}`);
      }
    }

    const prompt = `Action type: ${context.action.type}
Error: ${context.error}

Failed selector: ${JSON.stringify(currentTarget)}

Validation results:
${validationResults.length > 0 ? validationResults.join('\n') : 'No current selector to validate'}

Page HTML (first 6000 chars):
${context.pageContent.slice(0, 6000)}

Based on the page content, suggest a working selector for this action. Respond with a JSON object.`;

    try {
      const response = await provider.generateCompletion(prompt, systemPrompt);
      const suggestedLocator = extractLocatorFromResponse(response);

      if (!suggestedLocator) {
        lastExplanation = `Attempt ${attempts}: Could not parse selector from AI response`;
        continue;
      }

      // Validate the suggested selector
      let isValid = false;
      if (suggestedLocator.testId) {
        const result = await checkTestId(context.page, suggestedLocator.testId);
        isValid = result.found;
      } else if (suggestedLocator.text) {
        const result = await checkByText(context.page, suggestedLocator.text);
        isValid = result.found;
      } else if (suggestedLocator.css) {
        const result = await checkSelector(context.page, suggestedLocator.css);
        isValid = result.found;
      } else if (suggestedLocator.role) {
        const result = await checkByRole(context.page, suggestedLocator.role, suggestedLocator.name);
        isValid = result.found;
      }

      if (isValid) {
        // Create fixed action with new locator
        const fixedAction = { ...context.action } as Action & { target: Locator };
        if ('target' in fixedAction) {
          fixedAction.target = suggestedLocator;
        }

        return {
          success: true,
          fixedAction: fixedAction as Action,
          attempts,
          explanation: `Found working selector: ${JSON.stringify(suggestedLocator)}`,
        };
      }

      lastExplanation = `Attempt ${attempts}: Suggested selector ${JSON.stringify(suggestedLocator)} did not find any elements`;
    } catch (e) {
      lastExplanation = `Attempt ${attempts}: AI error - ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    success: false,
    attempts,
    explanation: lastExplanation || 'Could not find a working selector within the allowed attempts',
  };
}
