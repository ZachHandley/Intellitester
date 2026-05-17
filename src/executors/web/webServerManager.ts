import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { rmSync, readFileSync, existsSync } from 'fs';

/**
 * Per-process web server configuration entry.
 *
 * `webServer` in YAML can be either a single entry or an ordered array of these.
 * When given an array, the manager starts each entry sequentially -- waiting for
 * the previous one's `url` to respond before launching the next -- and shuts
 * them down in reverse order. This lets users express dependencies like "start
 * the API before the frontend that proxies to it".
 */
export interface WebServerConfig {
  /** Identifier used in logs and the marker file (defaults to server-1, server-2, ...). */
  name?: string;
  url: string;
  command?: string;
  auto?: boolean;
  static?: string;
  port?: number;
  workdir?: string;
  /** Deprecated: use workdir instead. */
  cwd?: string;
  reuseExistingServer?: boolean;
  timeout?: number;
  idleTimeout?: number;
}

/**
 * Either a single web server config (existing single-process behaviour) or an
 * ordered list of entries. Array order determines start order and the reverse
 * determines shutdown order.
 */
export type WebServerInput = WebServerConfig | WebServerConfig[];

// ---------------------------------------------------------------------------
// Marker file constants and helpers
// ---------------------------------------------------------------------------

const INTELLITESTER_DIR = '.intellitester';
const SERVERS_MARKER_FILE = 'servers.json';
const LEGACY_SINGLE_MARKER_FILE = 'server.json';

interface ServerMarker {
  name: string;
  pid: number;
  port: number;
  url: string;
  cwd: string;
  command: string;
  startTime: string;
}

interface ServersMarkerFile {
  entries: ServerMarker[];
}

const getMarkerDir = (cwd: string): string => path.join(cwd, INTELLITESTER_DIR);
const getMarkerPath = (cwd: string): string => path.join(getMarkerDir(cwd), SERVERS_MARKER_FILE);
const getLegacyMarkerPath = (cwd: string): string =>
  path.join(getMarkerDir(cwd), LEGACY_SINGLE_MARKER_FILE);

async function readMarkers(cwd: string): Promise<ServersMarkerFile> {
  // New multi-entry format first.
  try {
    const content = await fs.readFile(getMarkerPath(cwd), 'utf-8');
    const parsed = JSON.parse(content) as Partial<ServersMarkerFile>;
    if (Array.isArray(parsed.entries)) {
      return { entries: parsed.entries as ServerMarker[] };
    }
  } catch {
    // fall through to legacy
  }
  // One-shot migration: legacy server.json was a single object.
  try {
    const content = await fs.readFile(getLegacyMarkerPath(cwd), 'utf-8');
    const legacy = JSON.parse(content) as Partial<ServerMarker>;
    if (legacy && typeof legacy.pid === 'number' && typeof legacy.url === 'string') {
      return {
        entries: [
          {
            name: 'server-1',
            pid: legacy.pid,
            port: legacy.port ?? 0,
            url: legacy.url,
            cwd: legacy.cwd ?? cwd,
            command: legacy.command ?? '',
            startTime: legacy.startTime ?? new Date().toISOString(),
          },
        ],
      };
    }
  } catch {
    // no legacy marker either
  }
  return { entries: [] };
}

async function writeMarkers(cwd: string, markers: ServersMarkerFile): Promise<void> {
  await fs.mkdir(getMarkerDir(cwd), { recursive: true });
  await fs.writeFile(getMarkerPath(cwd), JSON.stringify(markers, null, 2), 'utf-8');
}

async function upsertMarker(cwd: string, entry: ServerMarker): Promise<void> {
  const current = await readMarkers(cwd);
  const filtered = current.entries.filter((e) => e.url !== entry.url && e.name !== entry.name);
  filtered.push(entry);
  await writeMarkers(cwd, { entries: filtered });
}

async function removeMarker(cwd: string, identifier: { name?: string; url?: string }): Promise<void> {
  try {
    const current = await readMarkers(cwd);
    const filtered = current.entries.filter(
      (e) =>
        (identifier.name === undefined || e.name !== identifier.name) &&
        (identifier.url === undefined || e.url !== identifier.url),
    );
    if (filtered.length === 0) {
      await fs.rm(getMarkerPath(cwd), { force: true });
    } else {
      await writeMarkers(cwd, { entries: filtered });
    }
  } catch {
    // Ignore -- the marker file may not exist.
  }
}

function removeMarkerSync(cwd: string, identifier: { name?: string; url?: string }): void {
  try {
    const markerPath = getMarkerPath(cwd);
    if (!existsSync(markerPath)) return;
    const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as Partial<ServersMarkerFile>;
    if (!Array.isArray(parsed.entries)) return;
    const filtered = (parsed.entries as ServerMarker[]).filter(
      (e) =>
        (identifier.name === undefined || e.name !== identifier.name) &&
        (identifier.url === undefined || e.url !== identifier.url),
    );
    if (filtered.length === 0) {
      rmSync(markerPath, { force: true });
    } else {
      // Synchronous-write fallback for signal handlers.
      const tmp = JSON.stringify({ entries: filtered }, null, 2);
      // We deliberately use writeFileSync via fs.rm + readFileSync neighbours;
      // node's fs has writeFileSync but importing it adds noise -- inline path:
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').writeFileSync(markerPath, tmp, 'utf-8');
    }
  } catch {
    // Ignore -- signal-handler context, best-effort.
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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

// ---------------------------------------------------------------------------
// Auto-detect helpers (unchanged from previous version)
// ---------------------------------------------------------------------------

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
  const deps = {
    ...((pkg.dependencies as Record<string, string>) || {}),
    ...((pkg.devDependencies as Record<string, string>) || {}),
  };
  if (deps['next']) return { name: 'next', buildCommand: 'npx -y next start', devCommand: 'next dev' };
  if (deps['nuxt']) return { name: 'nuxt', buildCommand: 'node .output/server/index.mjs', devCommand: 'nuxi dev' };
  if (deps['astro']) return { name: 'astro', buildCommand: 'npx -y astro dev', devCommand: 'astro dev' };
  if (deps['@sveltejs/kit']) return { name: 'sveltekit', buildCommand: 'npx -y vite preview', devCommand: 'vite dev' };
  if (deps['@remix-run/serve'] || deps['@remix-run/dev']) {
    return { name: 'remix', buildCommand: 'npx -y remix-serve build/server/index.js', devCommand: 'remix vite:dev' };
  }
  if (deps['vite']) return { name: 'vite', buildCommand: 'npx -y vite preview', devCommand: 'vite dev' };
  if (deps['react-scripts']) return { name: 'cra', buildCommand: 'npx -y serve -s build', devCommand: 'react-scripts start' };
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
  const commonDirs = ['.next', '.output', '.svelte-kit', 'dist', 'build', 'out'];
  for (const dir of commonDirs) {
    const fullPath = path.join(cwd, dir);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) return dir;
    } catch {
      // continue
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
    if (framework) return framework.buildCommand;
    return `npx -y serve ${buildDir}`;
  }
  const scripts = pkg?.scripts as Record<string, string> | undefined;
  if (scripts?.dev) return getDevCommand(pm, 'dev');
  if (scripts?.start) return getDevCommand(pm, 'start');
  throw new Error('Could not auto-detect server command. Please specify command explicitly.');
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface ManagedServer {
  name: string;
  /** null means we are reusing an externally-managed server (not ours to kill). */
  process: ChildProcess | null;
  url: string;
  cwd: string;
  startedAt: number;
}

type ServerState = 'idle' | 'starting' | 'reusing' | 'running' | 'stopping' | 'killed';

function log(name: string, state: ServerState, msg: string): void {
  console.log(`[webServer:${name}:${state}] ${msg}`);
}

/**
 * Normalises a `WebServerInput` (object or array) into a guaranteed-array form
 * with each entry given a stable name (synthesised from index when omitted).
 */
export function normalizeWebServerInput(config: WebServerInput): WebServerConfig[] {
  const list = Array.isArray(config) ? config : [config];
  return list.map((entry, i) => ({
    ...entry,
    name: entry.name ?? `server-${i + 1}`,
  }));
}

/**
 * Singleton manager for the lifecycle of one or more web server processes.
 *
 * Sequential start, reverse-order shutdown, per-entry readiness polling, and
 * per-entry marker entries in `.intellitester/servers.json` for cross-run reuse.
 */
class WebServerManager {
  private static instance: WebServerManager;

  /** Servers indexed by name. Iteration order matches insertion order; shutdown walks it in reverse. */
  private servers: Map<string, ManagedServer> = new Map();
  private stopping = false;

  private constructor() {}

  static getInstance(): WebServerManager {
    if (!WebServerManager.instance) {
      WebServerManager.instance = new WebServerManager();
    }
    return WebServerManager.instance;
  }

  isRunning(): boolean {
    if (this.servers.size === 0) return false;
    for (const s of this.servers.values()) {
      if (!s.process || s.process.killed) continue;
      return true;
    }
    // Any externally-reused entry also counts as "running" from the caller's POV.
    return [...this.servers.values()].some((s) => s.process === null);
  }

  /** URL of the LAST started server -- the convention is "frontend last" so this matches the test baseUrl. */
  getUrl(): string | null {
    let last: ManagedServer | null = null;
    for (const s of this.servers.values()) last = s;
    return last?.url ?? null;
  }

  getServer(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  /**
   * Start one or more web servers. Accepts either a single config (existing
   * single-process behaviour) or an array (multi-process). Array entries are
   * started sequentially; if any entry fails readiness, previously-started
   * entries are torn down in reverse before the error is rethrown.
   */
  async start(config: WebServerInput): Promise<ChildProcess | null> {
    // Wait for any in-progress stop.
    while (this.stopping) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const entries = normalizeWebServerInput(config);
    let lastSpawned: ChildProcess | null = null;
    const startedThisCall: string[] = [];

    for (const entry of entries) {
      try {
        const proc = await this.startOne(entry);
        if (proc) lastSpawned = proc;
        startedThisCall.push(entry.name!);
      } catch (e) {
        log(entry.name!, 'idle', `failed to start: ${e instanceof Error ? e.message : String(e)}`);
        // Tear down anything we successfully started in this call, in reverse.
        for (const name of [...startedThisCall].reverse()) {
          await this.stopOne(name).catch(() => undefined);
        }
        throw e;
      }
    }
    return lastSpawned;
  }

  private async startOne(entry: WebServerConfig): Promise<ChildProcess | null> {
    const name = entry.name!;
    const url = entry.url;
    const cwd = entry.workdir ?? entry.cwd ?? process.cwd();
    const reuseExistingServer = entry.reuseExistingServer ?? true;
    const timeout = entry.timeout ?? 30000;
    const idleTimeout = entry.idleTimeout ?? 20000;

    // If we already own this server in-process at the same URL, reuse it.
    const existing = this.servers.get(name);
    if (existing && existing.url === url && (existing.process === null || !existing.process.killed)) {
      if (await isServerRunning(url)) {
        if (reuseExistingServer) {
          log(name, 'reusing', `in-process server at ${url}`);
          return existing.process;
        }
        await this.stopOne(name);
      } else {
        await this.stopOne(name);
      }
    }

    // Cross-run reuse via marker file.
    const markers = await readMarkers(cwd);
    const marker = markers.entries.find((m) => m.url === url || m.name === name);
    if (marker && reuseExistingServer) {
      if (isPidAlive(marker.pid) && (await isServerRunning(url))) {
        log(name, 'reusing', `previously-started server at ${url} (pid ${marker.pid})`);
        this.servers.set(name, { name, process: null, url, cwd, startedAt: Date.now() });
        return null;
      }
      // Marker is stale -- clean up the orphan.
      log(name, 'stopping', `stale marker for ${url}, cleaning up`);
      if (isPidAlive(marker.pid)) {
        try {
          process.kill(marker.pid, 'SIGTERM');
          await new Promise((r) => setTimeout(r, 1000));
          if (isPidAlive(marker.pid)) {
            process.kill(marker.pid, 'SIGKILL');
            await new Promise((r) => setTimeout(r, 500));
          }
        } catch {
          // process might already be dead
        }
        if (isPidAlive(marker.pid)) {
          throw new Error(
            `[webServer:${name}] orphan server pid ${marker.pid} still alive after SIGKILL; ` +
              `port ${new URL(url).port || ''} likely blocked. Kill it manually and retry.`,
          );
        }
      }
      await removeMarker(cwd, { name, url });
    }

    // Externally-running server we don't own?
    if (await isServerRunning(url)) {
      if (!reuseExistingServer) {
        throw new Error(`Port ${new URL(url).port} is already in use by another process`);
      }
      log(name, 'reusing', `external server at ${url}`);
      this.servers.set(name, { name, process: null, url, cwd, startedAt: Date.now() });
      return null;
    }

    // Determine the spawn command.
    let command: string;
    if (entry.command) {
      command = entry.command;
    } else if (entry.static) {
      const port = entry.port ?? new URL(url).port ?? '3000';
      command = `npx -y serve ${entry.static} -l ${port}`;
    } else if (entry.auto) {
      command = await detectServerCommand(cwd);
    } else {
      throw new Error('WebServerConfig requires command, auto: true, or static directory');
    }

    log(name, 'starting', `${command} (cwd: ${cwd})`);
    const child = spawn(command, {
      shell: true,
      stdio: 'pipe',
      cwd,
      detached: true,
    });
    this.servers.set(name, { name, process: child, url, cwd, startedAt: Date.now() });

    let stderrOutput = '';
    let lastOutputTime = Date.now();
    const prefix = `[server:${name}]`;
    child.stdout?.on('data', (data) => {
      lastOutputTime = Date.now();
      process.stdout.write(`${prefix} ${data}`);
    });
    child.stderr?.on('data', (data) => {
      lastOutputTime = Date.now();
      stderrOutput += data.toString();
      process.stderr.write(`${prefix} ${data}`);
    });

    // Clean up the marker entry if the subprocess dies on its own.
    child.on('exit', () => {
      const current = this.servers.get(name);
      if (current?.process === child) {
        removeMarkerSync(cwd, { name, url });
      }
    });

    // Wait for the server to be ready.
    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      const startTime = Date.now();
      const cleanup = () => {
        resolved = true;
        clearInterval(pollInterval);
      };

      child.on('close', (code) => {
        if (!resolved && code !== 0 && code !== null) {
          cleanup();
          this.servers.delete(name);
          reject(new Error(`Server "${name}" exited with code ${code}\n${stderrOutput}`));
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          cleanup();
          this.servers.delete(name);
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
          reject(new Error(`Server "${name}" at ${url} not ready after ${timeout}ms`));
          return;
        }
        if (Date.now() - lastOutputTime > idleTimeout) {
          cleanup();
          child.kill('SIGTERM');
          this.servers.delete(name);
          const tail = stderrOutput.slice(-500);
          reject(new Error(`Server "${name}" stalled - no output for ${idleTimeout}ms. Last output:\n${tail}`));
          return;
        }
      }, 500);
    });

    log(name, 'running', `ready at ${url}`);

    if (child.pid) {
      await upsertMarker(cwd, {
        name,
        pid: child.pid,
        port: parseInt(new URL(url).port || '80'),
        url,
        cwd,
        command,
        startTime: new Date().toISOString(),
      });
    }

    return child;
  }

  /**
   * Stop all managed servers in reverse insertion order. Frontend goes down
   * before API so the frontend doesn't spam errors during its own teardown.
   */
  async stop(): Promise<void> {
    if (this.servers.size === 0) return;
    this.stopping = true;
    try {
      const names = [...this.servers.keys()].reverse();
      for (const name of names) {
        await this.stopOne(name);
      }
    } finally {
      this.stopping = false;
    }
  }

  private async stopOne(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) return;
    const { process: child, cwd, url } = server;

    // Externally-reused server: just drop our handle, don't signal anything.
    if (!child) {
      this.servers.delete(name);
      return;
    }

    if (child.killed) {
      this.servers.delete(name);
      return;
    }

    log(name, 'stopping', `signalling pid ${child.pid ?? '?'}`);

    const exitPromise = new Promise<void>((resolve) => {
      const onExit = () => {
        child.removeListener('close', onExit);
        child.removeListener('exit', onExit);
        resolve();
      };
      child.on('close', onExit);
      child.on('exit', onExit);
      if (child.killed || child.exitCode !== null) resolve();
    });

    const pid = child.pid;
    try {
      if (pid) {
        globalThis.process.kill(-pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      child.kill('SIGTERM');
    }

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          log(name, 'stopping', 'did not stop gracefully, sending SIGKILL');
          try {
            if (pid) globalThis.process.kill(-pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
        resolve();
      }, 5000);
    });

    await Promise.race([exitPromise, timeoutPromise]);
    // Brief grace period so the OS releases the port.
    await new Promise((r) => setTimeout(r, 200));

    await removeMarker(cwd, { name, url });
    this.servers.delete(name);
    log(name, 'killed', 'stopped');
  }

  /**
   * Synchronous kill for signal handlers. Walks in reverse insertion order and
   * sends SIGTERM (followed by SIGKILL after 1s) to each owned subprocess.
   * State is cleared only AFTER signals are sent so a follow-up stop() can see
   * the process if it survives.
   */
  kill(): void {
    if (this.servers.size === 0) return;
    const names = [...this.servers.keys()].reverse();
    for (const name of names) {
      const server = this.servers.get(name);
      if (!server) continue;
      const child = server.process;
      if (!child) {
        // External reuse -- nothing to signal.
        this.servers.delete(name);
        continue;
      }
      if (child.killed) {
        this.servers.delete(name);
        continue;
      }
      log(name, 'stopping', 'sync kill');
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        // Force SIGKILL after a short delay, then clear state.
        setTimeout(() => {
          try {
            if (pid) process.kill(-pid, 'SIGKILL');
          } catch {
            // already dead
          }
          removeMarkerSync(server.cwd, { name, url: server.url });
          this.servers.delete(name);
        }, 1000);
      } else {
        child.kill('SIGTERM');
        removeMarkerSync(server.cwd, { name, url: server.url });
        this.servers.delete(name);
      }
    }
  }
}

export const webServerManager = WebServerManager.getInstance();
export { isServerRunning };
