#!/usr/bin/env node
import dotenv from 'dotenv';

// Load .env from current working directory
dotenv.config();

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';

import { spawn, type ChildProcess } from 'node:child_process';

import { loadIntellitesterConfig, loadTestDefinition, loadWorkflowDefinition, isWorkflowFile, isPipelineFile, loadPipelineDefinition, collectMissingEnvVars, isWorkflowContent, isPipelineContent } from '../core/loader';
import { runPipeline } from '../executors/web/pipelineExecutor';
import type { TestDefinition } from '../core/types';
import { runWebTest, type BrowserName } from '../executors/web';
import { runWorkflow } from '../executors/web/workflowExecutor';
import { generateTest } from '../generator';
import type { AIConfig as _AIConfig } from '../ai/types';
import { loadFailedCleanups, removeFailedCleanup } from '../core/cleanup/persistence.js';
import { loadCleanupHandlers, executeCleanup } from '../core/cleanup/index.js';
import type { CleanupConfig } from '../core/cleanup/types.js';
import { validateEnvVars } from './envHelper';

const CONFIG_FILENAME = 'intellitester.config.yaml';

/**
 * Map common browser names to Playwright browser names.
 */
const BROWSER_ALIASES: Record<string, BrowserName> = {
  chrome: 'chromium',
  chromium: 'chromium',
  safari: 'webkit',
  webkit: 'webkit',
  firefox: 'firefox',
  ff: 'firefox',
};

const resolveBrowserName = (input: string): BrowserName => {
  const normalized = input.toLowerCase().trim();
  const resolved = BROWSER_ALIASES[normalized];
  if (!resolved) {
    const valid = Object.keys(BROWSER_ALIASES).join(', ');
    throw new Error(`Unknown browser "${input}". Valid options: ${valid}`);
  }
  return resolved;
};

/**
 * Detect package manager from lockfile.
 */
const detectPackageManager = async (): Promise<'pnpm' | 'npm' | 'yarn' | 'bun'> => {
  if (await fileExists('pnpm-lock.yaml')) return 'pnpm';
  if (await fileExists('bun.lockb')) return 'bun';
  if (await fileExists('yarn.lock')) return 'yarn';
  return 'npm';
};

/**
 * Run a command and wait for it to complete.
 */
const execCommand = async (cmd: string, args: string[], cwd: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
};

/**
 * Build the project and start preview server.
 * Returns the preview server process and cleanup function.
 */
const buildAndPreview = async (
  config: any,
  cwd: string,
  freshBuild = false
): Promise<{ previewProcess: ChildProcess | null; cleanup: () => void }> => {
  const pm = await detectPackageManager();
  const previewConfig = config?.preview || {};

  // Get build command (default: pm run build)
  const buildCmd = previewConfig.build?.command || `${pm} run build`;
  const [buildExec, ...buildArgs] = buildCmd.split(' ');

  // Get preview command (default: pm run preview)
  const previewCmd = previewConfig.preview?.command || `${pm} run preview`;
  const [previewExec, ...previewArgs] = previewCmd.split(' ');

  // Get preview URL (default from webServer or baseUrl)
  const previewUrl = previewConfig.url || config?.webServer?.url || config?.platforms?.web?.baseUrl || 'http://localhost:4321';
  const timeout = previewConfig.timeout || 60000;

  // Check if build artifacts exist
  const fs = await import('fs/promises');
  const buildDirs = ['dist', 'build', '.next', '.output', '.astro'];
  const hasArtifacts = await Promise.all(
    buildDirs.map(dir => fs.access(dir).then(() => true).catch(() => false))
  );
  const artifactsExist = hasArtifacts.some(Boolean);

  // Run build (unless artifacts exist and --fresh-build not set)
  if (!artifactsExist || freshBuild) {
    console.log('\n📦 Building project...\n');
    await execCommand(buildExec, buildArgs, cwd);
    console.log('\n✅ Build complete\n');
  } else {
    console.log('\n⏭️ Skipping build (using existing artifacts)\n');
  }

  // Start preview server
  console.log('\n🚀 Starting preview server...\n');
  const previewProcess = await startPreviewServer(previewExec, previewArgs, cwd, previewUrl, timeout);

  const cleanup = () => {
    if (previewProcess && !previewProcess.killed) {
      console.log('\n🛑 Stopping preview server...');
      previewProcess.kill('SIGTERM');
    }
  };

  // Handle cleanup on exit
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return { previewProcess, cleanup };
};

/**
 * Start a preview server and wait for it to be ready.
 */
const startPreviewServer = async (
  cmd: string,
  args: string[],
  cwd: string,
  url: string,
  timeout: number = 60000
): Promise<ChildProcess> => {
  return new Promise((resolve, reject) => {
    console.log(`Starting preview server: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'pipe',
      shell: true,
    });

    let output = '';
    const startTime = Date.now();

    const checkServer = async () => {
      try {
        const response = await fetch(url, { method: 'HEAD' });
        if (response.ok || response.status < 500) {
          console.log(`Preview server ready at ${url}`);
          resolve(child);
          return true;
        }
      } catch {
        // Server not ready yet
      }
      return false;
    };

    // Poll for server readiness
    const pollInterval = setInterval(async () => {
      if (await checkServer()) {
        clearInterval(pollInterval);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(pollInterval);
        child.kill();
        reject(new Error(`Preview server failed to start within ${timeout}ms`));
      }
    }, 500);

    child.stdout?.on('data', (data) => {
      output += data.toString();
      process.stdout.write(data);
    });

    child.stderr?.on('data', (data) => {
      output += data.toString();
      process.stderr.write(data);
    });

    child.on('error', (err) => {
      clearInterval(pollInterval);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(pollInterval);
      if (code !== 0 && code !== null) {
        reject(new Error(`Preview server exited with code ${code}\n${output}`));
      }
    });
  });
};

const logError = (message: string): void => {
  console.error(`Error: ${message}`);
};

/**
 * Find the project root directory by walking up from the given path
 * until we find a directory containing package.json, .git, or intellitester.config.yaml
 */
const findProjectRoot = async (startPath: string): Promise<string | null> => {
  let currentDir = path.isAbsolute(startPath) ? startPath : path.resolve(startPath);

  // If startPath is a file, start from its directory
  try {
    const stat = await fs.stat(currentDir);
    if (stat.isFile()) {
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // If stat fails, assume it's a directory or use dirname
    currentDir = path.dirname(currentDir);
  }

  // Walk up the directory tree
  const root = path.parse(currentDir).root;
  while (currentDir !== root) {
    // Check for project markers
    const markers = ['package.json', '.git', CONFIG_FILENAME];
    for (const marker of markers) {
      if (await fileExists(path.join(currentDir, marker))) {
        return currentDir;
      }
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached root
    currentDir = parentDir;
  }

  return null; // No project root found
};

/**
 * Load .env file from the project directory
 */
const loadProjectEnv = async (targetPath: string): Promise<void> => {
  const projectRoot = await findProjectRoot(targetPath);
  if (projectRoot) {
    const envPath = path.join(projectRoot, '.env');
    if (await fileExists(envPath)) {
      dotenv.config({ path: envPath, override: false });
      console.log(`Loaded .env from ${projectRoot}`);
    }
  }
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

/**
 * Auto-discover test files in the tests/ directory.
 * Returns files grouped by type: pipelines first, then workflows, then individual tests.
 * Tests that are referenced by workflows are excluded from standalone test list.
 */
const discoverTestFiles = async (testsDir: string = 'tests'): Promise<{
  pipelines: string[];
  workflows: string[];
  tests: string[];
}> => {
  const absoluteDir = path.resolve(testsDir);

  if (!(await fileExists(absoluteDir))) {
    return { pipelines: [], workflows: [], tests: [] };
  }

  const allFiles = await collectYamlFiles(absoluteDir);

  const pipelines: string[] = [];
  const workflows: string[] = [];
  const allTests: string[] = [];

  for (const file of allFiles) {
    const name = path.basename(file).toLowerCase();
    if (name.endsWith('.pipeline.yaml') || name.endsWith('.pipeline.yml')) {
      pipelines.push(file);
    } else if (name.endsWith('.workflow.yaml') || name.endsWith('.workflow.yml')) {
      workflows.push(file);
    } else if (name.endsWith('.test.yaml') || name.endsWith('.test.yml')) {
      allTests.push(file);
    }
  }

  const { parse } = await import('yaml');

  // Parse pipelines to find workflows they reference
  const workflowsInPipelines = new Set<string>();
  for (const pipelineFile of pipelines) {
    try {
      const content = await fs.readFile(pipelineFile, 'utf8');
      const pipeline = parse(content);
      const pipelineDir = path.dirname(pipelineFile);

      if (pipeline?.workflows && Array.isArray(pipeline.workflows)) {
        for (const workflowRef of pipeline.workflows) {
          if (workflowRef?.file) {
            const absoluteWorkflowPath = path.resolve(pipelineDir, workflowRef.file);
            workflowsInPipelines.add(absoluteWorkflowPath);
          }
        }
      }
    } catch {
      // If we can't parse a pipeline, just continue
    }
  }

  // Filter out workflows that are part of pipelines
  const standaloneWorkflows = workflows.filter(wf => !workflowsInPipelines.has(wf));

  // Parse workflows to find tests they reference, so we don't run them twice
  const testsInWorkflows = new Set<string>();
  for (const workflowFile of workflows) {
    try {
      const content = await fs.readFile(workflowFile, 'utf8');
      const workflow = parse(content);
      const workflowDir = path.dirname(workflowFile);

      if (workflow?.tests && Array.isArray(workflow.tests)) {
        for (const testRef of workflow.tests) {
          if (testRef?.file) {
            const absoluteTestPath = path.resolve(workflowDir, testRef.file);
            testsInWorkflows.add(absoluteTestPath);
          }
        }
      }
    } catch {
      // If we can't parse a workflow, just continue
    }
  }

  // Filter out tests that are part of workflows
  const standaloneTests = allTests.filter(test => !testsInWorkflows.has(test));

  return { pipelines, workflows: standaloneWorkflows, tests: standaloneTests };
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
  console.log('Initialized intellitester.config.yaml and tests/example.web.test.yaml');
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

const runTestCommand = async (
  target: string,
  options: {
    headed?: boolean;
    browser?: BrowserName;
    noServer?: boolean;
    interactive?: boolean;
    debug?: boolean;
    sessionId?: string;
    trackDir?: string;
  },
): Promise<void> => {
  const absoluteTarget = path.resolve(target);

  // Load .env from the project directory
  await loadProjectEnv(absoluteTarget);

  // Validate environment variables before proceeding
  const { parse } = await import('yaml');
  const testContent = await fs.readFile(absoluteTarget, 'utf8');
  const parsedTest = parse(testContent);

  const hasConfigFile = await fileExists(CONFIG_FILENAME);
  let parsedConfig: unknown = undefined;
  if (hasConfigFile) {
    const configContent = await fs.readFile(CONFIG_FILENAME, 'utf8');
    parsedConfig = parse(configContent);
  }

  // Collect missing env vars from both config and test
  const configMissing = parsedConfig ? collectMissingEnvVars(parsedConfig) : [];
  const testMissing = collectMissingEnvVars(parsedTest);
  const allMissing = [...new Set([...configMissing, ...testMissing])];

  if (allMissing.length > 0) {
    const projectRoot = await findProjectRoot(absoluteTarget);
    const canContinue = await validateEnvVars(allMissing, projectRoot || process.cwd());
    if (!canContinue) {
      process.exit(1);
    }
  }

  // Now load and validate with schemas
  const test = await loadTestDefinition(absoluteTarget);
  const config = hasConfigFile ? await loadIntellitesterConfig(CONFIG_FILENAME) : undefined;

  const baseUrl = resolveBaseUrl(test, config?.platforms?.web?.baseUrl);
  const headed = options.headed ?? false;
  const browser = options.browser ?? 'chromium';
  const skipWebServer = options.noServer ?? false;
  const debug = options.debug ?? false;
  const interactive = options.interactive ?? false;

  const modeFlags: string[] = [];
  if (headed) modeFlags.push('headed');
  if (debug) modeFlags.push('debug mode');
  if (interactive) modeFlags.push('interactive');

  console.log(
    `Running ${path.basename(absoluteTarget)} on web (${browser}${modeFlags.length > 0 ? ', ' + modeFlags.join(', ') : ''})`,
  );

  const result = await runWebTest(test, {
    baseUrl,
    headed,
    browser,
    defaultTimeoutMs: config?.defaults?.timeout,
    webServer: !skipWebServer && config?.webServer ? config.webServer : undefined,
    debug,
    interactive,
    aiConfig: interactive ? config?.ai : undefined,
    sessionId: options.sessionId,
    trackDir: options.trackDir,
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
  options: {
    output?: string;
    platform?: 'web' | 'android' | 'ios';
    baseUrl?: string;
    pagesDir?: string;
    componentsDir?: string;
    noSource?: boolean;
  },
): Promise<void> => {
  // Load .env from the project directory (output path or current directory)
  const targetPath = options.output ? path.resolve(options.output) : process.cwd();
  await loadProjectEnv(targetPath);

  // 1. Load config file to get AI settings
  const hasConfigFile = await fileExists(CONFIG_FILENAME);
  if (!hasConfigFile) {
    throw new Error('No intellitester.config.yaml found. Run "intellitester init" first and configure AI settings.');
  }

  // Validate environment variables in config
  const { parse } = await import('yaml');
  const configContent = await fs.readFile(CONFIG_FILENAME, 'utf8');
  const parsedConfig = parse(configContent);
  const configMissing = collectMissingEnvVars(parsedConfig);

  if (configMissing.length > 0) {
    const projectRoot = await findProjectRoot(CONFIG_FILENAME);
    const canContinue = await validateEnvVars(configMissing, projectRoot || process.cwd());
    if (!canContinue) {
      process.exit(1);
    }
  }

  const config = await loadIntellitesterConfig(CONFIG_FILENAME);
  if (!config.ai) {
    throw new Error('AI configuration missing in intellitester.config.yaml. Add "ai:" section with provider, model, and apiKey.');
  }

  // 2. Build source config
  const source = options.noSource ? null : (options.pagesDir || options.componentsDir) ? {
    pagesDir: options.pagesDir,
    componentsDir: options.componentsDir,
  } : undefined;  // undefined = auto-detect

  // 3. Build options
  const generateOptions = {
    aiConfig: config.ai,
    baseUrl: options.baseUrl,
    platform: options.platform,
    source,
  };

  // 4. Generate test
  console.log('Generating test...');
  const result = await generateTest(prompt, generateOptions);

  if (!result.success) {
    throw new Error(result.error || 'Failed to generate test');
  }

  // 5. Output
  if (options.output) {
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(options.output, result.yaml!, 'utf8');
    console.log(`✓ Test saved to ${options.output}`);
  } else {
    console.log('\n--- Generated Test ---\n');
    console.log(result.yaml);
  }
};

interface RunOptions {
  visible?: boolean;
  browser?: BrowserName;
  interactive?: boolean;
  debug?: boolean;
  sessionId?: string;
  trackDir?: string;
}

const runWorkflowCommand = async (file: string, options: RunOptions): Promise<void> => {
  const workflowPath = path.resolve(file);

  if (!(await fileExists(workflowPath))) {
    logError(`Workflow file not found: ${file}`);
    process.exit(1);
  }

  // Load .env from the project directory
  await loadProjectEnv(workflowPath);

  console.log(`Running workflow: ${file}`);

  // Validate environment variables before proceeding
  const { parse } = await import('yaml');
  const workflowContent = await fs.readFile(workflowPath, 'utf8');
  const parsedWorkflow = parse(workflowContent);

  const hasConfigFile = await fileExists(CONFIG_FILENAME);
  let parsedConfig: unknown = undefined;
  if (hasConfigFile) {
    const configContent = await fs.readFile(CONFIG_FILENAME, 'utf8');
    parsedConfig = parse(configContent);
  }

  // Collect missing env vars from both config and workflow
  const configMissing = parsedConfig ? collectMissingEnvVars(parsedConfig) : [];
  const workflowMissing = collectMissingEnvVars(parsedWorkflow);
  const allMissing = [...new Set([...configMissing, ...workflowMissing])];

  if (allMissing.length > 0) {
    const projectRoot = await findProjectRoot(workflowPath);
    const canContinue = await validateEnvVars(allMissing, projectRoot || process.cwd());
    if (!canContinue) {
      process.exit(1);
    }
  }

  // Now load and validate with schemas
  const workflow = await loadWorkflowDefinition(workflowPath);

  // Load config to get AI settings (for interactive mode)
  const config = hasConfigFile ? await loadIntellitesterConfig(CONFIG_FILENAME) : undefined;

  const result = await runWorkflow(workflow, workflowPath, {
    headed: options.visible,
    browser: options.browser,
    interactive: options.interactive,
    debug: options.debug,
    aiConfig: config?.ai,
    webServer: config?.webServer,
    sessionId: options.sessionId,
    trackDir: options.trackDir,
  });

  // Print results
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Status: ${result.status}\n`);

  for (const test of result.tests) {
    const icon = test.status === 'passed' ? '✓' : test.status === 'failed' ? '✗' : '○';
    console.log(`  ${icon} ${test.file} (${test.status})`);
    if (test.error) {
      console.log(`    Error: ${test.error}`);
    }
  }

  if (result.cleanupResult) {
    console.log(`\nCleanup: ${result.cleanupResult.deleted.length} resources deleted`);
    if (result.cleanupResult.failed.length > 0) {
      console.log(`  Failed to delete: ${result.cleanupResult.failed.join(', ')}`);
    }
  }

  process.exit(result.status === 'passed' ? 0 : 1);
};

const runPipelineCommand = async (file: string, options: RunOptions): Promise<void> => {
  const pipelinePath = path.resolve(file);

  if (!(await fileExists(pipelinePath))) {
    logError(`Pipeline file not found: ${file}`);
    process.exit(1);
  }

  // Load .env from the project directory
  await loadProjectEnv(pipelinePath);

  console.log(`Running pipeline: ${file}`);

  // Validate environment variables before proceeding
  const { parse } = await import('yaml');
  const pipelineContent = await fs.readFile(pipelinePath, 'utf8');
  const parsedPipeline = parse(pipelineContent);

  const hasConfigFile = await fileExists(CONFIG_FILENAME);
  let parsedConfig: unknown = undefined;
  if (hasConfigFile) {
    const configContent = await fs.readFile(CONFIG_FILENAME, 'utf8');
    parsedConfig = parse(configContent);
  }

  // Collect missing env vars from both config and pipeline
  const configMissing = parsedConfig ? collectMissingEnvVars(parsedConfig) : [];
  const pipelineMissing = collectMissingEnvVars(parsedPipeline);
  const allMissing = [...new Set([...configMissing, ...pipelineMissing])];

  if (allMissing.length > 0) {
    const projectRoot = await findProjectRoot(pipelinePath);
    const canContinue = await validateEnvVars(allMissing, projectRoot || process.cwd());
    if (!canContinue) {
      process.exit(1);
    }
  }

  // Now load and validate with schemas
  const pipeline = await loadPipelineDefinition(pipelinePath);

  // Load config to get AI settings (for interactive mode)
  const _config = hasConfigFile ? await loadIntellitesterConfig(CONFIG_FILENAME) : undefined;

  const result = await runPipeline(pipeline, pipelinePath, {
    headed: options.visible,
    browser: options.browser,
    interactive: options.interactive,
    debug: options.debug,
    sessionId: options.sessionId,
    trackDir: options.trackDir,
  });

  // Print results
  console.log(`\nPipeline: ${pipeline.name}`);
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Status: ${result.status}\n`);

  for (const workflow of result.workflows) {
    const icon = workflow.status === 'passed' ? '✓' : workflow.status === 'failed' ? '✗' : '○';
    console.log(`  ${icon} ${workflow.file} (${workflow.status})`);
    if (workflow.error) {
      console.log(`    Error: ${workflow.error}`);
    }
  }

  if (result.cleanupResult) {
    console.log(`\nCleanup: ${result.cleanupResult.deleted.length} resources deleted`);
    if (result.cleanupResult.failed.length > 0) {
      console.log(`  Failed to delete: ${result.cleanupResult.failed.join(', ')}`);
    }
  }

  process.exit(result.status === 'passed' ? 0 : 1);
};

const main = async (): Promise<void> => {
  const program = new Command();

  program
    .name('intellitester')
    .description('AI-powered cross-platform test automation')
    .version('1.0.0');

  program
    .command('init')
    .description('Initialize IntelliTester in current directory')
    .action(async () => {
      try {
        await initCommand();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(message);
        process.exitCode = 1;
      }
    });

  program
    .command('validate')
    .description('Validate test YAML files')
    .argument('[file]', 'Test file or directory to validate', 'tests')
    .action(async (file: string) => {
      try {
        await validateCommand(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(message);
        process.exitCode = 1;
      }
    });

  program
    .command('run')
    .description('Run test file(s), workflow, or auto-discover tests in tests/ directory')
    .argument('[file]', 'Test file, workflow, or pipeline to run (auto-discovers if omitted)')
    .option('--visible', 'Run browser in visible mode (not headless)')
    .option('--browser <name>', 'Browser to use (chrome, safari, firefox)', 'chrome')
    .option('--preview', 'Build project and run against preview server')
    .option('--prod', 'Alias for --preview - build and serve production build')
    .option('--fresh-build', 'Force a fresh build even if artifacts exist')
    .option('--no-server', 'Skip auto-starting web server')
    .option('-i, --interactive', 'Interactive mode - AI suggests fixes on failure')
    .option('--debug', 'Debug mode - verbose logging')
    .option('--session-id <id>', 'Override test session ID (used for tracking/cleanup)')
    .option('--track-dir <path>', 'Directory for tracking files (defaults to .intellitester/track)')
    .action(async (file: string | undefined, options: {
      visible?: boolean;
      browser?: string;
      preview?: boolean;
      prod?: boolean;
      freshBuild?: boolean;
      server?: boolean;
      interactive?: boolean;
      debug?: boolean;
      sessionId?: string;
      trackDir?: string;
    }) => {
      let previewCleanup: (() => void) | null = null;

      try {
        // Resolve browser alias
        const browser = resolveBrowserName(options.browser || 'chrome');

        // Handle preview/prod mode
        if (options.preview || options.prod) {
          const hasConfigFile = await fileExists(CONFIG_FILENAME);
          const config = hasConfigFile ? await loadIntellitesterConfig(CONFIG_FILENAME) : undefined;
          const { cleanup } = await buildAndPreview(config, process.cwd(), options.freshBuild);
          previewCleanup = cleanup;
        }

        const runOpts: RunOptions = {
          visible: options.visible,
          browser,
          interactive: options.interactive,
          debug: options.debug,
          sessionId: options.sessionId,
          trackDir: options.trackDir,
        };

        // If no file specified, auto-discover tests
        if (!file) {
          const discovered = await discoverTestFiles('tests');
          const total = discovered.pipelines.length + discovered.workflows.length + discovered.tests.length;

          if (total === 0) {
            logError('No test files found in tests/ directory. Create .pipeline.yaml, .workflow.yaml, or .test.yaml files.');
            process.exit(1);
          }

          console.log(`Discovered ${total} test file(s):`);
          if (discovered.pipelines.length > 0) {
            console.log(`  Pipelines: ${discovered.pipelines.length}`);
          }
          if (discovered.workflows.length > 0) {
            console.log(`  Workflows: ${discovered.workflows.length}`);
          }
          if (discovered.tests.length > 0) {
            console.log(`  Tests: ${discovered.tests.length}`);
          }
          console.log('');

          let failed = false;

          // Run pipelines first (they orchestrate workflows)
          for (const pipeline of discovered.pipelines) {
            try {
              await runPipelineCommand(pipeline, runOpts);
            } catch (error) {
              console.error(`\n❌ Pipeline failed: ${path.basename(pipeline)}`);
              console.error(`   ${error instanceof Error ? error.message : String(error)}\n`);
              failed = true;
            }
          }

          // Run standalone workflows (not part of pipelines)
          for (const workflow of discovered.workflows) {
            try {
              await runWorkflowCommand(workflow, runOpts);
            } catch (error) {
              console.error(`\n❌ Workflow failed: ${path.basename(workflow)}`);
              console.error(`   ${error instanceof Error ? error.message : String(error)}\n`);
              failed = true;
            }
          }

          // Run individual tests
          for (const test of discovered.tests) {
            try {
              await runTestCommand(test, {
                headed: options.visible,
                browser,
                noServer: !options.server,
                interactive: options.interactive,
                debug: options.debug,
                sessionId: options.sessionId,
                trackDir: options.trackDir,
              });
            } catch (error) {
              console.error(`\n❌ Test failed: ${path.basename(test)}`);
              console.error(`   ${error instanceof Error ? error.message : String(error)}\n`);
              failed = true;
            }
          }

          if (failed) {
            process.exitCode = 1;
          }
          return;
        }

        // Check if it's a pipeline file FIRST
        if (isPipelineFile(file)) {
          await runPipelineCommand(file, runOpts);
          return;
        }

        // Check if it's a workflow file
        if (isWorkflowFile(file)) {
          await runWorkflowCommand(file, runOpts);
          return;
        }

        // Content-based detection as fallback
        const fileContent = await fs.readFile(path.resolve(file), 'utf8');
        if (isPipelineContent(fileContent)) {
          console.log(`Note: Detected as pipeline by content structure`);
          await runPipelineCommand(file, runOpts);
          return;
        }
        if (isWorkflowContent(fileContent)) {
          console.log(`Note: Detected as workflow by content structure`);
          await runWorkflowCommand(file, runOpts);
          return;
        }

        // Otherwise, run as a single test
        await runTestCommand(file, {
          headed: options.visible,
          browser,
          noServer: !options.server,
          interactive: options.interactive,
          debug: options.debug,
          sessionId: options.sessionId,
          trackDir: options.trackDir,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(message);
        // Cleanup preview server if running
        if (previewCleanup) {
          previewCleanup();
        }
        process.exit(1);
      } finally {
        // Cleanup preview server if running (for normal exit)
        if (previewCleanup) {
          previewCleanup();
        }
      }
    });

  program
    .command('generate')
    .description('Generate test from natural language')
    .argument('<description>', 'Natural language description of the test')
    .option('--output <file>', 'Output file path')
    .option('--platform <platform>', 'Target platform', 'web')
    .option('--baseUrl <url>', 'Base URL for the app')
    .option('--pagesDir <dir>', 'Pages directory for source scanning')
    .option('--componentsDir <dir>', 'Components directory for source scanning')
    .option('--no-source', 'Disable source scanning')
    .action(async (description: string, options: {
      output?: string;
      platform?: 'web' | 'android' | 'ios';
      baseUrl?: string;
      pagesDir?: string;
      componentsDir?: string;
      source?: boolean;
    }) => {
      try {
        await generateCommand(description, {
          output: options.output,
          platform: options.platform,
          baseUrl: options.baseUrl,
          pagesDir: options.pagesDir,
          componentsDir: options.componentsDir,
          noSource: !options.source,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(message);
        process.exitCode = 1;
      }
    });

  program
    .command('cleanup:list')
    .description('List pending failed cleanup operations from previous test runs')
    .action(async () => {
      try {
        const failedCleanups = await loadFailedCleanups(process.cwd());
        if (failedCleanups.length === 0) {
          console.log('No failed cleanups found.');
          return;
        }

        console.log(`\nFound ${failedCleanups.length} failed cleanup(s):\n`);

        for (const failed of failedCleanups) {
          console.log(`Session: ${failed.sessionId}`);
          console.log(`  Timestamp: ${failed.timestamp}`);
          console.log(`  Provider: ${failed.providerConfig.provider}`);
          console.log(`  Resources: ${failed.resources.length}`);
          for (const resource of failed.resources) {
            console.log(`    - ${resource.type}:${resource.id}`);
          }
          console.log(`  Errors: ${failed.errors.length}`);
          for (const error of failed.errors.slice(0, 3)) {
            console.log(`    - ${error}`);
          }
          if (failed.errors.length > 3) {
            console.log(`    ... and ${failed.errors.length - 3} more`);
          }
          console.log('');
        }

        console.log(`Use 'intellitester cleanup:retry' to retry these cleanups.\n`);
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  program
    .command('cleanup:retry')
    .description('Retry failed cleanup operations from previous test runs')
    .action(async () => {
      try {
        // Load config to get provider credentials
        const hasConfigFile = await fileExists(CONFIG_FILENAME);
        if (!hasConfigFile) {
          throw new Error(`No ${CONFIG_FILENAME} found. Cannot retry cleanup without provider configuration.`);
        }

        const config = await loadIntellitesterConfig(CONFIG_FILENAME);

        // Load failed cleanups
        const failedCleanups = await loadFailedCleanups(process.cwd());
        if (failedCleanups.length === 0) {
          console.log('No failed cleanups to retry.');
          return;
        }

        console.log(`Found ${failedCleanups.length} failed cleanup(s) to retry.`);

        for (const failed of failedCleanups) {
          console.log(`\nRetrying cleanup for session ${failed.sessionId}...`);
          console.log(`  Provider: ${failed.providerConfig.provider}`);
          console.log(`  Resources: ${failed.resources.length}`);

          // Build cleanup config based on the provider type
          const provider = failed.providerConfig.provider;
          const cleanupConfig: CleanupConfig = {
            provider,
            parallel: false,
            retries: 3,
          };

          // Add provider-specific config with credentials from current config
          // Use type assertion since config is extensible
          const configAny = config as any;

          if (provider === 'appwrite') {
            if (!config.appwrite?.apiKey) {
              console.log(`  ✗ Skipping: Appwrite API key not configured in ${CONFIG_FILENAME}`);
              continue;
            }
            cleanupConfig.appwrite = {
              endpoint: failed.providerConfig.endpoint as string,
              projectId: failed.providerConfig.projectId as string,
              apiKey: config.appwrite.apiKey,
            };
          } else if (provider === 'postgres') {
            const pgConfig = configAny.postgres;
            if (!pgConfig?.connectionString && !pgConfig?.password) {
              console.log(`  ✗ Skipping: Postgres credentials not configured in ${CONFIG_FILENAME}`);
              continue;
            }
            // Rebuild connection string with password from config
            if (pgConfig.connectionString) {
              cleanupConfig.postgres = {
                connectionString: pgConfig.connectionString,
              };
            } else {
              const host = failed.providerConfig.host as string;
              const port = failed.providerConfig.port as number;
              const database = failed.providerConfig.database as string;
              const user = failed.providerConfig.user as string;
              const password = pgConfig.password;
              cleanupConfig.postgres = {
                connectionString: `postgresql://${user}:${password}@${host}:${port}/${database}`,
              };
            }
          } else if (provider === 'mysql') {
            const mysqlConfig = configAny.mysql;
            if (!mysqlConfig?.password) {
              console.log(`  ✗ Skipping: MySQL password not configured in ${CONFIG_FILENAME}`);
              continue;
            }
            cleanupConfig.mysql = {
              host: failed.providerConfig.host as string,
              port: failed.providerConfig.port as number,
              user: failed.providerConfig.user as string,
              password: mysqlConfig.password,
              database: failed.providerConfig.database as string,
            };
          } else if (provider === 'sqlite') {
            const sqliteConfig = configAny.sqlite;
            if (!sqliteConfig?.database && !failed.providerConfig.database) {
              console.log(`  ✗ Skipping: SQLite database path not configured`);
              continue;
            }
            cleanupConfig.sqlite = {
              database: (failed.providerConfig.database as string) || sqliteConfig?.database,
            };
          } else {
            console.log(`  ✗ Skipping: Unknown provider "${provider}"`);
            continue;
          }

          try {
            // Load cleanup handlers for this provider
            const { handlers, typeMappings } = await loadCleanupHandlers(
              cleanupConfig,
              process.cwd()
            );

            // Execute cleanup
            const result = await executeCleanup(
              failed.resources,
              handlers,
              typeMappings,
              {
                parallel: false,
                retries: 3,
                cwd: process.cwd(),
                // Don't save failed cleanups again during retry
              }
            );

            if (result.success) {
              console.log(`  ✓ Successfully cleaned up ${result.deleted.length} resources`);
              await removeFailedCleanup(failed.sessionId, process.cwd());
            } else {
              console.log(`  ⚠ Partial cleanup: ${result.deleted.length} deleted, ${result.failed.length} failed`);
              for (const failedResource of result.failed) {
                console.log(`    ✗ ${failedResource}`);
              }
            }
          } catch (error) {
            console.log(`  ✗ Error during cleanup: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        // Summary
        const remaining = await loadFailedCleanups(process.cwd());
        if (remaining.length === 0) {
          console.log('\n✓ All failed cleanups have been resolved.');
        } else {
          console.log(`\n⚠ ${remaining.length} failed cleanup(s) still remaining.`);
          console.log(`   Use 'intellitester cleanup:list' to see details.`);
        }
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
};

main();
