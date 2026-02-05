/**
 * Test server management utilities.
 */
import { createServer, type Server } from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

export interface TestServerContext {
  /** The HTTP server instance */
  server: Server;
  /** Port the server is listening on */
  port: number;
  /** Full URL to the server */
  url: string;
  /** Stop the server */
  stop: () => Promise<void>;
}

export interface TestServerOptions {
  /** Port to listen on (0 = random available port) */
  port?: number;
  /** Static directory to serve */
  staticDir?: string;
  /** Custom request handler */
  handler?: (req: any, res: any) => void;
}

/**
 * Start a simple test HTTP server.
 * Can serve static files or use a custom handler.
 */
export async function startTestServer(
  options: TestServerOptions = {}
): Promise<TestServerContext> {
  const { port = 0, staticDir, handler } = options;

  const requestHandler = handler ?? createStaticHandler(staticDir);

  const server = createServer(requestHandler);

  return new Promise((resolve, reject) => {
    server.on('error', reject);

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }

      const actualPort = address.port;
      const url = `http://127.0.0.1:${actualPort}`;

      resolve({
        server,
        port: actualPort,
        url,
        stop: () => new Promise<void>((res) => {
          server.close(() => res());
        }),
      });
    });
  });
}

/**
 * Create a static file handler for the test server.
 */
function createStaticHandler(staticDir?: string) {
  const baseDir = staticDir || process.cwd();

  return (req: any, res: any) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url;
    const filePath = path.join(baseDir, urlPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    try {
      const content = readFileSync(filePath);
      const contentType = getContentType(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  };
}

/**
 * Get content type based on file extension.
 */
function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  return types[ext] || 'application/octet-stream';
}

/**
 * Wait for a server to be ready at the given URL.
 */
export async function waitForServer(
  url: string,
  options: { timeout?: number; interval?: number } = {}
): Promise<boolean> {
  const { timeout = 10000, interval = 200 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      // Use AbortController to enforce per-request timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.min(interval * 2, 1000));

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // Server not ready yet or request timed out
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  return false;
}

/**
 * Create a test server that tracks requests for assertions.
 */
export async function startTrackingTestServer(
  options: Omit<TestServerOptions, 'handler'> = {}
): Promise<TestServerContext & { requests: Array<{ method: string; url: string; body?: string }> }> {
  const requests: Array<{ method: string; url: string; body?: string }> = [];

  const handler = (req: any, res: any) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: body || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  };

  const ctx = await startTestServer({ ...options, handler });
  return { ...ctx, requests };
}
