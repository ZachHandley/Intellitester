/**
 * Global setup for integration tests.
 * Runs once before all integration tests.
 */
import { mkdirSync } from 'fs';
import path from 'path';

export default async function setup() {
  // Ensure required directories exist
  const dirs = [
    '.intellitester/test-dbs',
    '.intellitester/track',
    'artifacts/screenshots',
  ];

  for (const dir of dirs) {
    mkdirSync(path.join(process.cwd(), dir), { recursive: true });
  }

  // Set test environment
  process.env.NODE_ENV = 'test';

  // Disable color output in CI for cleaner logs
  if (process.env.CI) {
    process.env.NO_COLOR = '1';
  }

  console.log('Integration test setup complete');
}
