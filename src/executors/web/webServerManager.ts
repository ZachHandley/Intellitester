import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface WebServerConfig {
  url: string;
  command?: string;
  auto?: boolean;
  static?: string;
  port?: number;
  workdir?: string;
  cwd?: string;
  reuseExistingServer?: boolean;
  timeout?: number;
  idleTimeout?: number;
}

async function isServerRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
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

  if (deps['next']) {
    return { name: 'next', buildCommand: 'npx -y next start', devCommand: 'next dev' };
  }
  if (deps['nuxt']) {
    return { name: 'nuxt', buildCommand: 'node .output/server/index.mjs', devCommand: 'nuxi dev' };
  }
  if (deps['astro']) {
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

async function detectBuildDirectory(cwd: string): Promise<string | null> {
  const commonDirs = [
    '.next', '.output', '.svelte-kit', 'dist', 'build', 'out',
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

async function detectServerCommand(cwd: string): Promise<string> {
  const pkg = await readPackageJson(cwd);
  const framework = detectFramework(pkg);
  const pm = await detectPackageManager(cwd);
  const buildDir = await detectBuildDirectory(cwd);

  if (buildDir) {
    if (framework) {
      console.log(`Detected ${framework.name} project with build at ${buildDir}`);
      return framework.buildCommand;
    }
    console.log(`Detected build directory at ${buildDir}, using static server`);
    return `npx -y serve ${buildDir}`;
  }

  const scripts = pkg?.scripts as Record<string, string> | undefined;
  if (scripts?.dev) {
    if (framework) {
      console.log(`Detected ${framework.name} project, running dev server`);
    }
    return getDevCommand(pm, 'dev');
  }

  if (scripts?.start) {
    return getDevCommand(pm, 'start');
  }

  throw new Error('Could not auto-detect server command. Please specify command explicitly.');
}

/**
 * Singleton manager for web server lifecycle.
 *
 * Handles starting/stopping the dev server with proper cleanup to avoid
 * race conditions where a dying server responds to health checks but is
 * gone by the time tests run.
 */
class WebServerManager {
  private static instance: WebServerManager;

  private serverProcess: ChildProcess | null = null;
  private currentUrl: string | null = null;
  private currentCwd: string | null = null;
  private stopping: boolean = false;

  private constructor() {}

  static getInstance(): WebServerManager {
    if (!WebServerManager.instance) {
      WebServerManager.instance = new WebServerManager();
    }
    return WebServerManager.instance;
  }

  /**
   * Check if the managed server is currently running
   */
  isRunning(): boolean {
    return this.serverProcess !== null && !this.serverProcess.killed;
  }

  /**
   * Get the current server URL if running
   */
  getUrl(): string | null {
    return this.currentUrl;
  }

  /**
   * Start a web server with the given config.
   *
   * - If a server is already running at the same URL, reuses it (unless reuseExistingServer=false)
   * - If a server is running at a different URL, stops it first
   * - Properly waits for any stopping server to fully terminate
   */
  async start(config: WebServerConfig): Promise<ChildProcess | null> {
    const { url, reuseExistingServer = true, timeout = 30000, idleTimeout = 20000 } = config;
    const cwd = config.workdir ?? config.cwd ?? process.cwd();

    // Wait for any in-progress stop operation
    while (this.stopping) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Check if we already have a server running at this URL
    if (this.serverProcess && !this.serverProcess.killed && this.currentUrl === url) {
      // Verify it's actually responding
      if (await isServerRunning(url)) {
        if (reuseExistingServer) {
          console.log(`Server already running at ${url}`);
          return this.serverProcess;
        } else {
          // Need to restart - stop first
          await this.stop();
        }
      } else {
        // Process exists but not responding - clean it up
        await this.stop();
      }
    }

    // If we have a server at a different URL, stop it
    if (this.serverProcess && !this.serverProcess.killed && this.currentUrl !== url) {
      await this.stop();
    }

    // Check if something external is running at this URL
    if (reuseExistingServer && await isServerRunning(url)) {
      console.log(`Server already running at ${url}`);
      this.currentUrl = url;
      this.currentCwd = cwd;
      return null; // External server, we don't manage it
    }

    // Determine the command to run
    let command: string;

    if (config.command) {
      command = config.command;
    } else if (config.static) {
      const port = config.port ?? new URL(url).port ?? '3000';
      command = `npx -y serve ${config.static} -l ${port}`;
    } else if (config.auto) {
      command = await detectServerCommand(cwd);
    } else {
      throw new Error('WebServerConfig requires command, auto: true, or static directory');
    }

    console.log(`Starting server: ${command}`);
    this.serverProcess = spawn(command, {
      shell: true,
      stdio: 'pipe',
      cwd,
      detached: false,
    });
    this.currentUrl = url;
    this.currentCwd = cwd;

    let stderrOutput = '';
    let lastOutputTime = Date.now();

    this.serverProcess.stdout?.on('data', (data) => {
      lastOutputTime = Date.now();
      process.stdout.write(`[server] ${data}`);
    });

    this.serverProcess.stderr?.on('data', (data) => {
      lastOutputTime = Date.now();
      stderrOutput += data.toString();
      process.stderr.write(`[server] ${data}`);
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      const startTime = Date.now();

      const cleanup = () => {
        resolved = true;
        clearInterval(pollInterval);
      };

      this.serverProcess!.on('close', (code) => {
        if (!resolved && code !== 0 && code !== null) {
          cleanup();
          this.serverProcess = null;
          this.currentUrl = null;
          reject(new Error(`Server exited with code ${code}\n${stderrOutput}`));
        }
      });

      this.serverProcess!.on('error', (err) => {
        if (!resolved) {
          cleanup();
          this.serverProcess = null;
          this.currentUrl = null;
          reject(err);
        }
      });

      const pollInterval = setInterval(async () => {
        if (resolved) return;

        if (await isServerRunning(url)) {
          cleanup();
          resolve();
          return;
        }

        if (Date.now() - startTime > timeout) {
          cleanup();
          reject(new Error(`Server at ${url} not ready after ${timeout}ms`));
          return;
        }

        if (Date.now() - lastOutputTime > idleTimeout) {
          cleanup();
          this.serverProcess?.kill('SIGTERM');
          this.serverProcess = null;
          this.currentUrl = null;
          const lastOutput = stderrOutput.slice(-500);
          reject(new Error(`Server stalled - no output for ${idleTimeout}ms. Last output:\n${lastOutput}`));
          return;
        }
      }, 500);
    });

    console.log(`Server ready at ${url}`);
    return this.serverProcess;
  }

  /**
   * Stop the managed server and wait for it to fully terminate.
   * This prevents race conditions where a dying server still responds to health checks.
   */
  async stop(): Promise<void> {
    if (!this.serverProcess || this.serverProcess.killed) {
      this.serverProcess = null;
      this.currentUrl = null;
      this.currentCwd = null;
      return;
    }

    this.stopping = true;
    console.log('Stopping server...');

    const process = this.serverProcess;

    // Create a promise that resolves when the process actually exits
    const exitPromise = new Promise<void>((resolve) => {
      const onExit = () => {
        process.removeListener('close', onExit);
        process.removeListener('exit', onExit);
        resolve();
      };
      process.on('close', onExit);
      process.on('exit', onExit);

      // Also resolve if already dead
      if (process.killed || process.exitCode !== null) {
        resolve();
      }
    });

    // Send SIGTERM
    process.kill('SIGTERM');

    // Wait for exit with a timeout
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        // If still alive after 5 seconds, force kill
        if (!process.killed && process.exitCode === null) {
          console.log('Server did not stop gracefully, sending SIGKILL...');
          process.kill('SIGKILL');
        }
        resolve();
      }, 5000);
    });

    await Promise.race([exitPromise, timeoutPromise]);

    // Wait a bit more to ensure port is released
    await new Promise(r => setTimeout(r, 200));

    this.serverProcess = null;
    this.currentUrl = null;
    this.currentCwd = null;
    this.stopping = false;
  }

  /**
   * Synchronous kill for signal handlers - doesn't wait for termination
   */
  kill(): void {
    if (this.serverProcess && !this.serverProcess.killed) {
      console.log('Stopping server...');
      this.serverProcess.kill('SIGTERM');
    }
    this.serverProcess = null;
    this.currentUrl = null;
    this.currentCwd = null;
  }
}

// Export singleton instance
export const webServerManager = WebServerManager.getInstance();

export { isServerRunning };
