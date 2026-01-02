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
export async function track(resource: TrackedResource): Promise<void> {
  // Only run on server (SSR), not in browser
  if (typeof window !== 'undefined') return;
  if (typeof process === 'undefined') return;

  const sessionId = process.env.INTELLITESTER_SESSION_ID;
  const trackUrl = process.env.INTELLITESTER_TRACK_URL;

  if (!sessionId || !trackUrl) return;

  try {
    await fetch(`${trackUrl}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...resource }),
    });
  } catch {
    // Silent fail - don't break app
  }
}
