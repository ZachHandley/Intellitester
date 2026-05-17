import { ChatMessage, Workflow, runAgent } from 'blazen';
import type { Context, JsToolDef } from 'blazen';
import type { Page } from 'playwright';
import type { Action, Locator } from '../core/types';
import type { AIConfig } from './types';
import { buildModel, buildCompletionOptions } from './provider';
import { cssEscape } from '../executors/web/cssEscape';

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

async function checkByRole(
  page: Page,
  role: string,
  name?: string,
): Promise<SelectorCheckResult> {
  try {
    const locator = page.getByRole(
      role as Parameters<Page['getByRole']>[0],
      name ? { name } : undefined,
    );
    const count = await locator.count();
    if (count === 0) return { found: false, count: 0 };
    return { found: true, count };
  } catch (e) {
    return { found: false, count: 0, error: String(e) };
  }
}

async function checkTestId(page: Page, testId: string): Promise<SelectorCheckResult> {
  try {
    const selector = `[data-testid="${testId}"], #${cssEscape(testId)}`;
    const count = await page.locator(selector).count();
    return { found: count > 0, count };
  } catch (e) {
    return { found: false, count: 0, error: String(e) };
  }
}

async function validateLocator(page: Page, locator: Locator): Promise<SelectorCheckResult> {
  if (locator.testId) return checkTestId(page, locator.testId);
  if (locator.text) return checkByText(page, locator.text);
  if (locator.css) return checkSelector(page, locator.css);
  if (locator.role) return checkByRole(page, locator.role, locator.name);
  return { found: false, count: 0, error: 'No selector field provided' };
}

const SELECTOR_FIELDS = {
  type: 'object',
  description: 'Selector with at least one of testId / text / css / role provided.',
  properties: {
    testId: { type: 'string', description: 'data-testid attribute value (most reliable).' },
    text: { type: 'string', description: 'Visible text content to match.' },
    css: { type: 'string', description: 'CSS selector (last resort).' },
    role: { type: 'string', description: 'ARIA role.' },
    name: { type: 'string', description: 'Optional accessible name (used with role).' },
  },
} as const;

const VALIDATE_SELECTOR_TOOL: JsToolDef = {
  name: 'validate_selector',
  description:
    'Try a candidate selector against the live page and get back whether it finds an element.',
  parameters: SELECTOR_FIELDS,
};

const FINALIZE_SELECTOR_TOOL: JsToolDef = {
  name: 'finalize_selector',
  description:
    'Commit your final selector. The system validates it; if the selector finds an element the workflow succeeds, otherwise you may try again until iterations run out.',
  parameters: SELECTOR_FIELDS,
};

export async function runHealingAgent(
  context: HealingContext,
  aiConfig: AIConfig,
  maxAttempts: number = 3,
): Promise<HealingResult> {
  const model = buildModel(aiConfig);
  const completionOptions = buildCompletionOptions(aiConfig);

  const currentTarget = 'target' in context.action ? (context.action.target as Locator) : null;
  const initialValidation: string[] = [];
  if (currentTarget) {
    const res = await validateLocator(context.page, currentTarget);
    initialValidation.push(
      `Failing target ${JSON.stringify(currentTarget)}: ${
        res.found ? `found ${res.count} elements` : 'NOT FOUND'
      }${res.error ? ` (${res.error})` : ''}`,
    );
  }

  const systemPrompt = `You are debugging a failing web test action by finding a working element selector.

Prefer selectors in this order:
1. testId (most stable)
2. text (good for buttons, links)
3. role with name (semantic and accessible)
4. css (last resort)

Use the validate_selector tool to probe candidates against the live page. When you find one that works, call finalize_selector to commit. You have a limited budget of iterations.`;

  const userPrompt = `Action type: ${context.action.type}
Error: ${context.error}

Failed selector: ${JSON.stringify(currentTarget)}

Initial validation:
${initialValidation.length > 0 ? initialValidation.join('\n') : 'No current selector to validate'}

Page HTML (first 6000 chars):
${context.pageContent.slice(0, 6000)}

Find a working selector for this action.`;

  const wf = new Workflow('ai-healing-agent');

  wf.addStep(
    'heal',
    ['blazen::StartEvent'],
    async (_event: Record<string, unknown>, _ctx: Context) => {
      let chosen: Locator | null = null;
      let lastFailure: string | null = null;

      const agentResult = await runAgent(
        model,
        [ChatMessage.system(systemPrompt), ChatMessage.user(userPrompt)],
        [VALIDATE_SELECTOR_TOOL, FINALIZE_SELECTOR_TOOL],
        async (toolName: string, args: unknown) => {
          const locator = args as Locator;
          if (toolName === 'validate_selector') {
            const r = await validateLocator(context.page, locator);
            return r.found
              ? { found: true, count: r.count, sample: r.texts ?? [] }
              : { found: false, count: 0, error: r.error ?? 'No matching elements' };
          }
          if (toolName === 'finalize_selector') {
            const r = await validateLocator(context.page, locator);
            if (r.found) {
              chosen = locator;
              return { status: 'committed', count: r.count };
            }
            lastFailure = `Selector ${JSON.stringify(locator)} did not match any elements`;
            return { status: 'rejected', error: lastFailure };
          }
          return { error: `Unknown tool: ${toolName}` };
        },
        {
          maxIterations: maxAttempts,
          temperature: completionOptions.temperature,
          maxTokens: completionOptions.maxTokens,
        },
      );

      if (chosen) {
        const fixedAction = { ...context.action } as Action & { target: Locator };
        if ('target' in fixedAction) {
          fixedAction.target = chosen;
        }
        return {
          type: 'blazen::StopEvent',
          result: {
            success: true,
            fixedAction: fixedAction as Action,
            attempts: agentResult.iterations,
            explanation: `Found working selector: ${JSON.stringify(chosen)}`,
          } satisfies HealingResult,
        };
      }

      return {
        type: 'blazen::StopEvent',
        result: {
          success: false,
          attempts: agentResult.iterations,
          explanation:
            lastFailure ??
            `Could not find a working selector within ${maxAttempts} iterations`,
        } satisfies HealingResult,
      };
    },
  );

  const result = await wf.run({});
  return result.data as HealingResult;
}
