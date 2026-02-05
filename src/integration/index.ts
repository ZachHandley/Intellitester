/**
 * IntelliTester Integration - Track server-side resources for test cleanup
 *
 * Usage in app SSR code:
 *   import { track } from 'intellitester/integration';
 *
 *   // Track a database row
 *   await track({ type: 'row', id: row.$id, database: 'main', table: 'users' });
 *
 *   // Track a team
 *   await track({ type: 'team', id: team.$id });
 *
 *   // Track anything - it's just metadata for your cleanup handler
 *   await track({ type: 'stripe_customer', id: customerId });
 */

/**
 * Track a resource for cleanup after tests.
 * Provider-agnostic - just tracks type, id, and metadata.
 * Cleanup logic is handled by the configured provider.
 */
export interface TrackedResource {
  type: string;           // 'row', 'team', 'file', 'user', or any custom type
  id: string;             // Resource ID
  [key: string]: unknown; // Any additional metadata needed for cleanup
}

/**
 * Track a resource created in server-side code.
 * No-op if not in test mode.
 *
 * @example
 * // Track a database row
 * await track({ type: 'row', id: row.$id, database: 'main', table: 'users' });
 *
 * // Track a team
 * await track({ type: 'team', id: team.$id });
 *
 * // Track anything - it's just metadata for your cleanup handler
 * await track({ type: 'stripe_customer', id: customerId });
 */
type TrackingMode = 'none' | 'http' | 'file' | 'both';

let cachedTracking: {
  sessionId?: string;
  trackUrl?: string;
  trackFile?: string;
  mode: TrackingMode;
} | null = null;

/**
 * Get environment variable from multiple sources (Node.js, Cloudflare Workers, etc.)
 */
const getEnv = (name: string): string | undefined => {
  // Try Node.js process.env first
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }
  // Try globalThis (some runtimes expose env this way)
  const g = globalThis as Record<string, unknown>;
  if (g.env && typeof g.env === 'object') {
    return (g.env as Record<string, string>)[name];
  }
  // Try Deno-style
  if (typeof Deno !== 'undefined' && Deno.env) {
    try {
      return Deno.env.get(name);
    } catch {
      // Permission denied
    }
  }
  return undefined;
};

// Declare Deno for TypeScript
declare const Deno: { env: { get: (name: string) => string | undefined } } | undefined;

const resolveTracking = (): {
  sessionId?: string;
  trackUrl?: string;
  trackFile?: string;
  mode: TrackingMode;
} => {
  const sessionId = getEnv('INTELLITESTER_SESSION_ID');
  const trackUrl = getEnv('INTELLITESTER_TRACK_URL');
  const trackFile = getEnv('INTELLITESTER_TRACK_FILE');

  if (
    cachedTracking &&
    cachedTracking.sessionId === sessionId &&
    cachedTracking.trackUrl === trackUrl &&
    cachedTracking.trackFile === trackFile
  ) {
    return cachedTracking;
  }

  let mode: TrackingMode = 'none';
  if (trackUrl && trackFile) {
    mode = 'both';
  } else if (trackUrl) {
    mode = 'http';
  } else if (trackFile) {
    mode = 'file';
  }

  cachedTracking = { sessionId, trackUrl, trackFile, mode };
  return cachedTracking;
};

export async function track(resource: TrackedResource): Promise<void> {
  // Only run on server (SSR), not in browser
  if (typeof window !== 'undefined') return;

  const { sessionId, trackUrl, trackFile, mode } = resolveTracking();

  if (!sessionId || mode === 'none') return;

  if (trackUrl && (mode === 'http' || mode === 'both')) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);
      await fetch(`${trackUrl}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...resource }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch {
      // Silent fail - don't break app
    }
  }

  // File tracking only works in Node.js environments with fs access
  if (trackFile && (mode === 'file' || mode === 'both')) {
    // Check if we're in a Node.js environment with fs access
    if (typeof process !== 'undefined' && process.versions?.node) {
      try {
        const { appendFile } = await import('node:fs/promises');
        const { existsSync } = await import('node:fs');
        if (!existsSync(trackFile)) return;
        const payload = {
          sessionId,
          createdAt: new Date().toISOString(),
          ...resource,
        };
        await appendFile(trackFile, `${JSON.stringify(payload)}\n`, 'utf8');
      } catch {
        // Silent fail - don't break app
      }
    }
    // In non-Node.js environments (like Cloudflare Workers), file tracking is skipped
    // but HTTP tracking above should still work
  }
}
