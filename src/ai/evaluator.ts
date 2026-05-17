import { ChatMessage, Workflow } from 'blazen';
import type { Context, JsToolDef } from 'blazen';
import { createWorker, type Worker, type RecognizeResult } from 'tesseract.js';
import { z } from 'zod';
import type { AIConfig } from './types';
import { buildModel, buildCompletionOptions } from './provider';

export interface EvaluateResult {
  passed: boolean;
  mode: 'ocr' | 'ai';
  reason: string;
  ocrText?: string;
  ocrConfidence?: number;
  aiReason?: string;
  screenshotPath: string;
}

export interface EvaluateOptions {
  expected: string | string[];
  mode: 'ocr' | 'ai' | 'auto';
  regex: boolean;
  prompt?: string;
  confidence: number;
  screenshotBuffer: Buffer;
  screenshotPath: string;
  aiConfig?: AIConfig;
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
    'Submit the structured pass/fail evaluation of the screenshot. Always call this exactly once.',
  parameters: {
    type: 'object',
    properties: {
      passed: {
        type: 'boolean',
        description: 'Whether the screenshot meets the expected criteria.',
      },
      reason: {
        type: 'string',
        description: 'Concise explanation of the decision.',
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

export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const expectedArray = Array.isArray(options.expected) ? options.expected : [options.expected];

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
