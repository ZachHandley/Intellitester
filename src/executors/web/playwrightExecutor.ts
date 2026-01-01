import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
  type Locator as PWLocator,
  type Page,
} from 'playwright';

import type { Action, Locator, TestDefinition } from '../../core/types';
import { InbucketClient } from '../../integrations/email/inbucketClient';
import type { Email } from '../../integrations/email/types';
import { AppwriteTestClient, createTestContext, APPWRITE_PATTERNS, APPWRITE_UPDATE_PATTERNS, APPWRITE_DELETE_PATTERNS, type TrackedResource } from '../../integrations/appwrite';

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
    return { name: 'astro', buildCommand: 'npx -y astro preview', devCommand: 'astro dev' };
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

async function startWebServer(config: WebServerConfig): Promise<ChildProcess | null> {
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

function killServer(serverProcess: ChildProcess | null): void {
  if (serverProcess && !serverProcess.killed) {
    console.log('Stopping server...');
    serverProcess.kill('SIGTERM');
  }
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

  // Start webServer if configured
  let serverProcess: ChildProcess | null = null;
  if (options.webServer) {
    serverProcess = await startWebServer(options.webServer);
  }

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
  };

  // Initialize email client if configured
  if (test.config?.email) {
    executionContext.emailClient = new InbucketClient({
      endpoint: test.config.email.endpoint,
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
    } catch (e) {
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
  try {
    for (const [index, action] of test.steps.entries()) {
      try {
        switch (action.type) {
          case 'navigate':
            await runNavigate(
              page,
              action.value,
              options.baseUrl ?? test.config?.web?.baseUrl,
              executionContext,
            );
            break;
          case 'tap':
            await runTap(page, action.target);
            break;
          case 'input':
            await runInput(page, action.target, action.value, executionContext);
            break;
          case 'assert':
            await runAssert(page, action.target, action.value, executionContext);
            break;
          case 'wait':
            await runWait(page, action);
            break;
          case 'scroll':
            await runScroll(page, action);
            break;
          case 'screenshot': {
            const screenshotPath = await runScreenshot(page, action.name, screenshotDir, index);
            results.push({ action, status: 'passed', screenshotPath });
            continue;
          }
          case 'setVar': {
            let value: string;
            if (action.value) {
              value = interpolateVariables(action.value, executionContext.variables);
            } else if (action.from === 'response') {
              // Extract from last network response (future)
              throw new Error('setVar from response not yet implemented');
            } else if (action.from === 'element') {
              // Extract from DOM element (future)
              throw new Error('setVar from element not yet implemented');
            } else if (action.from === 'email') {
              // Already handled by email.extractCode/extractLink
              throw new Error('Use email.extractCode or email.extractLink instead');
            } else {
              throw new Error('setVar requires value or from');
            }
            executionContext.variables.set(action.name, value);
            break;
          }
          case 'email.waitFor': {
            if (!executionContext.emailClient) {
              throw new Error('Email client not configured');
            }
            const mailbox = interpolateVariables(action.mailbox, executionContext.variables);
            executionContext.lastEmail = await executionContext.emailClient.waitForEmail(mailbox, {
              timeout: action.timeout,
              subjectContains: action.subjectContains,
            });
            break;
          }
          case 'email.extractCode': {
            if (!executionContext.emailClient) {
              throw new Error('Email client not configured');
            }
            if (!executionContext.lastEmail) {
              throw new Error('No email loaded - call email.waitFor first');
            }
            const code = executionContext.emailClient.extractCode(
              executionContext.lastEmail,
              action.pattern ? new RegExp(action.pattern) : undefined,
            );
            if (!code) {
              throw new Error('No code found in email');
            }
            executionContext.variables.set(action.saveTo, code);
            break;
          }
          case 'email.extractLink': {
            if (!executionContext.emailClient) {
              throw new Error('Email client not configured');
            }
            if (!executionContext.lastEmail) {
              throw new Error('No email loaded - call email.waitFor first');
            }
            const link = executionContext.emailClient.extractLink(
              executionContext.lastEmail,
              action.pattern ? new RegExp(action.pattern) : undefined,
            );
            if (!link) {
              throw new Error('No link found in email');
            }
            executionContext.variables.set(action.saveTo, link);
            break;
          }
          case 'email.clear': {
            if (!executionContext.emailClient) {
              throw new Error('Email client not configured');
            }
            const mailbox = interpolateVariables(action.mailbox, executionContext.variables);
            await executionContext.emailClient.clearMailbox(mailbox);
            break;
          }
          default:
            // Exhaustiveness guard
            throw new Error(`Unsupported action type: ${(action as Action).type}`);
        }
        results.push({ action, status: 'passed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ action, status: 'failed', error: message });
        throw error;
      }
    }
  } finally {
    // Run Appwrite cleanup if configured
    if (test.config?.appwrite?.cleanup) {
      const appwriteClient = new AppwriteTestClient({
        endpoint: test.config.appwrite.endpoint,
        projectId: test.config.appwrite.projectId,
        apiKey: test.config.appwrite.apiKey,
        cleanup: true,
      });

      const cleanupResult = await appwriteClient.cleanup(executionContext.appwriteContext);
      console.log('Cleanup result:', cleanupResult);
    }

    await browserContext.close();
    await browser.close();

    // Stop webServer if it was started
    killServer(serverProcess);
  }

  return {
    status: results.every((step) => step.status === 'passed') ? 'passed' : 'failed',
    steps: results,
    variables: executionContext.variables,
  };
};
