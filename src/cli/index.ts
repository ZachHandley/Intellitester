#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { loadAutotesterConfig, loadTestDefinition } from '../core/loader';
import type { TestDefinition } from '../core/types';
import { runWebTest, type BrowserName } from '../executors/web';
import { generateTest } from '../generator';
import type { AIConfig } from '../ai/types';

const CONFIG_FILENAME = 'autotester.config.yaml';

const logError = (message: string): void => {
  console.error(`Error: ${message}`);
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const collectYamlFiles = async (target: string): Promise<string[]> => {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];

  if (!stat.isDirectory()) {
    throw new Error(`Unsupported target: ${target}`);
  }

  const entries = await fs.readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectYamlFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      files.push(fullPath);
    }
  }
  return files;
};

const writeFileIfMissing = async (filePath: string, contents: string): Promise<void> => {
  if (await fileExists(filePath)) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
};

const initCommand = async (): Promise<void> => {
  const configTemplate = `defaults:
  timeout: 30000
  screenshots: on-failure

platforms:
  web:
    baseUrl: http://localhost:3000
    headless: true

ai:
  provider: anthropic
  model: claude-3-5-sonnet-20241022
  apiKey: \${ANTHROPIC_API_KEY}
  temperature: 0
  maxTokens: 4096

email:
  provider: inbucket
  endpoint: http://localhost:9000

appwrite:
  endpoint: https://cloud.appwrite.io/v1
  projectId: your-project-id
  apiKey: your-api-key
`;

  const sampleTest = `name: Example web smoke test
platform: web
config:
  web:
    baseUrl: http://localhost:3000

steps:
  - type: navigate
    value: /

  - type: assert
    target:
      text: "Welcome"
`;

  await writeFileIfMissing(path.resolve(CONFIG_FILENAME), configTemplate);
  await writeFileIfMissing(path.resolve('tests', 'example.web.test.yaml'), sampleTest);
  console.log('Initialized autotester.config.yaml and tests/example.web.test.yaml');
};

const validateCommand = async (target: string): Promise<void> => {
  const absoluteTarget = path.resolve(target);
  const files = await collectYamlFiles(absoluteTarget);
  if (files.length === 0) {
    throw new Error(`No YAML files found at ${absoluteTarget}`);
  }

  for (const file of files) {
    await loadTestDefinition(file);
    console.log(`✓ ${path.relative(process.cwd(), file)} valid`);
  }
};

const resolveBaseUrl = (test: TestDefinition, configBaseUrl?: string): string | undefined =>
  test.config?.web?.baseUrl ?? configBaseUrl;

const runCommand = async (
  target: string,
  flags: Record<string, string | boolean>,
): Promise<void> => {
  const absoluteTarget = path.resolve(target);
  const test = await loadTestDefinition(absoluteTarget);
  const hasConfigFile = await fileExists(CONFIG_FILENAME);
  const config = hasConfigFile ? await loadAutotesterConfig(CONFIG_FILENAME) : undefined;

  const baseUrl = resolveBaseUrl(test, config?.platforms?.web?.baseUrl);
  const headed = Boolean(flags.headed);
  const browser = (flags.browser as BrowserName) ?? 'chromium';

  console.log(
    `Running ${path.basename(absoluteTarget)} on web (${browser}${headed ? ', headed' : ''})`,
  );
  const result = await runWebTest(test, {
    baseUrl,
    headed,
    browser,
    defaultTimeoutMs: config?.defaults?.timeout,
  });

  for (const step of result.steps) {
    const label = `[${step.status === 'passed' ? 'OK' : 'FAIL'}] ${step.action.type}`;
    if (step.error) {
      console.error(`${label} - ${step.error}`);
    } else {
      console.log(label);
    }
  }

  if (result.status === 'failed') {
    process.exitCode = 1;
  }
};

const generateCommand = async (
  prompt: string,
  flags: Record<string, string | boolean>,
): Promise<void> => {
  // 1. Load config file to get AI settings
  const hasConfigFile = await fileExists(CONFIG_FILENAME);
  if (!hasConfigFile) {
    throw new Error('No autotester.config.yaml found. Run "autotester init" first and configure AI settings.');
  }

  const config = await loadAutotesterConfig(CONFIG_FILENAME);
  if (!config.ai) {
    throw new Error('AI configuration missing in autotester.config.yaml. Add "ai:" section with provider, model, and apiKey.');
  }

  // 2. Build options
  const options = {
    aiConfig: config.ai,
    baseUrl: flags.baseUrl as string | undefined,
    platform: flags.platform as 'web' | 'android' | 'ios' | undefined,
  };

  // 3. Generate test
  console.log('Generating test...');
  const result = await generateTest(prompt, options);

  if (!result.success) {
    throw new Error(result.error || 'Failed to generate test');
  }

  // 4. Output
  const outputFile = flags.output as string | undefined;
  if (outputFile) {
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, result.yaml!, 'utf8');
    console.log(`✓ Test saved to ${outputFile}`);
  } else {
    console.log('\n--- Generated Test ---\n');
    console.log(result.yaml);
  }
};

const printHelp = (): void => {
  console.log(`Usage: autotester <command> [options]

Commands:
  init                  Create default config and example test
  validate <path>       Validate a test file or directory of YAML tests
  run <file> [--headed] [--browser=chromium|firefox|webkit]
                        Run a test file
  generate "<prompt>" [--output=<file>] [--platform=web|android|ios] [--baseUrl=<url>]
                        Generate a test from natural language
`);
};

const parseFlags = (args: string[]): Record<string, string | boolean> => {
  const flags: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (arg === '--headed') {
      flags.headed = true;
    } else if (arg.startsWith('--browser=')) {
      flags.browser = arg.split('=')[1];
    } else if (arg.startsWith('--output=')) {
      flags.output = arg.split('=')[1];
    } else if (arg.startsWith('--platform=')) {
      flags.platform = arg.split('=')[1];
    } else if (arg.startsWith('--baseUrl=')) {
      flags.baseUrl = arg.split('=')[1];
    }
  }
  return flags;
};

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);

  try {
    switch (command) {
      case 'init':
        await initCommand();
        break;
      case 'validate': {
        const target = rest[0] ?? 'tests';
        await validateCommand(target);
        break;
      }
      case 'run': {
        const target = rest.find((arg) => !arg.startsWith('-'));
        if (!target) {
          throw new Error('run requires a target file path (YAML test definition)');
        }
        const flags = parseFlags(rest);
        await runCommand(target, flags);
        break;
      }
      case 'generate': {
        const prompt = rest.find((arg) => !arg.startsWith('-'));
        if (!prompt) {
          throw new Error('generate requires a prompt describing the test');
        }
        const flags = parseFlags(rest);
        await generateCommand(prompt, flags);
        break;
      }
      default:
        printHelp();
        if (command) process.exitCode = 1;
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(message);
    process.exitCode = 1;
  }
};

main();
