/**
 * Resource tracking helpers for E2E tests.
 */
import { randomUUID } from 'crypto';
import type { TrackedResource } from '../../../src/integration/index.js';

export interface TestTrackingContext {
  /** Tracking server instance (if using HTTP mode) */
  server: { port: number; stop: () => Promise<void> } | null;
  /** File tracking context (if using file mode) */
  fileTracking: { trackFile: string; stop: () => Promise<void> } | null;
  /** Session ID for this test */
  sessionId: string;
  /** Clean up all tracking resources */
  cleanup: () => Promise<void>;
}

export interface TestTrackingOptions {
  /** Tracking mode: http, file, or both */
  mode: 'http' | 'file' | 'both';
  /** Custom track directory (defaults to .intellitester/track) */
  trackDir?: string;
}

/**
 * Set up resource tracking for a test.
 * Sets environment variables and returns cleanup function.
 */
export async function setupTestTracking(
  options: TestTrackingOptions = { mode: 'file' }
): Promise<TestTrackingContext> {
  const sessionId = randomUUID();
  let server: { port: number; stop: () => Promise<void> } | null = null;
  let fileTracking: { trackFile: string; stop: () => Promise<void> } | null = null;

  // Dynamic import to avoid circular deps
  const { startTrackingServer, initFileTracking } = await import('../../../src/tracking/index.js');

  if (options.mode === 'http' || options.mode === 'both') {
    server = await startTrackingServer({ port: 0 }); // Port 0 = random available port
    process.env.INTELLITESTER_TRACK_URL = `http://localhost:${server.port}`;
  }

  if (options.mode === 'file' || options.mode === 'both') {
    fileTracking = await initFileTracking({
      sessionId,
      trackDir: options.trackDir,
    });
    process.env.INTELLITESTER_TRACK_FILE = fileTracking.trackFile;
  }

  process.env.INTELLITESTER_SESSION_ID = sessionId;

  return {
    server,
    fileTracking,
    sessionId,
    cleanup: async () => {
      // Clear environment variables
      delete process.env.INTELLITESTER_SESSION_ID;
      delete process.env.INTELLITESTER_TRACK_URL;
      delete process.env.INTELLITESTER_TRACK_FILE;

      // Stop tracking services
      if (server) {
        await server.stop();
      }
      if (fileTracking) {
        await fileTracking.stop();
      }
    },
  };
}

/**
 * Create a mock tracked resource for testing.
 */
export function createMockResource(
  type: string,
  overrides: Partial<TrackedResource> = {}
): TrackedResource {
  return {
    type,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create multiple mock resources of different types.
 */
export function createMockResources(
  specs: Array<{ type: string; count?: number; overrides?: Partial<TrackedResource> }>
): TrackedResource[] {
  const resources: TrackedResource[] = [];
  for (const spec of specs) {
    const count = spec.count ?? 1;
    for (let i = 0; i < count; i++) {
      resources.push(createMockResource(spec.type, spec.overrides));
    }
  }
  return resources;
}
