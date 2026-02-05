import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { rmSync } from 'fs';

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

// Marker file constants and helpers for server ownership tracking
const SERVER_MARKER_FILE = 'server.json';
const INTELLITESTER_DIR = '.intellitester';

interface ServerMarker {
  pid: number;
  port: number;
  url: string;
  cwd: string;
  command: string;
  startTime: string;
}

const getMarkerPath = (cwd: string): string => path.join(cwd, INTELLITESTER_DIR, SERVER_MARKER_FILE);

async function writeMarkerFile(cwd: string, marker: ServerMarker): Promise<void> {
  const dir = path.join(cwd, INTELLITESTER_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getMarkerPath(cwd), JSON.stringify(marker, null, 2), 'utf-8');
}

async function readMarkerFile(cwd: string): Promise<ServerMarker | null> {
  try {
    const content = await fs.readFile(getMarkerPath(cwd), 'utf-8');
    return JSON.parse(content) as ServerMarker;
  } catch {
    return null;
  }
}

async function deleteMarkerFile(cwd: string): Promise<void> {
  try {
    await fs.rm(getMarkerPath(cwd), { force: true });
  } catch {
    // Ignore errors
  }
}

function deleteMarkerFileSync(cwd: string): void {
  try {
    rmSync(getMarkerPath(cwd), { force: true });
  } catch {
    // Ignore errors
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 just checks if process exists
    return true;
  } catch {
    return false;
  }
}

async function isServerRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function verifyMarker(cwd: string, url: string): Promise<{ valid: boolean; marker: ServerMarker | null; reason?: string }> {
  const marker = await readMarkerFile(cwd);
  if (!marker) {
    return { valid: false, marker: null, reason: 'No marker file found' };
  }
  
  if (marker.url !== url) {
    return { valid: false, marker, reason: `URL mismatch: expected ${url}, got ${marker.url}` };
  }
  
  if (marker.cwd !== cwd) {
    return { valid: false, marker, reason: `CWD mismatch: expected ${cwd}, got ${marker.cwd}` };
  }
  
  if (!isPidAlive(marker.pid)) {
    return { valid: false, marker, reason: `PID ${marker.pid} is not alive` };
  }
  
  // Verify the server is actually responding (with retries)
  let serverResponding = false;
  for (let i = 0; i < 3; i++) {
    if (await isServerRunning(url)) {
      serverResponding = true;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!serverResponding) {
    return { valid: false, marker, reason: 'Server not responding to HTTP after retries' };
  }
  
  return { valid: true, marker };
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
  const hasBunLockb = await fs.stat(path.join(cwd, 'bun.lockb')).catch(() => null);
  const hasBunLock = await fs.stat(path.join(cwd, 'bun.lock')).catch(() => null);
  const hasPnpmLock = await fs.stat(path.join(cwd, 'pnpm-lock.yaml')).catch(() => null);
  const hasYarnLock = await fs.stat(path.join(cwd, 'yarn.lock')).catch(() => null);

  if (hasDenoLock) return 'deno';
  if (hasBunLockb || hasBunLock) return 'bun';
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

    // Check if we have a valid marker for a server we previously started
    const verification = await verifyMarker(cwd, url);
    if (verification.valid && reuseExistingServer) {
      // Wait a moment to ensure server is fully ready
      await new Promise(r => setTimeout(r, 1000));
      // Double-check it's still responding
      if (!await isServerRunning(url)) {
        console.log('Server stopped responding, will start fresh');
      } else {
        console.log(`Reusing existing server at ${url} (PID: ${verification.marker!.pid})`);
        this.currentUrl = url;
        this.currentCwd = cwd;
        return null;
      }
    }

    // If marker exists but invalid, clean up the orphaned server
    if (verification.marker && !verification.valid) {
      console.log(`Cleaning up stale server: ${verification.reason}`);
      if (isPidAlive(verification.marker.pid)) {
        try {
          process.kill(verification.marker.pid, 'SIGTERM');
          // Wait a bit for graceful shutdown
          await new Promise(r => setTimeout(r, 1000));
          if (isPidAlive(verification.marker.pid)) {
            process.kill(verification.marker.pid, 'SIGKILL');
          }
        } catch {
          // Process might already be dead
        }
      }
      await deleteMarkerFile(cwd);
    }

    // If something else is running at this URL (not ours), handle it
    if (await isServerRunning(url)) {
      if (!reuseExistingServer) {
        throw new Error(`Port ${new URL(url).port} is already in use by another process`);
      }
      console.log(`Reusing existing server at ${url}`);
      return null; // Return null to indicate we're reusing an external server
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
      detached: true, // Create new process group so we can kill all children
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

    // Delete marker if server exits unexpectedly
    this.serverProcess.on('exit', () => {
      if (this.currentCwd) {
        deleteMarkerFileSync(this.currentCwd);
      }
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

    // Write marker file for future reuse verification
    if (this.serverProcess?.pid) {
      await writeMarkerFile(cwd, {
        pid: this.serverProcess.pid,
        port: parseInt(new URL(url).port || '80'),
        url,
        cwd,
        command,
        startTime: new Date().toISOString(),
      });
    }

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

    // Send SIGTERM to process group (negative PID) to kill children too
    const pid = process.pid;
    try {
      if (pid) {
        globalThis.process.kill(-pid, 'SIGTERM');
      } else {
        process.kill('SIGTERM');
      }
    } catch {
      process.kill('SIGTERM');
    }

    // Wait for exit with a timeout
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        // If still alive after 5 seconds, force kill
        if (!process.killed && process.exitCode === null) {
          console.log('Server did not stop gracefully, sending SIGKILL...');
          try {
            if (pid) {
              globalThis.process.kill(-pid, 'SIGKILL');
            } else {
              process.kill('SIGKILL');
            }
          } catch {
            process.kill('SIGKILL');
          }
        }
        resolve();
      }, 5000);
    });

    await Promise.race([exitPromise, timeoutPromise]);

    // Wait a bit more to ensure port is released
    await new Promise(r => setTimeout(r, 200));

    // Delete marker file before clearing state
    if (this.currentCwd) {
      await deleteMarkerFile(this.currentCwd);
    }

    this.serverProcess = null;
    this.currentUrl = null;
    this.currentCwd = null;
    this.stopping = false;
  }

  /**
   * Synchronous kill for signal handlers - kills process group to ensure children die too
   */
  kill(): void {
    if (this.serverProcess && !this.serverProcess.killed) {
      console.log('Stopping server...');
      const pid = this.serverProcess.pid;
      if (pid) {
        try {
          // Kill the entire process group (negative PID) to kill shell children too
          process.kill(-pid, 'SIGTERM');
        } catch {
          // Fallback to regular kill if process group kill fails
          this.serverProcess.kill('SIGTERM');
        }
        // Also send SIGKILL after a short delay to force termination
        setTimeout(() => {
          try {
            if (pid) process.kill(-pid, 'SIGKILL');
          } catch {
            // Process already dead, ignore
          }
        }, 1000);
      } else {
        this.serverProcess.kill('SIGTERM');
      }
    }
    // Delete marker file synchronously for signal handlers
    if (this.currentCwd) {
      deleteMarkerFileSync(this.currentCwd);
    }
    this.serverProcess = null;
    this.currentUrl = null;
    this.currentCwd = null;
  }
}

// Export singleton instance
export const webServerManager = WebServerManager.getInstance();

export { isServerRunning };
