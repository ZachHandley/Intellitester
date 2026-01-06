import crypto from 'node:crypto';

/**
 * Generates a random test email address.
 *
 * The format is: test-{randomHex}@test.local
 *
 * @param domain - Optional custom domain. Defaults to "test.local"
 * @returns A random email address suitable for testing.
 *
 * Examples:
 *   generateRandomEmail()              -> "test-a1b2c3@test.local"
 *   generateRandomEmail("example.com") -> "test-a1b2c3@example.com"
 */
export function generateRandomEmail(domain?: string): string {
  // Generate a short random hex string (6 characters)
  const randomPart = crypto.randomBytes(3).toString('hex');
  const emailDomain = domain?.trim() || 'test.local';

  return `test-${randomPart}@${emailDomain}`;
}
