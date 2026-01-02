import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
  type Locator as PWLocator,
  type Page,
} from 'playwright';
import prompts from 'prompts';

import type { Action, Locator, TestDefinition } from '../../core/types';
import { InbucketClient } from '../../integrations/email/inbucketClient';
import type { Email } from '../../integrations/email/types';
import { AppwriteTestClient, createTestContext, APPWRITE_PATTERNS, APPWRITE_UPDATE_PATTERNS, APPWRITE_DELETE_PATTERNS, type TrackedResource } from '../../integrations/appwrite';
import { getAISuggestion } from '../../ai/errorHelper';
import { TrackingServer } from '../../tracking/trackingServer';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface WebServerConfig {
  // Option 1: Explicit command
  command?: string;

  // Option 2: Auto-detect from package.json and build output
  auto?: boolean;

  // Option 3: Serve static directory
  static?: string;

  url: string;
  port?: number;
  reuseExistingServer?: boolean;
  timeout?: number;
  cwd?: string;
}

export interface WebRunOptions {
  baseUrl?: string;
  browser?: BrowserName;
  headed?: boolean;
  screenshotDir?: string;
  defaultTimeoutMs?: number;
  webServer?: WebServerConfig;
  debug?: boolean;
  interactive?: boolean;
  aiConfig?: import('../../ai/types').AIConfig;
}

export interface StepResult {
  action: Action;
  status: 'passed' | 'failed';
  error?: string;
  screenshotPath?: string;
}

export interface WebRunResult {
  status: 'passed' | 'failed';
  steps: StepResult[];
  variables?: Map<string, string>;
}

interface ExecutionContext {
  variables: Map<string, string>;
  lastEmail: Email | null;
  emailClient: InbucketClient | null;
  appwriteContext: import('../../integrations/appwrite/types').TestContext;
  appwriteConfig?: {
    endpoint: string;
    projectId: string;
    apiKey: string;
  };
}

const defaultScreenshotDir = path.join(process.cwd(), 'artifacts', 'screenshots');

function interpolateVariables(value: string, variables: Map<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    if (varName === 'uuid') {
      return crypto.randomUUID().split('-')[0]; // Short UUID
    }
    return variables.get(varName) ?? match;
  });
}

const resolveUrl = (value: string, baseUrl?: string): string => {
  if (!baseUrl) return value;
  try {
    const url = new URL(value, baseUrl);
    return url.toString();
  } catch {
    return value;
  }
};

const resolveLocator = (page: Page, locator: Locator): PWLocator => {
  if (locator.testId) return page.getByTestId(locator.testId);
  if (locator.text) return page.getByText(locator.text);
  if (locator.css) return page.locator(locator.css);
  if (locator.xpath) return page.locator(`xpath=${locator.xpath}`);
  if (locator.role) {
    const options: { name?: string } = {};
    if (locator.name) options.name = locator.name;
    // playwright typing expects an ARIA role; rely on runtime validation for flexibility
    return page.getByRole(locator.role as any, options);
  }
  if (locator.description) return page.getByText(locator.description);
  throw new Error('No usable selector found for locator');
};

async function ensureScreenshotDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

const runNavigate = async (
  page: Page,
  value: string,
  baseUrl: string | undefined,
  context: ExecutionContext,
): Promise<void> => {
  const interpolated = interpolateVariables(value, context.variables);
  const target = resolveUrl(interpolated, baseUrl);
  await page.goto(target);
};

const runTap = async (page: Page, locator: Locator): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.click();
};

const runInput = async (
  page: Page,
  locator: Locator,
  value: string,
  context: ExecutionContext,
): Promise<void> => {
  const interpolated = interpolateVariables(value, context.variables);
  const handle = resolveLocator(page, locator);
  await handle.fill(interpolated);
};

const runAssert = async (
  page: Page,
  locator: Locator,
  value: string | undefined,
  context: ExecutionContext,
): Promise<void> => {
  const handle = resolveLocator(page, locator);
  await handle.waitFor({ state: 'visible' });
  if (value) {
    const interpolated = interpolateVariables(value, context.variables);
    const text = (await handle.textContent())?.trim() ?? '';
    if (!text.includes(interpolated)) {
      throw new Error(
        `Assertion failed: expected element text to include "${interpolated}", got "${text}"`,
      );
    }
  }
};

const runWait = async (page: Page, action: Extract<Action, { type: 'wait' }>): Promise<void> => {
  if (action.target) {
    const handle = resolveLocator(page, action.target);
    await handle.waitFor({ state: 'visible', timeout: action.timeout });
    return;
  }
  await page.waitForTimeout(action.timeout ?? 1000);
};

const runScroll = async (
  page: Page,
  action: Extract<Action, { type: 'scroll' }>,
): Promise<void> => {
  if (action.target) {
    const handle = resolveLocator(page, action.target);
    await handle.scrollIntoViewIfNeeded();
    return;
  }
  const amount = action.amount ?? 500;
  const direction = action.direction ?? 'down';
  const deltaY = direction === 'up' ? -amount : amount;
  await page.evaluate((value) => window.scrollBy(0, value), deltaY);
};

const runScreenshot = async (
  page: Page,
  name: string | undefined,
  screenshotDir: string,
  stepIndex: number,
): Promise<string> => {
  await ensureScreenshotDir(screenshotDir);

  // Wait for network to be idle (or max 5 seconds)
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
    // Timeout is fine - proceed with screenshot anyway
  });

  const filename = name ?? `step-${stepIndex + 1}.png`;
  const filePath = path.join(screenshotDir, filename);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const getBrowser = (browser: BrowserName): BrowserType => {
  switch (browser) {
    case 'firefox':
      return firefox;
    case 'webkit':
      return webkit;
    default:
      return chromium;
  }
};

async function isServerRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForServer(url: string, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isServerRunning(url)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} not ready after ${timeout}ms`);
}

async function detectBuildDirectory(cwd: string): Promise<string | null> {
  // Order matters - check framework-specific dirs first, then generic ones
  const commonDirs = [
    '.next', // Next.js
    '.output', // Nuxt 3
    '.svelte-kit', // SvelteKit
    'dist', // Vite, Astro, Rollup, generic
    'build', // CRA, Remix, generic
    'out', // Next.js static export
  ];
  for (const dir of commonDirs) {
    const fullPath = path.join(cwd, dir);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        return dir;
      }
    } catch {
      // Directory doesn't exist, continue
    }
  }
  return null;
}

async function readPackageJson(cwd: string): Promise<any> {
  try {
    const packagePath = path.join(cwd, 'package.json');
    const content = await fs.readFile(packagePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

type FrameworkInfo = {
  name: string;
  buildCommand: string;
  devCommand: string;
};

function detectFramework(pkg: Record<string, unknown> | null): FrameworkInfo | null {
  if (!pkg) return null;

  const deps = { ...(pkg.dependencies as Record<string, string> || {}), ...(pkg.devDependencies as Record<string, string> || {}) };

  // Check in order of specificity (meta-frameworks first, then base frameworks)
  if (deps['next']) {
    return { name: 'next', buildCommand: 'npx -y next start', devCommand: 'next dev' };
  }
  if (deps['nuxt']) {
    return { name: 'nuxt', buildCommand: 'node .output/server/index.mjs', devCommand: 'nuxi dev' };
  }
  if (deps['astro']) {
    // Use astro dev for both - astro preview doesn't work with some adapters (e.g., Cloudflare)
    return { name: 'astro', buildCommand: 'npx -y astro dev', devCommand: 'astro dev' };
  }
  if (deps['@sveltejs/kit']) {
    return { name: 'sveltekit', buildCommand: 'npx -y vite preview', devCommand: 'vite dev' };
  }
  if (deps['@remix-run/serve'] || deps['@remix-run/dev']) {
    return { name: 'remix', buildCommand: 'npx -y remix-serve build/server/index.js', devCommand: 'remix vite:dev' };
  }
  if (deps['vite']) {
    return { name: 'vite', buildCommand: 'npx -y vite preview', devCommand: 'vite dev' };
  }
  if (deps['react-scripts']) {
    return { name: 'cra', buildCommand: 'npx -y serve -s build', devCommand: 'react-scripts start' };
  }

  return null;
}

type PackageManager = 'deno' | 'bun' | 'pnpm' | 'yarn' | 'npm';

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const hasDenoLock = await fs.stat(path.join(cwd, 'deno.lock')).catch(() => null);
  const hasBunLock = await fs.stat(path.join(cwd, 'bun.lockb')).catch(() => null);
  const hasPnpmLock = await fs.stat(path.join(cwd, 'pnpm-lock.yaml')).catch(() => null);
  const hasYarnLock = await fs.stat(path.join(cwd, 'yarn.lock')).catch(() => null);

  if (hasDenoLock) return 'deno';
  if (hasBunLock) return 'bun';
  if (hasPnpmLock) return 'pnpm';
  if (hasYarnLock) return 'yarn';
  return 'npm';
}

function getDevCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'deno': return `deno task ${script}`;
    case 'bun': return `bun run ${script}`;
    case 'pnpm': return `pnpm ${script}`;
    case 'yarn': return `yarn ${script}`;
    case 'npm': return `npm run ${script}`;
  }
}

async function detectServerCommand(cwd: string): Promise<string> {
  const pkg = await readPackageJson(cwd);
  const framework = detectFramework(pkg);
  const pm = await detectPackageManager(cwd);
  const buildDir = await detectBuildDirectory(cwd);

  // If we have a build directory, use the appropriate preview/start command
  if (buildDir) {
    if (framework) {
      console.log(`Detected ${framework.name} project with build at ${buildDir}`);
      return framework.buildCommand;
    }
    // Unknown framework with build dir - use generic static server
    console.log(`Detected build directory at ${buildDir}, using static server`);
    return `npx -y serve ${buildDir}`;
  }

  // No build directory - run dev server
  if (pkg?.scripts?.dev) {
    if (framework) {
      console.log(`Detected ${framework.name} project, running dev server`);
    }
    return getDevCommand(pm, 'dev');
  }

  if (pkg?.scripts?.start) {
    return getDevCommand(pm, 'start');
  }

  throw new Error('Could not auto-detect server command. Please specify command explicitly.');
}

export async function startWebServer(config: WebServerConfig): Promise<ChildProcess | null> {
  const { url, reuseExistingServer = true, timeout = 30000, cwd = process.cwd() } = config;

  // Check if already running
  if (reuseExistingServer && await isServerRunning(url)) {
    console.log(`Server already running at ${url}`);
    return null;
  }

  // Determine the command to run
  let command: string;

  if (config.command) {
    // Option 1: Explicit command
    command = config.command;
  } else if (config.static) {
    // Option 3: Serve static directory
    const port = config.port ?? new URL(url).port ?? '3000';
    command = `npx -y serve ${config.static} -l ${port}`;
  } else if (config.auto) {
    // Option 2: Auto-detect
    command = await detectServerCommand(cwd);
  } else {
    throw new Error('WebServerConfig requires command, auto: true, or static directory');
  }

  console.log(`Starting server: ${command}`);
  const serverProcess = spawn(command, {
    shell: true,
    stdio: 'pipe',
    cwd,
    detached: false,
  });

  serverProcess.stdout?.on('data', (data) => {
    process.stdout.write(`[server] ${data}`);
  });

  serverProcess.stderr?.on('data', (data) => {
    process.stderr.write(`[server] ${data}`);
  });

  await waitForServer(url, timeout);
  console.log(`Server ready at ${url}`);

  return serverProcess;
}

export function killServer(serverProcess: ChildProcess | null): void {
  if (serverProcess && !serverProcess.killed) {
    console.log('Stopping server...');
    serverProcess.kill('SIGTERM');
  }
}

async function handleInteractiveError(
  page: Page,
  action: Action,
  error: Error,
  screenshotDir: string,
  stepIndex: number,
  aiConfig?: import('../../ai/types').AIConfig,
): Promise<'retry' | 'skip' | 'abort' | 'debug'> {
  console.error(`\n❌ Action failed: ${action.type}`);
  console.error(`   Error: ${error.message}\n`);

  // Take screenshot
  await ensureScreenshotDir(screenshotDir);
  const screenshotPath = path.join(screenshotDir, `error-step-${stepIndex + 1}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Get page content
  const pageContent = await page.content();

  // Get AI suggestion
  if (aiConfig) {
    console.log('🤖 Analyzing error with AI...\n');
    const screenshot = await fs.readFile(screenshotPath);
    const suggestion = await getAISuggestion(error.message, action, pageContent, screenshot, aiConfig);

    if (suggestion.hasSuggestion && suggestion.suggestedSelector) {
      console.log('🤖 AI Suggestion:');
      console.log(`   ${suggestion.explanation}\n`);
      console.log('   Suggested selector:');
      console.log('   target:');
      if (suggestion.suggestedSelector.testId) {
        console.log(`     testId: "${suggestion.suggestedSelector.testId}"`);
      }
      if (suggestion.suggestedSelector.text) {
        console.log(`     text: "${suggestion.suggestedSelector.text}"`);
      }
      if (suggestion.suggestedSelector.css) {
        console.log(`     css: "${suggestion.suggestedSelector.css}"`);
      }
      if (suggestion.suggestedSelector.role) {
        console.log(`     role: "${suggestion.suggestedSelector.role}"`);
      }
      if (suggestion.suggestedSelector.name) {
        console.log(`     name: "${suggestion.suggestedSelector.name}"`);
      }
      console.log('');
    } else {
      console.log(`🤖 AI Analysis: ${suggestion.explanation}\n`);
    }
  }

  // Prompt user
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: 'Retry with AI suggestion', value: 'retry', disabled: !aiConfig },
      { title: 'Skip this step', value: 'skip' },
      { title: 'Abort test', value: 'abort' },
      { title: 'Open in browser (pause)', value: 'debug' },
    ],
    initial: 0,
  });

  return response.action || 'abort';
}

async function executeActionWithRetry(
  page: Page,
  action: Action,
  index: number,
  options: {
    baseUrl?: string;
    context: ExecutionContext;
    screenshotDir: string;
    debugMode: boolean;
    interactive: boolean;
    aiConfig?: import('../../ai/types').AIConfig;
  },
): Promise<void> {
  const { baseUrl, context, screenshotDir, debugMode, interactive, aiConfig } = options;

  while (true) {
    try {
      switch (action.type) {
        case 'navigate': {
          const interpolated = interpolateVariables(action.value, context.variables);
          const target = resolveUrl(interpolated, baseUrl);
          if (debugMode) {
            console.log(`[DEBUG] Navigating to: ${target}`);
          }
          await runNavigate(page, action.value, baseUrl, context);
          break;
        }
        case 'tap': {
          if (debugMode) {
            console.log(`[DEBUG] Tapping element:`, action.target);
          }
          await runTap(page, action.target);
          break;
        }
        case 'input': {
          if (debugMode) {
            const interpolated = interpolateVariables(action.value, context.variables);
            console.log(`[DEBUG] Inputting value into element:`, action.target);
            console.log(`[DEBUG] Value: ${interpolated}`);
          }
          await runInput(page, action.target, action.value, context);
          break;
        }
        case 'assert': {
          if (debugMode) {
            console.log(`[DEBUG] Asserting element:`, action.target);
            if (action.value) {
              const interpolated = interpolateVariables(action.value, context.variables);
              console.log(`[DEBUG] Expected text contains: ${interpolated}`);
            }
          }
          await runAssert(page, action.target, action.value, context);
          break;
        }
        case 'wait':
          await runWait(page, action);
          break;
        case 'scroll':
          await runScroll(page, action);
          break;
        case 'screenshot':
          throw new Error('Screenshot action should be handled separately');
        case 'setVar': {
          let value: string;
          if (action.value) {
            value = interpolateVariables(action.value, context.variables);
          } else if (action.from === 'response') {
            throw new Error('setVar from response not yet implemented');
          } else if (action.from === 'element') {
            throw new Error('setVar from element not yet implemented');
          } else if (action.from === 'email') {
            throw new Error('Use email.extractCode or email.extractLink instead');
          } else {
            throw new Error('setVar requires value or from');
          }
          context.variables.set(action.name, value);
          break;
        }
        case 'email.waitFor': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          const mailbox = interpolateVariables(action.mailbox, context.variables);
          context.lastEmail = await context.emailClient.waitForEmail(mailbox, {
            timeout: action.timeout,
            subjectContains: action.subjectContains,
          });
          break;
        }
        case 'email.extractCode': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          if (!context.lastEmail) {
            throw new Error('No email loaded - call email.waitFor first');
          }
          const code = context.emailClient.extractCode(
            context.lastEmail,
            action.pattern ? new RegExp(action.pattern) : undefined,
          );
          if (!code) {
            throw new Error('No code found in email');
          }
          context.variables.set(action.saveTo, code);
          break;
        }
        case 'email.extractLink': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          if (!context.lastEmail) {
            throw new Error('No email loaded - call email.waitFor first');
          }
          const link = context.emailClient.extractLink(
            context.lastEmail,
            action.pattern ? new RegExp(action.pattern) : undefined,
          );
          if (!link) {
            throw new Error('No link found in email');
          }
          context.variables.set(action.saveTo, link);
          break;
        }
        case 'email.clear': {
          if (!context.emailClient) {
            throw new Error('Email client not configured');
          }
          const mailbox = interpolateVariables(action.mailbox, context.variables);
          await context.emailClient.clearMailbox(mailbox);
          break;
        }
        case 'appwrite.verifyEmail': {
          if (!context.appwriteContext.userId) {
            throw new Error('No user tracked. appwrite.verifyEmail requires a user signup to have occurred first.');
          }
          if (!context.appwriteConfig?.apiKey) {
            throw new Error('appwrite.verifyEmail requires appwrite.apiKey in config');
          }
          const { Client, Users } = await import('node-appwrite');
          const client = new Client()
            .setEndpoint(context.appwriteConfig.endpoint)
            .setProject(context.appwriteConfig.projectId)
            .setKey(context.appwriteConfig.apiKey);
          const users = new Users(client);
          await users.updateEmailVerification(context.appwriteContext.userId, true);
          console.log(`Verified email for user ${context.appwriteContext.userId}`);
          break;
        }
        case 'debug': {
          console.log('[DEBUG] Pausing execution - Playwright Inspector will open');
          await page.pause();
          break;
        }
        default:
          throw new Error(`Unsupported action type: ${(action as Action).type}`);
      }

      // Success - break out of retry loop
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (interactive && aiConfig && hasTarget(action)) {
        const choice = await handleInteractiveError(page, action, error, screenshotDir, index, aiConfig);

        switch (choice) {
          case 'retry':
            console.log('Retrying with AI suggestion...\n');
            // Note: In a full implementation, we would modify the action.target with the suggestion
            // For now, just retry with the same selector
            continue;
          case 'skip':
            console.log('Skipping step...\n');
            return;
          case 'debug':
            console.log('Opening Playwright Inspector...\n');
            await page.pause();
            continue;
          case 'abort':
          default:
            throw error;
        }
      }

      // Non-interactive mode or debug mode - handle normally
      if (debugMode) {
        console.error(`[DEBUG] Action failed: ${error.message}`);
        console.log('[DEBUG] Opening Playwright Inspector for debugging...');
        await page.pause();
      }

      throw error;
    }
  }
}

function hasTarget(action: Action): boolean {
  return 'target' in action && action.target !== undefined;
}

export const runWebTest = async (
  test: TestDefinition,
  options: WebRunOptions = {},
): Promise<WebRunResult> => {
  if (test.platform !== 'web') {
    throw new Error(`runWebTest only supports web platform, received ${test.platform}`);
  }

  const browserName = options.browser ?? 'chromium';
  const headless = options.headed ? false : true;
  const screenshotDir = options.screenshotDir ?? defaultScreenshotDir;
  const defaultTimeout = options.defaultTimeoutMs ?? 30000;

  // Start tracking server for SSR resource tracking
  const sessionId = crypto.randomUUID();
  const trackingServer = new TrackingServer();
  await trackingServer.start();

  // Set env vars so the app can track resources
  process.env.INTELLITESTER_SESSION_ID = sessionId;
  process.env.INTELLITESTER_TRACK_URL = `http://localhost:${trackingServer.port}`;

  // Start webServer if configured
  let serverProcess: ChildProcess | null = null;
  if (options.webServer) {
    serverProcess = await startWebServer(options.webServer);
  }

  // Handle Ctrl+C and termination signals
  const cleanup = () => {
    trackingServer.stop();
    killServer(serverProcess);
    process.exit(1);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Launch local browser
  const browser = await getBrowser(browserName).launch({ headless });

  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  page.setDefaultTimeout(defaultTimeout);

  // Initialize execution context with variables
  const executionContext: ExecutionContext = {
    variables: new Map<string, string>(),
    lastEmail: null,
    emailClient: null,
    appwriteContext: createTestContext(),
    appwriteConfig: test.config?.appwrite ? {
      endpoint: test.config.appwrite.endpoint,
      projectId: test.config.appwrite.projectId,
      apiKey: test.config.appwrite.apiKey,
    } : undefined,
  };

  // Initialize email client if configured
  if (test.config?.email) {
    const emailEndpoint = test.config.email.endpoint ?? process.env.INBUCKET_URL;
    if (!emailEndpoint) {
      throw new Error('Email testing requires endpoint in config or INBUCKET_URL env var');
    }
    executionContext.emailClient = new InbucketClient({
      endpoint: emailEndpoint,
    });
  }

  // Set up network interception for Appwrite API responses
  page.on('response', async (response) => {
    const url = response.url();
    const method = response.request().method();

    try {
      // Handle POST requests (resource creation)
      if (method === 'POST') {
        // User created
        if (APPWRITE_PATTERNS.userCreate.test(url)) {
          const data = await response.json();
          executionContext.appwriteContext.userId = data.$id;
          executionContext.appwriteContext.userEmail = data.email;
          return;
        }

        // Row created
        const rowMatch = url.match(APPWRITE_PATTERNS.rowCreate);
        if (rowMatch) {
          const data = await response.json();
          executionContext.appwriteContext.resources.push({
            type: 'row',
            id: data.$id,
            databaseId: rowMatch[1],
            tableId: rowMatch[2],
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // File created
        const fileMatch = url.match(APPWRITE_PATTERNS.fileCreate);
        if (fileMatch) {
          const data = await response.json();
          executionContext.appwriteContext.resources.push({
            type: 'file',
            id: data.$id,
            bucketId: fileMatch[1],
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // Team created
        const teamMatch = url.match(APPWRITE_PATTERNS.teamCreate);
        if (teamMatch) {
          const data = await response.json();
          executionContext.appwriteContext.resources.push({
            type: 'team',
            id: data.$id,
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // Membership created
        const membershipMatch = url.match(APPWRITE_PATTERNS.membershipCreate);
        if (membershipMatch) {
          const data = await response.json();
          executionContext.appwriteContext.resources.push({
            type: 'membership',
            id: data.$id,
            teamId: membershipMatch[1],
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // Message created
        const messageMatch = url.match(APPWRITE_PATTERNS.messageCreate);
        if (messageMatch) {
          const data = await response.json();
          executionContext.appwriteContext.resources.push({
            type: 'message',
            id: data.$id,
            createdAt: new Date().toISOString(),
          });
          return;
        }
      }

      // Handle PUT/PATCH requests (resource updates)
      if (method === 'PUT' || method === 'PATCH') {
        // Row updated
        const rowUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.rowUpdate);
        if (rowUpdateMatch) {
          const resourceId = rowUpdateMatch[3];
          const existingResource = executionContext.appwriteContext.resources.find(
            r => r.type === 'row' && r.id === resourceId
          );
          if (!existingResource) {
            // Resource was updated but not created in this test - track it for potential cleanup
            executionContext.appwriteContext.resources.push({
              type: 'row',
              id: resourceId,
              databaseId: rowUpdateMatch[1],
              tableId: rowUpdateMatch[2],
              createdAt: new Date().toISOString(),
            });
          }
          return;
        }

        // File updated
        const fileUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.fileUpdate);
        if (fileUpdateMatch) {
          const resourceId = fileUpdateMatch[2];
          const existingResource = executionContext.appwriteContext.resources.find(
            r => r.type === 'file' && r.id === resourceId
          );
          if (!existingResource) {
            // Resource was updated but not created in this test - track it for potential cleanup
            executionContext.appwriteContext.resources.push({
              type: 'file',
              id: resourceId,
              bucketId: fileUpdateMatch[1],
              createdAt: new Date().toISOString(),
            });
          }
          return;
        }

        // Team updated
        const teamUpdateMatch = url.match(APPWRITE_UPDATE_PATTERNS.teamUpdate);
        if (teamUpdateMatch) {
          const resourceId = teamUpdateMatch[1];
          const existingResource = executionContext.appwriteContext.resources.find(
            r => r.type === 'team' && r.id === resourceId
          );
          if (!existingResource) {
            // Resource was updated but not created in this test - track it for potential cleanup
            executionContext.appwriteContext.resources.push({
              type: 'team',
              id: resourceId,
              createdAt: new Date().toISOString(),
            });
          }
          return;
        }
      }

      // Handle DELETE requests (mark resources as deleted)
      if (method === 'DELETE') {
        // Row deleted
        const rowDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.rowDelete);
        if (rowDeleteMatch) {
          const resourceId = rowDeleteMatch[3];
          const resource = executionContext.appwriteContext.resources.find(
            r => r.type === 'row' && r.id === resourceId
          );
          if (resource) {
            resource.deleted = true;
          }
          return;
        }

        // File deleted
        const fileDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.fileDelete);
        if (fileDeleteMatch) {
          const resourceId = fileDeleteMatch[2];
          const resource = executionContext.appwriteContext.resources.find(
            r => r.type === 'file' && r.id === resourceId
          );
          if (resource) {
            resource.deleted = true;
          }
          return;
        }

        // Team deleted
        const teamDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.teamDelete);
        if (teamDeleteMatch) {
          const resourceId = teamDeleteMatch[1];
          const resource = executionContext.appwriteContext.resources.find(
            r => r.type === 'team' && r.id === resourceId
          );
          if (resource) {
            resource.deleted = true;
          }
          return;
        }

        // Membership deleted
        const membershipDeleteMatch = url.match(APPWRITE_DELETE_PATTERNS.membershipDelete);
        if (membershipDeleteMatch) {
          const resourceId = membershipDeleteMatch[2];
          const resource = executionContext.appwriteContext.resources.find(
            r => r.type === 'membership' && r.id === resourceId
          );
          if (resource) {
            resource.deleted = true;
          }
          return;
        }
      }
    } catch {
      // Ignore parse errors for non-JSON responses
    }
  });

  // Initialize variables from test definition
  if (test.variables) {
    for (const [key, value] of Object.entries(test.variables)) {
      // Interpolate variable values to handle nested {{uuid}}
      const interpolated = interpolateVariables(value, executionContext.variables);
      executionContext.variables.set(key, interpolated);
    }
  }

  const results: StepResult[] = [];
  const debugMode = options.debug ?? false;
  const interactive = options.interactive ?? false;

  try {
    for (const [index, action] of test.steps.entries()) {
      if (debugMode) {
        console.log(`[DEBUG] Executing step ${index + 1}: ${action.type}`);
      }

      // Merge server-tracked resources before each action
      const serverResources = trackingServer.getResources(sessionId);
      for (const resource of serverResources) {
        // Check for tracked users
        if (resource.type === 'user' && !executionContext.appwriteContext.userId) {
          executionContext.appwriteContext.userId = resource.id;
        }
        // Add to resources if not already tracked (only for known types)
        const knownTypes = ['row', 'file', 'user', 'team', 'membership', 'message'] as const;
        if (knownTypes.includes(resource.type as any)) {
          const exists = executionContext.appwriteContext.resources.some(
            r => r.type === resource.type && r.id === resource.id
          );
          if (!exists) {
            executionContext.appwriteContext.resources.push({
              type: resource.type as TrackedResource['type'],
              id: resource.id,
              databaseId: resource.databaseId as string | undefined,
              tableId: resource.tableId as string | undefined,
              bucketId: resource.bucketId as string | undefined,
              teamId: resource.teamId as string | undefined,
              createdAt: resource.createdAt || new Date().toISOString(),
            });
          }
        }
      }

      try {
        // Handle screenshot separately since it has special return handling
        if (action.type === 'screenshot') {
          const screenshotPath = await runScreenshot(page, action.name, screenshotDir, index);
          results.push({ action, status: 'passed', screenshotPath });
          continue;
        }

        // Use the new executeActionWithRetry for all other actions
        await executeActionWithRetry(page, action, index, {
          baseUrl: options.baseUrl ?? test.config?.web?.baseUrl,
          context: executionContext,
          screenshotDir,
          debugMode,
          interactive,
          aiConfig: options.aiConfig,
        });

        results.push({ action, status: 'passed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ action, status: 'failed', error: message });
        throw error;
      }
    }
  } finally {
    // Remove signal handlers
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);

    // Run Appwrite cleanup if configured
    if (test.config?.appwrite?.cleanup) {
      const appwriteClient = new AppwriteTestClient({
        endpoint: test.config.appwrite.endpoint,
        projectId: test.config.appwrite.projectId,
        apiKey: test.config.appwrite.apiKey,
        cleanup: true,
      });

      const cleanupResult = await appwriteClient.cleanup(
        executionContext.appwriteContext,
        sessionId,
        process.cwd()
      );
      console.log('Cleanup result:', cleanupResult);
    }

    await browserContext.close();
    await browser.close();

    // Stop tracking server
    trackingServer.stop();

    // Stop webServer if it was started
    killServer(serverProcess);
  }

  return {
    status: results.every((step) => step.status === 'passed') ? 'passed' : 'failed',
    steps: results,
    variables: executionContext.variables,
  };
};
