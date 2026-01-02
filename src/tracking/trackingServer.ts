import { createServer, IncomingMessage, ServerResponse } from 'http';

export interface TrackingServerOptions {
  port?: number; // 0 = random available port
}

/**
 * Generic tracked resource - stores whatever JSON is posted.
 * Provider-agnostic format.
 */
export interface TrackedResource {
  type: string;
  id: string;
  createdAt: string;
  [key: string]: unknown; // Any additional metadata
}

/**
 * Track request - sessionId plus the resource metadata
 */
export interface TrackRequest {
  sessionId: string;
  type: string;
  id: string;
  [key: string]: unknown; // Any additional metadata
}

export class TrackingServer {
  private server: ReturnType<typeof createServer> | null = null;
  private resources: Map<string, TrackedResource[]> = new Map();
  public port: number = 0;

  async start(options: TrackingServerOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create HTTP server
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        reject(error);
      });

      // Listen on port (0 = random)
      const port = options.port ?? 0;
      this.server.listen(port, () => {
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve();
        } else {
          reject(new Error('Failed to get server port'));
        }
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Enable CORS for cross-origin requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/track') {
      this.handleTrackRequest(req, res);
    } else if (req.method === 'GET' && url.pathname.startsWith('/resources/')) {
      this.handleGetResources(url, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handleTrackRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const trackRequest: TrackRequest = JSON.parse(body);

        // Validate required fields
        if (!trackRequest.sessionId || !trackRequest.type || !trackRequest.id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields (sessionId, type, id)' }));
          return;
        }

        // Extract sessionId and create tracked resource with all other fields
        const { sessionId, ...resourceData } = trackRequest;

        // Create tracked resource - just store whatever JSON was posted
        const resource: TrackedResource = {
          ...resourceData,
          type: trackRequest.type,
          id: trackRequest.id,
          createdAt: new Date().toISOString(),
        };

        // Store resource by sessionId
        const sessionResources = this.resources.get(sessionId) || [];
        sessionResources.push(resource);
        this.resources.set(sessionId, sessionResources);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });

    req.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
  }

  private handleGetResources(url: URL, res: ServerResponse): void {
    const sessionId = url.pathname.split('/').pop();

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing sessionId' }));
      return;
    }

    const resources = this.resources.get(sessionId) || [];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resources }));
  }

  getResources(sessionId: string): TrackedResource[] {
    return this.resources.get(sessionId) ?? [];
  }

  clearSession(sessionId: string): void {
    this.resources.delete(sessionId);
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }
}

export async function startTrackingServer(
  options?: TrackingServerOptions
): Promise<TrackingServer> {
  const server = new TrackingServer();
  await server.start(options);
  return server;
}
