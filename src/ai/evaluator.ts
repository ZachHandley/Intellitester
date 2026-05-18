import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ChatMessage, Workflow, runAgent } from 'blazen';
import type { Context, JsToolDef } from 'blazen';
import type { Page } from 'playwright';
import { createWorker, type Worker, type RecognizeResult } from 'tesseract.js';
import { z } from 'zod';
import type { AIConfig } from './types';
import { buildModel, buildCompletionOptions } from './provider';

export type EvaluateMode = 'ocr' | 'ai' | 'agent' | 'auto';

export interface EvaluateResult {
  passed: boolean;
  mode: 'ocr' | 'ai' | 'agent';
  reason: string;
  ocrText?: string;
  ocrConfidence?: number;
  aiReason?: string;
  agentIterations?: number;
  screenshotPath: string;
}

export interface EvaluateOptions {
  expected: string | string[];
  mode: EvaluateMode;
  regex: boolean;
  prompt?: string;
  confidence: number;
  screenshotBuffer: Buffer;
  screenshotPath: string;
  aiConfig?: AIConfig;
  // Agent-mode only:
  page?: Page;
  maxSteps?: number;
  customToolsPath?: string;
  workflowDir?: string;
}

interface MatchResult {
  allMatched: boolean;
  matched: string[];
  missing: string[];
}

let ocrWorker: Worker | null = null;

async function getOCRWorker(): Promise<Worker> {
  if (!ocrWorker) {
    ocrWorker = await createWorker('eng');
  }
  return ocrWorker;
}

export async function terminateOCRWorker(): Promise<void> {
  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
  }
}

async function runOCR(screenshotBuffer: Buffer): Promise<{ text: string; confidence: number }> {
  const worker = await getOCRWorker();
  const result: RecognizeResult = await worker.recognize(screenshotBuffer);
  return {
    text: result.data.text,
    confidence: result.data.confidence,
  };
}

function matchExpected(text: string, expectedArray: string[], useRegex: boolean): MatchResult {
  const matched: string[] = [];
  const missing: string[] = [];

  for (const expected of expectedArray) {
    let found = false;
    if (useRegex) {
      try {
        const regex = new RegExp(expected, 'i');
        found = regex.test(text);
      } catch {
        found = text.toLowerCase().includes(expected.toLowerCase());
      }
    } else {
      found = text.toLowerCase().includes(expected.toLowerCase());
    }

    if (found) matched.push(expected);
    else missing.push(expected);
  }

  return { allMatched: missing.length === 0, matched, missing };
}

const AIEvaluationResponseSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
});

const SUBMIT_EVALUATION_TOOL: JsToolDef = {
  name: 'submit_evaluation',
  description:
    'Submit the structured pass/fail evaluation of the page. Call this exactly once when you are confident in your verdict — it is terminal.',
  parameters: {
    type: 'object',
    properties: {
      passed: {
        type: 'boolean',
        description: 'Whether the page meets the expected criteria.',
      },
      reason: {
        type: 'string',
        description: 'Concise explanation of the decision, citing the evidence you observed.',
      },
    },
    required: ['passed', 'reason'],
  },
};

async function runAIEvaluation(
  screenshotBuffer: Buffer,
  expectedArray: string[],
  customPrompt: string | undefined,
  aiConfig: AIConfig,
): Promise<{ passed: boolean; reason: string }> {
  const model = buildModel(aiConfig);
  const options = buildCompletionOptions(aiConfig);

  const systemPrompt = `You are evaluating a screenshot against expected content or conditions.
Analyze the image and submit your decision by calling the submit_evaluation tool exactly once.`;

  const defaultPrompt = `Expected content or conditions:
${expectedArray.map((exp) => `- ${exp}`).join('\n')}

Does the screenshot contain all of the expected content or meet the specified conditions? Submit your decision via the submit_evaluation tool.`;

  const prompt = customPrompt || defaultPrompt;
  const imageBase64 = screenshotBuffer.toString('base64');

  const wf = new Workflow('ai-evaluation');

  wf.addStep(
    'evaluate',
    ['blazen::StartEvent'],
    async (_event: Record<string, unknown>, _ctx: Context) => {
      const response = await model.completeWithOptions(
        [
          ChatMessage.system(systemPrompt),
          ChatMessage.userImageBase64(prompt, imageBase64, 'image/png'),
        ],
        { ...options, tools: [SUBMIT_EVALUATION_TOOL] },
      );

      const call = response.toolCalls?.[0];
      if (!call || call.name !== 'submit_evaluation') {
        throw new Error('AI did not submit a structured evaluation via tool call.');
      }

      const parsed = AIEvaluationResponseSchema.parse(call.arguments);
      return { type: 'blazen::StopEvent', result: parsed };
    },
  );

  const result = await wf.run({});
  return result.data as { passed: boolean; reason: string };
}

// ---------- Agent (multi-turn tool-using) evaluation ----------

type AgentToolResult = { kind: 'text'; text: string };

export interface AgentToolContext {
  page: Page;
}

export interface CustomToolsModule {
  tools: JsToolDef[];
  handler: (
    name: string,
    args: unknown,
    ctx: AgentToolContext,
  ) => Promise<AgentToolResult> | AgentToolResult;
}

const TAKE_SCREENSHOT_TOOL: JsToolDef = {
  name: 'take_screenshot',
  description:
    'Capture a fresh screenshot (saved as a test artifact). NOTE: pixels from this call are NOT shown back to you on the next turn — only the initial screenshot in the user message is visible. For verifying content after scrolling/waiting, use accessibility_snapshot or query_dom (those return real readable data).',
  parameters: {
    type: 'object',
    properties: {
      fullPage: {
        type: 'boolean',
        description: 'Capture full scrollable page (true) or just the current viewport (false). Default: false.',
      },
      selector: {
        type: 'string',
        description: 'Optional CSS selector. If provided, screenshots just that element.',
      },
    },
  },
};

const SCROLL_TOOL: JsToolDef = {
  name: 'scroll',
  description:
    'Scroll the page or a specific element. Use to bring off-screen content into the viewport before re-screenshotting.',
  parameters: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['up', 'down'],
        description: 'Direction to scroll the page.',
      },
      pixels: {
        type: 'number',
        description: 'Pixels to scroll (default 800). Used with `direction`.',
      },
      toBottom: {
        type: 'boolean',
        description: 'Scroll all the way to the bottom of the page.',
      },
      toTop: {
        type: 'boolean',
        description: 'Scroll all the way to the top of the page.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector. If provided, scrolls that element into view instead of moving the page.',
      },
    },
  },
};

const WAIT_TOOL: JsToolDef = {
  name: 'wait',
  description:
    'Pause briefly to let animations or lazy-loaded UI settle before re-checking. Capped at 3000ms.',
  parameters: {
    type: 'object',
    properties: {
      ms: {
        type: 'number',
        description: 'Milliseconds to wait (1-3000).',
      },
    },
    required: ['ms'],
  },
};

const QUERY_DOM_TOOL: JsToolDef = {
  name: 'query_dom',
  description:
    'Look up an element by CSS selector and report whether it exists, is visible, its text content, and its attributes. Useful when pixels are ambiguous (e.g., for <video>, <canvas>, or off-screen content).',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector to query.',
      },
    },
    required: ['selector'],
  },
};

const ACCESSIBILITY_SNAPSHOT_TOOL: JsToolDef = {
  name: 'accessibility_snapshot',
  description:
    'Get the ARIA snapshot (YAML accessibility tree) of the page or a sub-tree. The truth-source when pixels are ambiguous — lists roles, names, and structure as screen readers see them.',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'Optional CSS selector to scope the snapshot to a sub-tree. Default: full body.',
      },
    },
  },
};

const AGENT_BUILTIN_TOOLS: JsToolDef[] = [
  TAKE_SCREENSHOT_TOOL,
  SCROLL_TOOL,
  WAIT_TOOL,
  QUERY_DOM_TOOL,
  ACCESSIBILITY_SNAPSHOT_TOOL,
];

const AGENT_BUILTIN_NAMES = new Set(AGENT_BUILTIN_TOOLS.map((t) => t.name));
const RESERVED_TOOL_NAMES = new Set([...AGENT_BUILTIN_NAMES, 'submit_evaluation']);

function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}\n…[truncated ${s.length - limit} chars]`;
}

async function execTakeScreenshot(args: Record<string, unknown>, page: Page): Promise<AgentToolResult> {
  const fullPage = args.fullPage === true;
  const selector = typeof args.selector === 'string' ? args.selector : undefined;
  // The model cannot see images returned from tool results in this Blazen
  // version's runAgent loop (only the initial user-message image is shown).
  // So we capture the screenshot for the test artifact and return a textual
  // summary that nudges the model toward DOM/aria verification, which is the
  // reliable truth source for canvas/<video>/dynamic UI anyway.
  try {
    if (selector) {
      await page.locator(selector).first().screenshot();
    } else {
      await page.screenshot({ fullPage });
    }
    const url = page.url();
    const scope = selector ? `selector="${selector}"` : fullPage ? 'fullPage' : 'viewport';
    return {
      kind: 'text',
      text: `Screenshot captured (${scope}) at ${url}. Note: re-screenshots are not surfaced visually in this loop — use accessibility_snapshot or query_dom to verify the contents you'd want to inspect.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'text', text: `take_screenshot error: ${msg}` };
  }
}

async function execScroll(args: Record<string, unknown>, page: Page): Promise<AgentToolResult> {
  const selector = typeof args.selector === 'string' ? args.selector : undefined;
  const toBottom = args.toBottom === true;
  const toTop = args.toTop === true;
  const direction = args.direction === 'up' ? 'up' : args.direction === 'down' ? 'down' : null;
  const pixels = typeof args.pixels === 'number' ? args.pixels : 800;

  if (selector) {
    await page.locator(selector).first().scrollIntoViewIfNeeded();
    return { kind: 'text', text: `Scrolled "${selector}" into view.` };
  }
  if (toBottom) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    return { kind: 'text', text: 'Scrolled to bottom of page.' };
  }
  if (toTop) {
    await page.evaluate(() => window.scrollTo(0, 0));
    return { kind: 'text', text: 'Scrolled to top of page.' };
  }
  const dy = direction === 'up' ? -pixels : pixels;
  await page.evaluate((y) => window.scrollBy(0, y), dy);
  const pos = await page.evaluate(() => ({ y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight }));
  return { kind: 'text', text: `Scrolled ${dy}px. Now at y=${Math.round(pos.y)} / ${Math.round(pos.max)} (max).` };
}

async function execWait(args: Record<string, unknown>, page: Page): Promise<AgentToolResult> {
  const requested = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 500;
  const ms = Math.min(Math.floor(requested), 3000);
  await page.waitForTimeout(ms);
  return { kind: 'text', text: `Waited ${ms}ms${requested !== ms ? ` (capped from requested ${requested}ms)` : ''}.` };
}

async function execQueryDom(args: Record<string, unknown>, page: Page): Promise<AgentToolResult> {
  const selector = typeof args.selector === 'string' ? args.selector : '';
  if (!selector) return { kind: 'text', text: 'query_dom error: selector is required.' };
  try {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) {
      return { kind: 'text', text: `query_dom: no elements match "${selector}".` };
    }
    const first = locator.first();
    const visible = await first.isVisible().catch(() => false);
    const text = await first.innerText({ timeout: 1000 }).catch(() => '');
    const attributes = await first
      .evaluate((el) => {
        const out: Record<string, string> = {};
        const target = el as Element;
        for (const name of target.getAttributeNames()) {
          out[name] = target.getAttribute(name) ?? '';
        }
        return out;
      })
      .catch(() => ({}));
    const payload = {
      selector,
      count,
      visible,
      text: truncate(text, 2000),
      attributes,
    };
    return { kind: 'text', text: JSON.stringify(payload, null, 2) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'text', text: `query_dom error: ${msg}` };
  }
}

async function execAccessibilitySnapshot(args: Record<string, unknown>, page: Page): Promise<AgentToolResult> {
  const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector : 'body';
  try {
    const locator = page.locator(selector).first();
    const count = await locator.count();
    if (count === 0) {
      return { kind: 'text', text: `accessibility_snapshot: selector "${selector}" did not match any element.` };
    }
    const snap = await locator.ariaSnapshot({ timeout: 5000 });
    return { kind: 'text', text: truncate(snap, 8000) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'text', text: `accessibility_snapshot error: ${msg}` };
  }
}

async function dispatchBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  page: Page,
): Promise<AgentToolResult> {
  switch (name) {
    case 'take_screenshot':
      return execTakeScreenshot(args, page);
    case 'scroll':
      return execScroll(args, page);
    case 'wait':
      return execWait(args, page);
    case 'query_dom':
      return execQueryDom(args, page);
    case 'accessibility_snapshot':
      return execAccessibilitySnapshot(args, page);
    default:
      throw new Error(`Unknown built-in tool: ${name}`);
  }
}

async function loadCustomTools(
  toolsPath: string,
  workflowDir: string,
): Promise<CustomToolsModule> {
  const resolved = path.isAbsolute(toolsPath) ? toolsPath : path.resolve(workflowDir, toolsPath);
  const href = pathToFileURL(resolved).href;
  const mod: unknown = await import(href);
  const candidate =
    (mod && typeof mod === 'object' && 'default' in mod
      ? (mod as { default: unknown }).default
      : mod) ?? mod;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !Array.isArray((candidate as CustomToolsModule).tools) ||
    typeof (candidate as CustomToolsModule).handler !== 'function'
  ) {
    throw new Error(
      `Custom tools module at ${resolved} must export { tools: JsToolDef[], handler: (name, args, ctx) => AgentToolResult }`,
    );
  }
  const out = candidate as CustomToolsModule;
  for (const tool of out.tools) {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error(`Custom tools module at ${resolved}: every tool must have a string \`name\`.`);
    }
    if (RESERVED_TOOL_NAMES.has(tool.name)) {
      throw new Error(
        `Custom tools module at ${resolved}: tool name "${tool.name}" collides with a reserved built-in tool. Rename it.`,
      );
    }
  }
  return out;
}


class SubmitEvaluationSignal extends Error {
  constructor(public passed: boolean, public reason: string) {
    super('SubmitEvaluationSignal');
    this.name = 'SubmitEvaluationSignal';
  }
}

async function runAgentEvaluation(
  initialScreenshot: Buffer,
  expectedArray: string[],
  customPrompt: string | undefined,
  aiConfig: AIConfig,
  page: Page,
  opts: { maxSteps: number; customToolsPath?: string; workflowDir: string },
): Promise<{ passed: boolean; reason: string; iterations: number }> {
  const model = buildModel(aiConfig);
  const completionOptions = buildCompletionOptions(aiConfig);

  let customTools: JsToolDef[] = [];
  let customHandler: CustomToolsModule['handler'] | undefined;
  if (opts.customToolsPath) {
    const mod = await loadCustomTools(opts.customToolsPath, opts.workflowDir);
    customTools = mod.tools;
    customHandler = mod.handler;
  }

  const allTools: JsToolDef[] = [
    ...AGENT_BUILTIN_TOOLS,
    ...customTools,
    SUBMIT_EVALUATION_TOOL,
  ];

  const systemPrompt = `You are auditing a web page to decide whether the user's expected condition holds.

The initial screenshot of the page is attached to the user message — that is the ONLY image you can see. Re-screenshots are not shown back to you (they are saved as artifacts only). After scrolling/waiting, verify content by reading the DOM, NOT by re-screenshotting.

Tools:
  - accessibility_snapshot: returns the ARIA tree (YAML) of a region — the truth source for what is rendered. Use this to confirm structure (lists, regions, roles, accessible names).
  - query_dom: returns count/visibility/text/attributes for a CSS selector.
  - scroll: move the page (by pixels, to-bottom/top, or scroll a selector into view).
  - wait: pause up to 3000ms for animations/lazy loads.
  - take_screenshot: captures an artifact (you do not see the result image — informational only).
  - submit_evaluation: terminal — call exactly once with { passed, reason } when confident.

Workflow: examine the initial screenshot. If the expected content isn't in view, scroll to where it should live, then use accessibility_snapshot or query_dom to confirm. Be efficient. Call submit_evaluation once you have enough evidence.`;

  const defaultUserPrompt = `Expected content or conditions:
${expectedArray.map((exp) => `- ${exp}`).join('\n')}

Investigate the page using the available tools. When confident, call submit_evaluation with your verdict.`;

  const userPromptText = customPrompt || defaultUserPrompt;
  const imageBase64 = initialScreenshot.toString('base64');

  const messages = [
    ChatMessage.system(systemPrompt),
    ChatMessage.userImageBase64(userPromptText, imageBase64, 'image/png'),
  ];

  let submission: { passed: boolean; reason: string } | undefined;

  const toolHandler = async (name: string, rawArgs: unknown): Promise<string> => {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;

    if (name === 'submit_evaluation') {
      const parsed = AIEvaluationResponseSchema.parse(args);
      submission = parsed;
      throw new SubmitEvaluationSignal(parsed.passed, parsed.reason);
    }

    let result: AgentToolResult;
    if (AGENT_BUILTIN_NAMES.has(name)) {
      result = await dispatchBuiltinTool(name, args, page);
    } else if (customHandler) {
      result = await customHandler(name, args, { page });
    } else {
      result = { kind: 'text', text: `Unknown tool: ${name}` };
    }
    // Return a plain string — Blazen auto-wraps to a text tool-result message
    // the model can read. (Returning structured ToolOutput.llmOverride hits a
    // serde tag mismatch in the napi binding for this Blazen version.)
    return result.text;
  };

  let iterations = 0;
  try {
    const agentResult = await runAgent(model, messages, allTools, toolHandler, {
      maxIterations: opts.maxSteps,
      temperature: completionOptions.temperature ?? undefined,
      maxTokens: completionOptions.maxTokens ?? undefined,
      noFinishTool: true,
    });
    iterations = agentResult.iterations;
  } catch (e) {
    // Blazen's napi runAgent wraps thrown errors from JS tool handlers into
    // its own GenericFailure error type, so `instanceof SubmitEvaluationSignal`
    // does not work. Trust the closure: if `submission` was set, the throw
    // was our terminate signal and we re-raise otherwise.
    if (!submission) {
      throw e;
    }
  }

  if (!submission) {
    throw new Error(
      `Agent exhausted ${opts.maxSteps} iterations without calling submit_evaluation.`,
    );
  }

  return {
    passed: submission.passed,
    reason: submission.reason,
    iterations: iterations || opts.maxSteps,
  };
}

export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const expectedArray = Array.isArray(options.expected) ? options.expected : [options.expected];

  if (options.mode === 'agent') {
    if (!options.aiConfig) {
      return {
        passed: false,
        mode: 'agent',
        reason: 'Agent evaluation requested but no AI configuration provided',
        screenshotPath: options.screenshotPath,
      };
    }
    if (!options.page) {
      return {
        passed: false,
        mode: 'agent',
        reason: 'Agent evaluation requires a live Page (internal wiring error)',
        screenshotPath: options.screenshotPath,
      };
    }
    try {
      const agentResult = await runAgentEvaluation(
        options.screenshotBuffer,
        expectedArray,
        options.prompt,
        options.aiConfig,
        options.page,
        {
          maxSteps: options.maxSteps ?? 6,
          customToolsPath: options.customToolsPath,
          workflowDir: options.workflowDir ?? process.cwd(),
        },
      );
      return {
        passed: agentResult.passed,
        mode: 'agent',
        reason: agentResult.reason,
        aiReason: agentResult.reason,
        agentIterations: agentResult.iterations,
        screenshotPath: options.screenshotPath,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        passed: false,
        mode: 'agent',
        reason: `Agent evaluation failed: ${msg}`,
        screenshotPath: options.screenshotPath,
      };
    }
  }

  let ocrFailReason: string | undefined;

  if (options.mode === 'ocr' || options.mode === 'auto') {
    try {
      const ocrResult = await runOCR(options.screenshotBuffer);
      const matchResult = matchExpected(ocrResult.text, expectedArray, options.regex);
      const ocrPassed = matchResult.allMatched && ocrResult.confidence >= options.confidence;

      if (ocrPassed) {
        return {
          passed: true,
          mode: 'ocr',
          reason: `OCR matched all expected content with ${ocrResult.confidence.toFixed(1)}% confidence`,
          ocrText: ocrResult.text,
          ocrConfidence: ocrResult.confidence,
          screenshotPath: options.screenshotPath,
        };
      }

      ocrFailReason =
        matchResult.missing.length > 0
          ? `OCR did not find expected content: ${matchResult.missing.join(', ')}`
          : `OCR confidence (${ocrResult.confidence.toFixed(1)}%) below threshold (${options.confidence}%)`;

      if (options.mode === 'ocr') {
        return {
          passed: false,
          mode: 'ocr',
          reason: ocrFailReason,
          ocrText: ocrResult.text,
          ocrConfidence: ocrResult.confidence,
          screenshotPath: options.screenshotPath,
        };
      }
    } catch (e) {
      ocrFailReason = `OCR failed: ${e instanceof Error ? e.message : String(e)}`;
      if (options.mode === 'ocr') {
        return {
          passed: false,
          mode: 'ocr',
          reason: ocrFailReason,
          screenshotPath: options.screenshotPath,
        };
      }
    }
  }

  if (options.mode === 'ai' || options.mode === 'auto') {
    if (!options.aiConfig) {
      const reason =
        options.mode === 'auto' && ocrFailReason
          ? `${ocrFailReason}. No AI provider configured to fall back on`
          : 'AI evaluation requested but no AI configuration provided';

      return {
        passed: false,
        mode: options.mode === 'auto' ? 'ocr' : 'ai',
        reason,
        screenshotPath: options.screenshotPath,
      };
    }

    try {
      const aiResult = await runAIEvaluation(
        options.screenshotBuffer,
        expectedArray,
        options.prompt,
        options.aiConfig,
      );

      return {
        passed: aiResult.passed,
        mode: 'ai',
        reason: aiResult.reason,
        aiReason: aiResult.reason,
        screenshotPath: options.screenshotPath,
      };
    } catch (e) {
      const aiError = e instanceof Error ? e.message : String(e);
      const reason =
        options.mode === 'auto' && ocrFailReason
          ? `${ocrFailReason}. AI fallback also failed: ${aiError}`
          : `AI evaluation failed: ${aiError}`;

      return {
        passed: false,
        mode: 'ai',
        reason,
        screenshotPath: options.screenshotPath,
      };
    }
  }

  return {
    passed: false,
    mode: 'ocr',
    reason: 'Invalid evaluation mode',
    screenshotPath: options.screenshotPath,
  };
}
