#!/usr/bin/env node
import dotenv from 'dotenv';

// Load .env from current working directory
dotenv.config();

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';

import { spawn, type ChildProcess } from 'node:child_process';

import { loadIntellitesterConfig, loadTestDefinition, loadWorkflowDefinition, isWorkflowFile, isPipelineFile, loadPipelineDefinition, isWorkflowContent, isPipelineContent } from '../core/loader';
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
import { validateFileEnvVars, validateConfigEnvVars } from './envValidation.js';
import { startTrackingServer, initFileTracking, type TrackingServer } from '../tracking';
import { type CLIRunOptions, mapCLIToExecutorOptions } from '../core/options.js';

const CONFIG_FILENAME = 'intellitester.config.yaml';
const GUIDE_FILENAME = 'intellitester_guide.md';

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
const detectPackageManager = async (cwd?: string): Promise<'deno' | 'pnpm' | 'npm' | 'yarn' | 'bun'> => {
  const check = (file: string) => fileExists(cwd ? path.join(cwd, file) : file);
  if (await check('deno.lock')) return 'deno';
  if (await check('pnpm-lock.yaml')) return 'pnpm';
  if (await check('bun.lockb') || await check('bun.lock')) return 'bun';
  if (await check('yarn.lock')) return 'yarn';
  return 'npm';
};

/**
 * Check if a script exists in package.json and return the first available one.
 */
const getAvailableScript = async (cwd: string, ...scriptNames: string[]): Promise<string | null> => {
  try {
    const pkgJsonPath = path.join(cwd, 'package.json');
    const pkgJson = await fs.readFile(pkgJsonPath, 'utf8');
    const pkg = JSON.parse(pkgJson);
    if (!pkg.scripts) return null;
    for (const name of scriptNames) {
      if (name in pkg.scripts) return name;
    }
    return null;
  } catch {
    return null;
  }
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
  const pm = await detectPackageManager(cwd);
  const previewConfig = config?.preview || {};

  // Get build command (default: pm run build)
  const buildCmd = previewConfig.build?.command || `${pm} run build`;
  const [buildExec, ...buildArgs] = buildCmd.split(' ');

  // Get preview command - check multiple sources in priority order
  let previewCmd: string;
  if (previewConfig.preview?.command) {
    // Explicit preview command configured
    previewCmd = previewConfig.preview.command;
  } else if (config?.webServer?.command) {
    // Use webServer.command as fallback
    previewCmd = config.webServer.command;
  } else {
    // Fall back to package.json scripts
    const availableScript = await getAvailableScript(cwd, 'preview', 'dev');
    if (!availableScript) {
      throw new Error(
        `No preview command configured and no "preview" or "dev" script found in package.json.\n` +
        `Either add a script to package.json, or configure in intellitester.yaml:\n\n` +
        `webServer:\n  command: "${pm} run dev"  # or your preview command`
      );
    }
    if (availableScript === 'dev') {
      console.log(`No "preview" script found, falling back to "dev" script`);
    }
    previewCmd = `${pm} run ${availableScript}`;
  }
  const [previewExec, ...previewArgs] = previewCmd.split(' ');

  // Get preview URL (default from webServer or baseUrl)
  const previewUrl = previewConfig.url || config?.webServer?.url || config?.platforms?.web?.baseUrl || 'http://localhost:4321';
  const timeout = previewConfig.timeout || 60000;

  // Check if build artifacts exist in cwd
  const buildDirs = ['dist', 'build', '.next', '.output', '.astro'];
  const hasArtifacts = await Promise.all(
    buildDirs.map(dir => fs.access(path.join(cwd, dir)).then(() => true).catch(() => false))
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
      const pid = previewProcess.pid;
      if (pid) {
        try {
          // Kill entire process group (negative PID) to kill shell children too
          process.kill(-pid, 'SIGTERM');
          // Force kill after 1 second if still alive
          setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }, 1000);
        } catch {
          // Fallback to regular kill
          previewProcess.kill('SIGTERM');
        }
      } else {
        previewProcess.kill('SIGTERM');
      }
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
  timeout: number = 60000,
  idleTimeout: number = 20000
): Promise<ChildProcess> => {
  return new Promise((resolve, reject) => {
    console.log(`Starting preview server: ${cmd} ${args.join(' ')}`);
    // Debug: Log tracking env vars
    if (process.env.INTELLITESTER_SESSION_ID) {
      console.log(`[Debug] Passing tracking env to preview server:`);
      console.log(`  SESSION_ID: ${process.env.INTELLITESTER_SESSION_ID}`);
      console.log(`  TRACK_URL: ${process.env.INTELLITESTER_TRACK_URL || 'not set'}`);
      console.log(`  TRACK_FILE: ${process.env.INTELLITESTER_TRACK_FILE || 'not set'}`);
    }
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'pipe',
      shell: true,
      detached: true, // Create new process group so we can kill all children
      env: { ...process.env }, // Explicitly pass all env vars
    });

    let output = '';
    let resolved = false;
    const startTime = Date.now();
    let lastOutputTime = Date.now();

    const cleanup = () => {
      resolved = true;
      clearInterval(pollInterval);
    };

    const checkServer = async () => {
      try {
        const response = await fetch(url, { method: 'HEAD' });
        if (response.ok || response.status < 500) {
          console.log(`Preview server ready at ${url}`);
          cleanup();
          resolve(child);
          return true;
        }
      } catch {
        // Server not ready yet
      }
      return false;
    };

    // Poll for server readiness, overall timeout, and idle timeout
    const pollInterval = setInterval(async () => {
      if (resolved) return;

      if (await checkServer()) {
        return;
      }

      // Check overall timeout
      if (Date.now() - startTime > timeout) {
        cleanup();
        child.kill();
        reject(new Error(`Preview server failed to start within ${timeout}ms`));
        return;
      }

      // Check idle timeout (no output for idleTimeout ms)
      if (Date.now() - lastOutputTime > idleTimeout) {
        cleanup();
        child.kill();
        reject(new Error(`Preview server stalled - no output for ${idleTimeout}ms. Last output:\n${output.slice(-500)}`));
        return;
      }
    }, 500);

    child.stdout?.on('data', (data) => {
      lastOutputTime = Date.now();
      output += data.toString();
      process.stdout.write(data);
    });

    child.stderr?.on('data', (data) => {
      lastOutputTime = Date.now();
      output += data.toString();
      process.stderr.write(data);
    });

    child.on('error', (err) => {
      if (!resolved) {
        cleanup();
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (!resolved && code !== 0 && code !== null) {
        cleanup();
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

const generateGuideContent = (): string => {
  return `# IntelliTester Guide for AI Assistants

This guide provides comprehensive documentation for AI assistants (Claude, GPT, etc.) to write IntelliTester tests effectively.

## File Types Overview

IntelliTester supports three types of test definition files:

### \`*.test.yaml\` - Single Tests

A single test file contains one test with a sequence of steps. This is the most basic building block.

\`\`\`yaml
name: Login Test
platform: web
variables:
  EMAIL: test@example.com
steps:
  - type: navigate
    value: /login
  - type: input
    target: { testId: email }
    value: \${EMAIL}
  - type: tap
    target: { text: Sign In }
  - type: assert
    target: { text: Welcome }
\`\`\`

### \`*.workflow.yaml\` - Multiple Tests with Shared Session

Workflows run multiple tests in sequence with a shared browser session. Tests share cookies, local storage, and authentication state.

\`\`\`yaml
name: User Onboarding
platform: web
config:
  web:
    baseUrl: http://localhost:3000
continueOnFailure: false
tests:
  - file: ./signup.test.yaml
    id: signup
  - file: ./verify-email.test.yaml
    id: verify
    variables:
      EMAIL: \${signup.EMAIL}
  - file: ./complete-profile.test.yaml
\`\`\`

### \`*.pipeline.yaml\` - Multiple Workflows with Dependencies

Pipelines orchestrate multiple workflows with dependencies, shared browser session, and control over execution order.

\`\`\`yaml
name: Full E2E Suite
platform: web
on_failure: skip
cleanup_on_failure: true
config:
  web:
    baseUrl: http://localhost:3000
workflows:
  - file: ./auth.workflow.yaml
    id: auth
    on_failure: fail

  - file: ./dashboard.workflow.yaml
    id: dashboard
    depends_on: [auth]
    variables:
      USER_TOKEN: \${auth.TOKEN}

  - file: ./settings.workflow.yaml
    depends_on: [auth]
    on_failure: ignore
\`\`\`

---

## Action Types Reference

### Navigation & Page Actions

#### \`navigate\`
Navigate to a URL or path.

\`\`\`yaml
- type: navigate
  value: /login
  # OR with full URL
- type: navigate
  value: https://example.com/page
\`\`\`

#### \`scroll\`
Scroll the page or a specific element.

\`\`\`yaml
# Scroll page down
- type: scroll
  direction: down
  amount: 500

# Scroll to element
- type: scroll
  target: { testId: footer }

# Scroll up
- type: scroll
  direction: up
  amount: 300
\`\`\`

#### \`screenshot\`
Take a screenshot for debugging or documentation.

\`\`\`yaml
- type: screenshot
  name: homepage.png
  waitBefore: 500  # Wait for visual stability (ms)
\`\`\`

### Element Interaction Actions

#### \`tap\`
Click or tap on an element.

\`\`\`yaml
- type: tap
  target: { testId: submit-button }
\`\`\`

#### \`input\`
Type text into an input field. Clears existing content first.

\`\`\`yaml
- type: input
  target: { testId: email }
  value: user@example.com

# With variable interpolation
- type: input
  target: { testId: email }
  value: \${EMAIL}

# With built-in generators
- type: input
  target: { testId: username }
  value: "{{randomUsername}}"
\`\`\`

#### \`type\`
Type text character-by-character WITHOUT clearing first. Use for special inputs like Stripe payment fields, autocomplete, or inputs that validate on each keystroke.

\`\`\`yaml
# Basic character-by-character typing
- type: type
  target: { testId: card-number }
  value: "4242424242424242"

# With custom delay between keystrokes (default: 50ms)
- type: type
  target: { css: "[placeholder='Card number']" }
  value: "4242424242424242"
  delay: 100
\`\`\`

**When to use \`type\` vs \`input\`:**
- Use \`input\` for normal form fields (faster, clears first)
- Use \`type\` for special inputs like Stripe, password strength meters, or autocomplete fields

#### \`clear\`
Clear the contents of an input field.

\`\`\`yaml
- type: clear
  target: { testId: search-input }
\`\`\`

#### \`hover\`
Hover over an element (useful for dropdowns, tooltips).

\`\`\`yaml
- type: hover
  target: { testId: user-menu }
\`\`\`

#### \`select\`
Select an option from a dropdown/select element.

\`\`\`yaml
- type: select
  target: { testId: country }
  value: United States

# By option value
- type: select
  target: { testId: country }
  value: US
\`\`\`

#### \`check\`
Check a checkbox.

\`\`\`yaml
- type: check
  target: { testId: terms-checkbox }
\`\`\`

#### \`uncheck\`
Uncheck a checkbox.

\`\`\`yaml
- type: uncheck
  target: { testId: newsletter-checkbox }
\`\`\`

#### \`focus\`
Focus an element.

\`\`\`yaml
- type: focus
  target: { testId: search-input }
\`\`\`

#### \`press\`
Press a keyboard key.

\`\`\`yaml
# Press Enter
- type: press
  key: Enter

# Press on specific element
- type: press
  target: { testId: search-input }
  key: Escape

# Common keys: Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace, Delete
\`\`\`

### Assertion & Evaluation Actions

#### \`assert\`
Assert that an element exists or contains expected text. Uses DOM selectors.

\`\`\`yaml
# Assert element exists
- type: assert
  target: { testId: success-message }

# Assert element contains text
- type: assert
  target: { testId: welcome-text }
  value: Welcome back

# Assert specific text is visible
- type: assert
  target: { text: "Login successful" }
\`\`\`

#### \`evaluate\`
Evaluate page state by analyzing a screenshot. Uses OCR to extract text and/or AI vision to assess visual state. Unlike \`assert\`, this does not require DOM selectors — it reads what's visually on the page.

**Modes:**
- \`auto\` (default) — Try OCR first, fall back to AI vision if OCR fails or confidence is low
- \`ocr\` — OCR only, no AI calls, no API key needed
- \`ai\` — AI vision only, requires a vision-capable AI provider

\`\`\`yaml
# Simple text check (auto mode: OCR first, AI fallback)
- type: evaluate
  expected: "Payment successful"

# Multiple expected strings (ALL must be found)
- type: evaluate
  expected:
    - "Payment successful"
    - "Order #"
    - "Thank you"

# Regex pattern matching
- type: evaluate
  expected: "Order #\\\\d{5,}"
  regex: true

# Force AI vision mode with custom prompt
- type: evaluate
  mode: ai
  prompt: "Does this page show a completed Stripe checkout with a green checkmark?"
  expected: "Payment successful"

# OCR-only (no AI fallback, no API key needed)
- type: evaluate
  mode: ocr
  expected: "Payment successful"
  confidence: 70
\`\`\`

**Properties:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| \`expected\` | string or string[] | (required) | Text to find in the screenshot |
| \`mode\` | \`ocr\` \\| \`ai\` \\| \`auto\` | \`auto\` | Evaluation strategy |
| \`regex\` | boolean | \`false\` | Treat expected strings as regex patterns |
| \`prompt\` | string | (auto-generated) | Custom prompt for AI mode |
| \`waitBefore\` | number | \`500\` | ms to wait before screenshot for visual stability |
| \`fullPage\` | boolean | \`true\` | Capture full page or just viewport |
| \`confidence\` | number (0-100) | \`60\` | Min OCR confidence; below this, falls back to AI in auto mode |

**When to use \`evaluate\` vs \`assert\`:**
- Use \`assert\` when you can target a specific DOM element
- Use \`evaluate\` when DOM selectors are unreliable (iframes, dynamic content, animations, third-party widgets like Stripe)

### Wait Actions

#### \`wait\`
Wait for an element to appear or for a timeout.

\`\`\`yaml
# Wait for element
- type: wait
  target: { testId: loading-spinner }

# Wait with timeout
- type: wait
  target: { text: "Data loaded" }
  timeout: 10000

# Wait fixed time (use sparingly)
- type: wait
  timeout: 2000
\`\`\`

#### \`waitForSelector\`
Wait for an element to reach a specific state.

\`\`\`yaml
# Wait for element to be visible
- type: waitForSelector
  target: { testId: modal }
  state: visible
  timeout: 5000

# Wait for element to be hidden
- type: waitForSelector
  target: { testId: loading }
  state: hidden

# States: visible, hidden, attached, detached, enabled, disabled
\`\`\`

### Variable Actions

#### \`setVar\`
Set a variable for use in later steps.

\`\`\`yaml
# Set static value
- type: setVar
  name: USER_ID
  value: "12345"

# Set with built-in generator
- type: setVar
  name: EMAIL
  value: "{{randomEmail}}"

# Set with interpolation
- type: setVar
  name: FULL_NAME
  value: "\${FIRST_NAME} \${LAST_NAME}"
\`\`\`

### Conditional Actions

#### \`conditional\`
Execute steps conditionally based on element state.

\`\`\`yaml
- type: conditional
  condition:
    type: visible  # exists, notExists, visible, hidden
    target: { testId: cookie-banner }
  then:
    - type: tap
      target: { testId: accept-cookies }
  else:
    - type: navigate
      value: /next-page
\`\`\`

#### \`waitForBranch\`
Wait for an element and branch based on whether it appears or times out.

\`\`\`yaml
- type: waitForBranch
  target: { testId: success-message }
  timeout: 10000
  state: visible
  pollInterval: 100
  onAppear:
    - type: tap
      target: { testId: continue }
  onTimeout:
    - type: tap
      target: { testId: retry }
\`\`\`

### Email Testing Actions

#### \`email.waitFor\`
Wait for an email to arrive.

\`\`\`yaml
- type: email.waitFor
  mailbox: test@test.local
  timeout: 30000
  subjectContains: "Verification"
\`\`\`

#### \`email.extractCode\`
Extract a verification code from the last email.

\`\`\`yaml
- type: email.extractCode
  saveTo: VERIFICATION_CODE
  pattern: "\\\\d{6}"  # Optional regex pattern
\`\`\`

#### \`email.extractLink\`
Extract a link from the last email.

\`\`\`yaml
- type: email.extractLink
  saveTo: VERIFY_LINK
  pattern: "verify.*token="  # Optional pattern to match
\`\`\`

#### \`email.clear\`
Clear all emails from a mailbox.

\`\`\`yaml
- type: email.clear
  mailbox: test@test.local
\`\`\`

### Appwrite Integration

#### \`appwrite.verifyEmail\`
Directly verify a user's email via Appwrite API (bypasses email verification flow).

\`\`\`yaml
- type: appwrite.verifyEmail
\`\`\`

### Debugging Actions

#### \`debug\`
Pause execution and open Playwright Inspector.

\`\`\`yaml
- type: debug
\`\`\`

#### \`fail\`
Explicitly fail the test with a custom message.

\`\`\`yaml
- type: fail
  message: "This feature is not implemented yet"
\`\`\`

#### \`log\`
Log messages, JavaScript expression results, or element content for debugging.

\`\`\`yaml
# Log a static message (supports variable interpolation)
- type: log
  message: "Starting checkout with user \${EMAIL}"

# Evaluate JavaScript in page context
- type: log
  eval: "document.title"

# Log element text content
- type: log
  target: { css: ".error-message" }

# Log element HTML content
- type: log
  target: { testId: user-profile }
  format: html  # text (default), html, or json

# Log inside iframe
- type: log
  target: { css: ".stripe-error" }
  frame:
    css: "iframe[name='stripe']"
  format: text
\`\`\`

**Format options:**
- \`text\` (default) - Element's \`textContent\`
- \`html\` - Element's \`innerHTML\`
- \`json\` - Attempt to parse text as JSON and pretty-print

---

## Target Selectors

Targets define how to locate elements. Use these properties in any \`target\` field:

### \`testId\` (Recommended)
Uses the \`data-testid\` attribute. Most reliable and maintainable.

\`\`\`yaml
target:
  testId: submit-button
\`\`\`

### \`text\`
Find element by visible text content.

\`\`\`yaml
target:
  text: "Sign In"
\`\`\`

### \`role\`
Find by ARIA role with optional accessible name.

\`\`\`yaml
target:
  role: button
  name: Submit

# Common roles: button, link, textbox, checkbox, radio, combobox, heading, alert
\`\`\`

### \`css\`
CSS selector (use sparingly - can be fragile).

\`\`\`yaml
target:
  css: ".btn-primary"

# More specific CSS
target:
  css: "form#login button[type=submit]"
\`\`\`

### \`xpath\`
XPath selector (use sparingly - can be fragile).

\`\`\`yaml
target:
  xpath: "//button[@type='submit']"
\`\`\`

### \`description\`
AI-friendly description for self-healing tests.

\`\`\`yaml
target:
  description: "The blue submit button at the bottom of the login form"
\`\`\`

### Combining Selectors

You can combine selectors for more precise targeting:

\`\`\`yaml
target:
  role: button
  name: Submit

target:
  testId: modal
  text: Confirm
\`\`\`

---

## Iframe Targeting with \`frame\`

Many actions support a \`frame\` property to target elements inside iframes. This is essential for payment forms (Stripe, PayPal), embedded widgets, and third-party integrations.

### Frame Locator Properties

| Property | Description |
|----------|-------------|
| \`css\` | CSS selector for the iframe element |
| \`name\` | Name or id attribute of the iframe |
| \`index\` | Zero-based index when multiple iframes match (default: 0) |

### Basic Usage

\`\`\`yaml
# Target element inside an iframe by CSS selector
- type: type
  target: { css: "[placeholder='Card number']" }
  frame:
    css: "iframe.payment-frame"
  value: "4242424242424242"

# Target iframe by name attribute
- type: input
  target: { testId: email-field }
  frame:
    name: checkout-iframe
  value: "test@example.com"

# When multiple iframes match, use index
- type: type
  target: { css: "input" }
  frame:
    css: "div.__PrivateStripeElement iframe"
    index: 0
  value: "4242424242424242"
\`\`\`

### Supported Actions with \`frame\`

These actions support the \`frame\` property:
- \`tap\` - Click inside iframe
- \`input\` - Fill text inside iframe
- \`type\` - Type character-by-character inside iframe
- \`clear\` - Clear input inside iframe
- \`hover\` - Hover element inside iframe
- \`press\` - Press key inside iframe
- \`focus\` - Focus element inside iframe
- \`assert\` - Assert element inside iframe
- \`wait\` - Wait for element inside iframe
- \`waitForSelector\` - Wait for element state inside iframe

### Stripe Checkout Example

\`\`\`yaml
name: Stripe Checkout
platform: web
variables:
  CARD_NUMBER: "4242424242424242"
  CARD_EXPIRY: "12/34"
  CARD_CVC: "123"
steps:
  - type: navigate
    value: /checkout

  # Wait for Stripe iframe to load
  - type: wait
    target:
      css: "div.__PrivateStripeElement iframe"
    timeout: 10000

  # Type card number (character-by-character for Stripe validation)
  - type: type
    target:
      css: "[placeholder='Card number']"
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: "\${CARD_NUMBER}"
    delay: 50

  # Type expiry
  - type: type
    target:
      css: "[placeholder='MM / YY']"
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: "\${CARD_EXPIRY}"

  # Type CVC
  - type: type
    target:
      css: "[placeholder='CVC']"
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: "\${CARD_CVC}"

  # Submit (on main page, not in iframe)
  - type: tap
    target: { testId: pay-button }

  - type: assert
    target: { text: "Payment successful" }
\`\`\`

### Common Iframe Selectors

| Service | Typical Selector |
|---------|------------------|
| Stripe Elements | \`div.__PrivateStripeElement iframe\` |
| Stripe Checkout | \`iframe[name*='stripe']\` |
| PayPal | \`iframe[name*='paypal']\` |
| reCAPTCHA | \`iframe[title*='reCAPTCHA']\` |
| YouTube | \`iframe[src*='youtube.com']\` |

---

## Variables & Interpolation

### Defining Variables

Variables can be defined at the test or workflow level:

\`\`\`yaml
name: My Test
platform: web
variables:
  EMAIL: test@example.com
  PASSWORD: secret123
steps:
  - type: input
    target: { testId: email }
    value: \${EMAIL}
\`\`\`

### Using Variables

Reference variables with \`\${VARIABLE_NAME}\` syntax:

\`\`\`yaml
- type: input
  target: { testId: email }
  value: \${EMAIL}

- type: navigate
  value: /users/\${USER_ID}/profile
\`\`\`

### Built-in Generators

Use \`{{generator}}\` syntax for dynamic values:

| Generator | Description | Example Output |
|-----------|-------------|----------------|
| \`{{uuid}}\` | Short UUID (first segment) | \`a1b2c3d4\` |
| \`{{randomUsername}}\` | Random username | \`HappyTiger42\` |
| \`{{randomEmail}}\` | Random test email | \`test-abc123@test.local\` |
| \`{{randomEmail:domain}}\` | Email with custom domain | \`test-xyz@example.com\` |
| \`{{randomPhone}}\` | Random US phone (E.164) | \`+12025551234\` |
| \`{{randomPhone:GB}}\` | Phone for country code | \`+447911123456\` |
| \`{{randomPhoto}}\` | Random photo URL (500x500) | \`https://picsum.photos/500/500?random=123\` |
| \`{{randomPhoto:200x300}}\` | Custom dimensions | \`https://picsum.photos/200/300?random=456\` |
| \`{{fillerText}}\` | Lorem ipsum (~50 words) | \`Lorem ipsum dolor sit amet...\` |
| \`{{fillerText:100}}\` | Filler with N words | \`Lorem ipsum... (100 words)\` |

\`\`\`yaml
variables:
  EMAIL: "{{randomEmail}}"
  USERNAME: "{{randomUsername}}"
steps:
  - type: input
    target: { testId: email }
    value: \${EMAIL}
\`\`\`

---

## Best Practices for AI Test Generation

### 1. Prefer \`testId\` Over CSS/XPath

\`\`\`yaml
# Good - stable, semantic
target:
  testId: login-button

# Avoid - fragile, breaks easily
target:
  css: "div.container > form > button:nth-child(3)"
\`\`\`

### 2. Use Descriptive Step Names (via comments)

\`\`\`yaml
steps:
  # Navigate to login page
  - type: navigate
    value: /login

  # Enter user credentials
  - type: input
    target: { testId: email }
    value: \${EMAIL}
\`\`\`

### 3. Group Related Actions

Keep related actions together for readability:

\`\`\`yaml
steps:
  # Login form
  - type: input
    target: { testId: email }
    value: \${EMAIL}
  - type: input
    target: { testId: password }
    value: \${PASSWORD}
  - type: tap
    target: { testId: submit }

  # Verify successful login
  - type: wait
    target: { testId: dashboard }
  - type: assert
    target: { text: Welcome }
\`\`\`

### 4. Handle Loading States with Wait

Always wait for elements before interacting:

\`\`\`yaml
# Wait for page to load
- type: wait
  target: { testId: main-content }

# Then interact
- type: tap
  target: { testId: action-button }
\`\`\`

### 5. Use Conditional for Dynamic UI

\`\`\`yaml
# Handle optional dialogs
- type: conditional
  condition:
    type: visible
    target: { testId: cookie-consent }
  then:
    - type: tap
      target: { testId: accept-cookies }
\`\`\`

### 6. Use Variables for Reusability

\`\`\`yaml
variables:
  BASE_EMAIL: "{{randomEmail}}"
  PASSWORD: "TestPassword123!"
steps:
  - type: input
    target: { testId: email }
    value: \${BASE_EMAIL}
  - type: input
    target: { testId: password }
    value: \${PASSWORD}
\`\`\`

### 7. Prefer Role Selectors for Accessibility

\`\`\`yaml
# Good - works with screen readers
target:
  role: button
  name: Submit

# Also good
target:
  role: textbox
  name: Email address
\`\`\`

### 8. Use Workflows for Multi-Step Flows

Instead of one giant test, split into logical workflow:

\`\`\`yaml
# user-flow.workflow.yaml
tests:
  - file: ./register.test.yaml
    id: register
  - file: ./login.test.yaml
    id: login
    variables:
      EMAIL: \${register.EMAIL}
  - file: ./dashboard.test.yaml
\`\`\`

### 9. Clean Up Test Data

Use resource tracking for cleanup:

\`\`\`yaml
config:
  appwrite:
    cleanup: true
    cleanupOnFailure: true
\`\`\`

### 10. Add Strategic Screenshots

\`\`\`yaml
# Before critical actions
- type: screenshot
  name: before-submit.png

- type: tap
  target: { testId: submit }

# After critical actions
- type: screenshot
  name: after-submit.png
\`\`\`

---

## Configuration Reference

### Test Config

\`\`\`yaml
config:
  defaults:
    timeout: 30000
    screenshots: on-failure  # on-failure, always, never

  web:
    baseUrl: http://localhost:3000
    browser: chromium  # chromium, firefox, webkit
    headless: true

  email:
    provider: inbucket
    endpoint: http://localhost:9000

  appwrite:
    endpoint: https://cloud.appwrite.io/v1
    projectId: \${APPWRITE_PROJECT_ID}
    apiKey: \${APPWRITE_API_KEY}
    cleanup: true
    cleanupOnFailure: true
\`\`\`

### Workflow/Pipeline Config

\`\`\`yaml
config:
  web:
    baseUrl: http://localhost:3000

  webServer:
    command: npm run dev
    url: http://localhost:3000
    reuseExistingServer: true
    timeout: 30000

  cleanup:
    provider: appwrite
    parallel: false
    retries: 3
\`\`\`

---

## Viewport Sizes (Responsive Testing)

IntelliTester can run tests across multiple viewport sizes to ensure your application works on different devices.

### Named Sizes (Tailwind Breakpoints)

| Size | Width | Height | Device Type |
|------|-------|--------|-------------|
| \`xs\` | 320 | 568 | Mobile portrait |
| \`sm\` | 640 | 800 | Small tablet |
| \`md\` | 768 | 1024 | Tablet |
| \`lg\` | 1024 | 768 | Desktop |
| \`xl\` | 1280 | 720 | Large desktop |

### Custom Sizes

Use \`WIDTHxHEIGHT\` format for custom dimensions:

\`\`\`bash
intellitester run tests/ --test-sizes 1920x1080,375x812,414x896
\`\`\`

### Configuration

**CLI Flag:**

\`\`\`bash
intellitester run tests/ --test-sizes xs,sm,md,lg,xl
intellitester run app.workflow.yaml --test-sizes xs,md,xl
\`\`\`

**Workflow Config:**

\`\`\`yaml
name: Responsive Tests
platform: web
config:
  web:
    baseUrl: http://localhost:3000
    testSizes: ['xs', 'sm', 'md', 'lg', 'xl']
tests:
  - file: ./homepage.test.yaml
  - file: ./navigation.test.yaml
\`\`\`

**Pipeline Config:**

\`\`\`yaml
name: Full Responsive Suite
platform: web
config:
  web:
    testSizes: ['xs', 'md', 'xl']
workflows:
  - file: ./auth.workflow.yaml
  - file: ./dashboard.workflow.yaml
\`\`\`

### Behavior

- Tests run once per viewport size
- Results are prefixed with size: \`[xs] homepage.test.yaml\`, \`[md] homepage.test.yaml\`
- Browser session (cookies, auth state) is shared across sizes
- Browser context is recreated for each size with new viewport dimensions

---

## Configuration Inheritance

Configuration in IntelliTester follows a cascading override pattern. Lower-level configuration takes precedence over higher levels.

### Priority Order (Highest to Lowest)

1. **Test Config** (\`.test.yaml\`) - Highest priority
2. **Workflow Config** (\`.workflow.yaml\`)
3. **Pipeline Config** (\`.pipeline.yaml\`)
4. **Global Config** (\`intellitester.yaml\`)
5. **Defaults** - Lowest priority

### What Can Be Configured

| Setting | Test | Workflow | Pipeline | Global |
|---------|------|----------|----------|--------|
| \`baseUrl\` | Yes | Yes | Yes | Yes |
| \`browser\` | Yes | Yes | Yes | Yes |
| \`headless\` | Yes | Yes | Yes | Yes |
| \`timeout\` | Yes | Yes | Yes | Yes |
| \`testSizes\` | - | Yes | Yes | - |
| \`webServer\` | - | Yes | Yes | Yes |
| \`appwrite\` | Yes | Yes | Yes | Yes |
| \`cleanup\` | Yes | Yes | Yes | Yes |
| \`email\` | Yes | Yes | Yes | Yes |

### Override Examples

**Global config (\`intellitester.yaml\`):**

\`\`\`yaml
defaults:
  timeout: 30000
platforms:
  web:
    baseUrl: http://localhost:3000
    headless: true
\`\`\`

**Pipeline overrides global:**

\`\`\`yaml
# pipeline.yaml - uses baseUrl from global, overrides headless
config:
  web:
    headless: false  # Override: run headed for this pipeline
    testSizes: ['xs', 'md', 'xl']
\`\`\`

**Workflow overrides pipeline:**

\`\`\`yaml
# workflow.yaml - overrides baseUrl for this workflow only
config:
  web:
    baseUrl: http://localhost:4000  # Different port for this workflow
\`\`\`

**Test overrides workflow:**

\`\`\`yaml
# test.yaml - specific test needs different timeout
config:
  defaults:
    timeout: 60000  # Longer timeout for slow test
\`\`\`

### Important Notes

- Configuration uses **simple override**, not deep merge
- If you specify a config section at a lower level, it completely replaces that section from higher levels
- CLI flags (like \`--headed\`, \`--test-sizes\`) override all YAML configuration
- Environment variables in config (\`\${VAR_NAME}\`) are resolved at load time

---

## Common Patterns

### Login Flow

\`\`\`yaml
name: Login Test
platform: web
variables:
  EMAIL: user@example.com
  PASSWORD: password123
steps:
  - type: navigate
    value: /login
  - type: input
    target: { testId: email }
    value: \${EMAIL}
  - type: input
    target: { testId: password }
    value: \${PASSWORD}
  - type: tap
    target: { testId: submit }
  - type: wait
    target: { testId: dashboard }
  - type: assert
    target: { text: Welcome }
\`\`\`

### Form Submission

\`\`\`yaml
name: Contact Form
platform: web
variables:
  NAME: "{{randomUsername}}"
  EMAIL: "{{randomEmail}}"
  MESSAGE: "{{fillerText:50}}"
steps:
  - type: navigate
    value: /contact
  - type: input
    target: { testId: name }
    value: \${NAME}
  - type: input
    target: { testId: email }
    value: \${EMAIL}
  - type: input
    target: { testId: message }
    value: \${MESSAGE}
  - type: tap
    target: { testId: submit }
  - type: assert
    target: { text: "Thank you" }
\`\`\`

### Email Verification Flow

\`\`\`yaml
name: Email Verification
platform: web
config:
  email:
    provider: inbucket
    endpoint: http://localhost:9000
variables:
  EMAIL: "{{randomEmail:test.local}}"
steps:
  - type: navigate
    value: /signup
  - type: input
    target: { testId: email }
    value: \${EMAIL}
  - type: tap
    target: { testId: submit }

  # Wait for verification email
  - type: email.waitFor
    mailbox: \${EMAIL}
    timeout: 30000
    subjectContains: Verify

  # Extract verification link
  - type: email.extractLink
    saveTo: VERIFY_LINK
    pattern: verify

  # Click verification link
  - type: navigate
    value: \${VERIFY_LINK}

  - type: assert
    target: { text: "Email verified" }
\`\`\`

### Modal Interaction

\`\`\`yaml
steps:
  - type: tap
    target: { testId: open-modal }
  - type: wait
    target: { testId: modal }
  - type: input
    target: { testId: modal-input }
    value: test value
  - type: tap
    target: { testId: modal-confirm }
  - type: waitForSelector
    target: { testId: modal }
    state: hidden
\`\`\`

### Search and Filter

\`\`\`yaml
steps:
  - type: navigate
    value: /products
  - type: input
    target: { testId: search }
    value: laptop
  - type: press
    key: Enter
  - type: wait
    target: { testId: results }
  - type: assert
    target: { testId: result-count }
    value: "results"
  - type: tap
    target: { testId: filter-price }
  - type: select
    target: { testId: price-range }
    value: "100-500"
\`\`\`

### Payment with Stripe

\`\`\`yaml
name: Stripe Payment
platform: web
variables:
  # Stripe test card numbers:
  # 4242424242424242 - Succeeds
  # 4000000000000002 - Declined
  CARD_NUMBER: "4242424242424242"
  CARD_EXPIRY: "12/34"
  CARD_CVC: "123"
steps:
  - type: navigate
    value: /checkout

  # Wait for Stripe to initialize
  - type: wait
    target: { css: "div.__PrivateStripeElement iframe" }
    timeout: 10000

  # Fill card details (use 'type' not 'input' for Stripe)
  - type: type
    target: { css: "[placeholder='Card number']" }
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: \${CARD_NUMBER}
    delay: 50

  - type: type
    target: { css: "[placeholder='MM / YY']" }
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: \${CARD_EXPIRY}

  - type: type
    target: { css: "[placeholder='CVC']" }
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: \${CARD_CVC}

  # Submit payment
  - type: tap
    target: { testId: submit-payment }

  # Verify success using screenshot evaluation (no DOM selectors needed)
  - type: evaluate
    expected: "Payment successful"
    waitBefore: 2000
\`\`\`

---

## AI-Assisted Test Healing

IntelliTester can automatically fix broken selectors using AI when tests fail. This is useful when UI changes cause selectors to break.

### Configuration

Enable AI healing in \`intellitester.config.yaml\`:

\`\`\`yaml
ai:
  # Choose your provider: anthropic, openai, ollama, groq, openrouter
  provider: groq
  model: llama-3.3-70b-versatile
  apiKey: \${GROQ_API_KEY}  # Or use env vars directly
  temperature: 0.2
  maxTokens: 4096

healing:
  enabled: true
  maxAttempts: 3  # 1-10, how many AI attempts per failure
\`\`\`

### Supported Providers

| Provider | Env Variable | Example Model |
|----------|--------------|---------------|
| \`anthropic\` | \`ANTHROPIC_API_KEY\` | \`claude-3-5-sonnet-20241022\` |
| \`openai\` | \`OPENAI_API_KEY\` | \`gpt-4o\` |
| \`groq\` | \`GROQ_API_KEY\` | \`llama-3.3-70b-versatile\` |
| \`openrouter\` | \`OPENROUTER_API_KEY\` | \`anthropic/claude-3.5-sonnet\` |
| \`ollama\` | - | \`llama3.2\` |

### How It Works

1. When an action fails (e.g., element not found)
2. AI analyzes the page HTML and error message
3. AI suggests a new selector (testId, text, role, or css)
4. IntelliTester validates the suggestion actually finds an element
5. If valid, retries the action with the new selector

### Example Output

\`\`\`
[FAIL] tap - Element not found: testId="old-button-id"

🔧 Attempting AI-assisted healing (max 3 attempts)...
✅ AI found fix: {"text": "Submit Order"}

[OK] tap
\`\`\`

### Selector Priority

AI prefers selectors in this order:
1. \`testId\` - Most stable
2. \`text\` - Good for buttons, links
3. \`role\` + \`name\` - Good for accessible elements
4. \`css\` - Last resort, more fragile

---

Generated by IntelliTester v1.0.0
`;
};

const guideCommand = async (): Promise<void> => {
  const guidePath = path.resolve(GUIDE_FILENAME);
  const content = generateGuideContent();
  await fs.writeFile(guidePath, content, 'utf8');
  console.log(`Created ${GUIDE_FILENAME} in current directory`);
  console.log('This guide helps AI assistants write effective IntelliTester tests.');
};

const initCommand = async (): Promise<void> => {
  const configTemplate = `defaults:
  timeout: 30000
  screenshots: on-failure

platforms:
  web:
    baseUrl: http://localhost:3000
    headless: true

# AI configuration - supports: anthropic, openai, ollama, groq, openrouter
ai:
  provider: anthropic
  model: claude-3-5-sonnet-20241022
  apiKey: \${ANTHROPIC_API_KEY}
  temperature: 0
  maxTokens: 4096

# AI-assisted test healing - automatically fix broken selectors
healing:
  enabled: false  # Set to true to enable
  maxAttempts: 3

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
    testSizes?: string[];
  },
): Promise<void> => {
  const absoluteTarget = path.resolve(target);

  // Load .env from the project directory
  await loadProjectEnv(absoluteTarget);

  // Validate environment variables before proceeding
  const { parse } = await import('yaml');
  const testContent = await fs.readFile(absoluteTarget, 'utf8');
  const parsedTest = parse(testContent);

  const canContinue = await validateFileEnvVars({
    filePath: absoluteTarget,
    parsedContent: parsedTest,
  });
  if (!canContinue) {
    process.exit(1);
  }

  // Now load and validate with schemas
  const hasConfigFile = await fileExists(CONFIG_FILENAME);
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

  // Pass aiConfig if interactive mode OR healing is enabled (check both global and test-level config)
  const healingEnabled = config?.healing?.enabled === true || test.config?.healing?.enabled === true;
  const needsAi = interactive || healingEnabled;

  // Resolve AI config: global takes priority, test-level as fallback
  const resolvedAiConfig = config?.ai ?? test.config?.ai;

  const result = await runWebTest(test, {
    baseUrl,
    headed,
    browser,
    defaultTimeoutMs: config?.defaults?.timeout ?? test.config?.defaults?.timeout,
    webServer: !skipWebServer && config?.webServer ? config.webServer : undefined,
    debug,
    interactive,
    aiConfig: needsAi ? resolvedAiConfig : undefined,
    sessionId: options.sessionId,
    trackDir: options.trackDir,
    testSizes: options.testSizes as ('xs' | 'sm' | 'md' | 'lg' | 'xl')[] | undefined,
    healing: healingEnabled ? {
      enabled: true,
      maxAttempts: config?.healing?.maxAttempts ?? test.config?.healing?.maxAttempts ?? 3,
    } : undefined,
    onStepComplete: (step) => {
      const label = `[${step.status === 'passed' ? 'OK' : 'FAIL'}] ${step.action.type}`;
      if (step.error) {
        console.error(`${label} - ${step.error}`);
      } else if (step.logOutput) {
        console.log(label);
        console.log(`  ${step.logOutput}`);
      } else {
        console.log(label);
      }
    },
  });

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
  const canContinue = await validateConfigEnvVars();
  if (!canContinue) {
    process.exit(1);
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

const runWorkflowCommand = async (file: string, options: CLIRunOptions): Promise<void> => {
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

  const canContinue = await validateFileEnvVars({
    filePath: workflowPath,
    parsedContent: parsedWorkflow,
  });
  if (!canContinue) {
    process.exit(1);
  }

  // Now load and validate with schemas
  const workflow = await loadWorkflowDefinition(workflowPath);

  // Load config to get AI settings (for interactive mode)
  const hasConfigFile = await fileExists(CONFIG_FILENAME);
  const config = hasConfigFile ? await loadIntellitesterConfig(CONFIG_FILENAME) : undefined;

  const result = await runWorkflow(workflow, workflowPath, {
    ...mapCLIToExecutorOptions(options),
    aiConfig: config?.ai,
    webServer: config?.webServer,
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

const runPipelineCommand = async (file: string, options: CLIRunOptions): Promise<void> => {
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

  const canContinue = await validateFileEnvVars({
    filePath: pipelinePath,
    parsedContent: parsedPipeline,
  });
  if (!canContinue) {
    process.exit(1);
  }

  // Now load and validate with schemas
  const pipeline = await loadPipelineDefinition(pipelinePath);

  const result = await runPipeline(pipeline, pipelinePath, mapCLIToExecutorOptions(options));

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
    .command('guide')
    .alias('init-guide')
    .description('Generate intellitester_guide.md for AI assistants')
    .action(async () => {
      try {
        await guideCommand();
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
    .option('--test-sizes <sizes>', 'Viewport sizes to test (xs,sm,md,lg,xl comma-separated)')
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
      testSizes?: string;
    }) => {
      let previewCleanup: (() => void) | null = null;
      let trackingServer: TrackingServer | null = null;
      let fileTrackingCleanup: (() => Promise<void>) | null = null;
      let cliOwnsTracking = false;

      try {
        // Resolve browser alias
        const browser = resolveBrowserName(options.browser || 'chrome');

        // Handle preview/prod mode
        const sessionId = options.sessionId ?? crypto.randomUUID();

        if (options.preview || options.prod) {
          const hasConfigFile = await fileExists(CONFIG_FILENAME);
          const config = hasConfigFile ? await loadIntellitesterConfig(CONFIG_FILENAME) : undefined;
          // Use webServer.workdir (or deprecated cwd) from config if specified, otherwise use current directory
          const webServerWorkdir = config?.webServer?.workdir ?? config?.webServer?.cwd;
          const previewCwd = webServerWorkdir
            ? path.resolve(process.cwd(), webServerWorkdir)
            : process.cwd();
          // Load .env from test app directory (overrides repo root .env vars)
          // Repo root .env is loaded at CLI startup, test app .env takes precedence
          if (previewCwd !== process.cwd()) {
            const appEnvPath = path.join(previewCwd, '.env');
            if (await fileExists(appEnvPath)) {
              dotenv.config({ path: appEnvPath, override: true });
              console.log(`Loaded .env from ${previewCwd}`);
            }
          }

          // Set up tracking env vars BEFORE starting preview server so it inherits them
          const requiresTracking = Boolean(config?.appwrite?.cleanup || config?.appwrite?.cleanupOnFailure);
          if (requiresTracking) {
            // Always set session ID for tracking (sessionId already prefers options.sessionId if provided)
            process.env.INTELLITESTER_SESSION_ID = sessionId;

            // Start tracking server (optional - file tracking is backup)
            try {
              trackingServer = await startTrackingServer({ port: 0 });
              process.env.INTELLITESTER_TRACK_URL = `http://localhost:${trackingServer.port}`;
              console.log(`Tracking server started on port ${trackingServer.port}`);
            } catch (error) {
              console.warn('Failed to start tracking server:', error);
            }

            // File tracking is always initialized as backup/primary
            // Always use process.cwd() (project root where config is), not previewCwd
            const fileTracking = await initFileTracking({
              sessionId,
              cwd: process.cwd(),
              trackDir: options.trackDir,
              providerConfig: config?.appwrite ? {
                provider: 'appwrite',
                endpoint: config.appwrite.endpoint,
                projectId: config.appwrite.projectId,
                apiKey: config.appwrite.apiKey,
              } : undefined,
            });
            process.env.INTELLITESTER_TRACK_FILE = fileTracking.trackFile;
            fileTrackingCleanup = fileTracking.stop;
            
            // Mark CLI as owner of tracking resources
            process.env.INTELLITESTER_TRACKING_OWNER = 'cli';
            cliOwnsTracking = true;

            // Write tracking env vars to .env file so tools like wrangler can access them
            // (wrangler reads from .env file, not process.env)
            const envPath = path.join(previewCwd, '.env');
            const trackingEnvLines = [
              '',
              '# Intellitester tracking (auto-generated, will be cleaned up)',
              `INTELLITESTER_SESSION_ID=${sessionId}`,
              process.env.INTELLITESTER_TRACK_URL ? `INTELLITESTER_TRACK_URL=${process.env.INTELLITESTER_TRACK_URL}` : '',
              `INTELLITESTER_TRACK_FILE=${process.env.INTELLITESTER_TRACK_FILE}`,
            ].filter(Boolean).join('\n') + '\n';

            try {
              await fs.appendFile(envPath, trackingEnvLines);
              console.log('Added tracking env vars to .env file');
            } catch (error) {
              console.warn('Failed to write tracking env vars to .env file:', error);
            }
          }

          const { cleanup } = await buildAndPreview(config, previewCwd, options.freshBuild);
          previewCleanup = cleanup;
        }

        // Parse testSizes from comma-separated string
        const validSizes = ['xs', 'sm', 'md', 'lg', 'xl'];
        const testSizes = options.testSizes
          ? options.testSizes.split(',').map(s => s.trim()).filter(s => validSizes.includes(s))
          : undefined;

        const runOpts: CLIRunOptions = {
          visible: options.visible,
          browser,
          interactive: options.interactive,
          debug: options.debug,
          sessionId,  // Use the sessionId we generated/set for tracking
          trackDir: options.trackDir,
          testSizes,
          // When CLI sets up tracking, tell executors to skip their own setup
          skipTrackingSetup: cliOwnsTracking,
          skipWebServerStart: cliOwnsTracking,
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
                testSizes,
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

        // Check if file argument is actually a directory
        const resolvedFile = path.resolve(file);
        const fileStat = await fs.stat(resolvedFile);
        if (fileStat.isDirectory()) {
          // Discover and run tests in the specified directory
          const discovered = await discoverTestFiles(resolvedFile);
          const total = discovered.pipelines.length + discovered.workflows.length + discovered.tests.length;

          if (total === 0) {
            logError(`No test files found in ${file}. Create .pipeline.yaml, .workflow.yaml, or .test.yaml files.`);
            process.exit(1);
          }

          console.log(`Discovered ${total} test file(s) in ${file}:`);
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

          for (const pipeline of discovered.pipelines) {
            try {
              await runPipelineCommand(pipeline, runOpts);
            } catch (error) {
              console.error(`\n❌ Pipeline failed: ${path.basename(pipeline)}`);
              console.error(`   ${error instanceof Error ? error.message : String(error)}\n`);
              failed = true;
            }
          }

          for (const workflow of discovered.workflows) {
            try {
              await runWorkflowCommand(workflow, runOpts);
            } catch (error) {
              console.error(`\n❌ Workflow failed: ${path.basename(workflow)}`);
              console.error(`   ${error instanceof Error ? error.message : String(error)}\n`);
              failed = true;
            }
          }

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
                testSizes,
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
          testSizes,
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
        
        // Cleanup tracking resources if CLI owns them
        if (process.env.INTELLITESTER_TRACKING_OWNER === 'cli') {
          if (trackingServer) await trackingServer.stop();
          if (fileTrackingCleanup) await fileTrackingCleanup();
          delete process.env.INTELLITESTER_TRACKING_OWNER;
          delete process.env.INTELLITESTER_SESSION_ID;
          delete process.env.INTELLITESTER_TRACK_URL;
          delete process.env.INTELLITESTER_TRACK_FILE;
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
