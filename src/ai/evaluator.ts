import { createWorker, type Worker, type RecognizeResult } from 'tesseract.js';
import { z } from 'zod';
import type { AIConfig } from './types';
import { createAIProvider } from './provider';

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

// Lazy singleton OCR worker
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

function matchExpected(
  text: string,
  expectedArray: string[],
  useRegex: boolean,
): MatchResult {
  const matched: string[] = [];
  const missing: string[] = [];

  for (const expected of expectedArray) {
    let found = false;

    if (useRegex) {
      try {
        const regex = new RegExp(expected, 'i');
        found = regex.test(text);
      } catch (e) {
        // Invalid regex, treat as literal string
        found = text.toLowerCase().includes(expected.toLowerCase());
      }
    } else {
      found = text.toLowerCase().includes(expected.toLowerCase());
    }

    if (found) {
      matched.push(expected);
    } else {
      missing.push(expected);
    }
  }

  return {
    allMatched: missing.length === 0,
    matched,
    missing,
  };
}

// Zod schema for AI evaluation response
const AIEvaluationResponseSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
});

function extractJSONFromResponse(response: string): unknown {
  // Try to extract JSON from markdown code blocks
  const codeMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeMatch) {
    try {
      return JSON.parse(codeMatch[1]);
    } catch {
      // Continue to fallback
    }
  }

  // Try to find raw JSON in the response
  const jsonMatch = response.match(/\{[\s\S]*?"passed"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Continue to fallback
    }
  }

  // Last resort: try to parse the entire response as JSON
  try {
    return JSON.parse(response);
  } catch {
    throw new Error('Could not extract valid JSON from AI response');
  }
}

async function runAIEvaluation(
  screenshotBuffer: Buffer,
  expectedArray: string[],
  customPrompt?: string,
  aiConfig?: AIConfig,
): Promise<{ passed: boolean; reason: string }> {
  if (!aiConfig) {
    throw new Error('AI configuration is required for AI evaluation mode');
  }

  const provider = createAIProvider(aiConfig);

  if (!provider.generateVisionCompletion) {
    throw new Error(
      `AI provider "${aiConfig.provider}" does not support vision completion. ` +
        'Please use a provider with vision capabilities (e.g., anthropic, openai) or switch to OCR mode.',
    );
  }

  const systemPrompt = `You are evaluating a screenshot against expected content or conditions.
Analyze the image and determine if it matches the criteria.

IMPORTANT: Respond ONLY with a JSON object in this exact format:
{"passed": true, "reason": "explanation"}
or
{"passed": false, "reason": "explanation"}

Do not include any other text, markdown formatting, or explanations outside the JSON object.`;

  const defaultPrompt = `Expected content or conditions:
${expectedArray.map((exp) => `- ${exp}`).join('\n')}

Does the screenshot contain all of the expected content or meet the specified conditions?
Respond with a JSON object containing "passed" (boolean) and "reason" (string explaining your decision).`;

  const prompt = customPrompt || defaultPrompt;
  const imageBase64 = screenshotBuffer.toString('base64');
  const imageMimeType = 'image/png';

  const response = await provider.generateVisionCompletion(
    prompt,
    imageBase64,
    imageMimeType,
    systemPrompt,
  );

  // Extract and validate JSON response
  let parsedResponse: unknown;
  try {
    parsedResponse = extractJSONFromResponse(response);
  } catch (e) {
    throw new Error(
      `Failed to parse AI response: ${e instanceof Error ? e.message : String(e)}. Response: ${response}`,
    );
  }

  const validated = AIEvaluationResponseSchema.parse(parsedResponse);
  return validated;
}

export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const expectedArray = Array.isArray(options.expected)
    ? options.expected
    : [options.expected];

  // Track OCR failure reason for clear error messages
  let ocrFailReason: string | undefined;

  // Mode: OCR or auto (try OCR first)
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

      // Build OCR failure reason
      ocrFailReason = matchResult.missing.length > 0
        ? `OCR did not find expected content: ${matchResult.missing.join(', ')}`
        : `OCR confidence (${ocrResult.confidence.toFixed(1)}%) below threshold (${options.confidence}%)`;

      // If OCR mode only, return failure
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

      // Auto mode: OCR failed, will fall through to AI
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
      // Auto mode: OCR failed, fall through to AI
    }
  }

  // Mode: AI or auto (fallback from OCR)
  if (options.mode === 'ai' || options.mode === 'auto') {
    if (!options.aiConfig) {
      // In auto mode, report the OCR failure + no AI config
      const reason = options.mode === 'auto' && ocrFailReason
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
      // In auto mode, include what OCR found + why AI failed
      const aiError = e instanceof Error ? e.message : String(e);
      const reason = options.mode === 'auto' && ocrFailReason
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

  // Should never reach here
  return {
    passed: false,
    mode: 'ocr',
    reason: 'Invalid evaluation mode',
    screenshotPath: options.screenshotPath,
  };
}
