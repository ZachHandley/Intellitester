/**
 * Global teardown for integration tests.
 * Runs once after all integration tests complete.
 */
import { rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

export default async function teardown() {
  const cwd = process.cwd();

  // Stop any lingering web servers
  try {
    const { webServerManager } = await import('../../src/executors/web/webServerManager.js');
    await webServerManager.stop();
  } catch {
    // Module may not be loaded or server not running
  }

  // Clean up test databases
  try {
    const testDbDir = path.join(cwd, '.intellitester/test-dbs');
    if (existsSync(testDbDir)) {
      await rm(testDbDir, { recursive: true, force: true });
    }
  } catch {
    // Directory may not exist
  }

  // Clean up test tracking files
  try {
    const trackDir = path.join(cwd, '.intellitester/track');
    if (existsSync(trackDir)) {
      const { readdir, unlink } = await import('fs/promises');
      const files = await readdir(trackDir);
      for (const file of files) {
        if (file.startsWith('TEST_SESSION_')) {
          await unlink(path.join(trackDir, file)).catch(() => {});
        }
      }
    }
  } catch {
    // Directory may not exist
  }

  // Kill any orphaned browser processes (Chromium only)
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Only attempt cleanup on Unix-like systems
    if (process.platform !== 'win32') {
      // Find and kill any chromium processes started by this test run
      // that might have been orphaned (conservative - only kills headless processes)
      await execAsync('pkill -f "chromium.*--headless" || true').catch(() => {});
    }
  } catch {
    // Process cleanup failed, not critical
  }

  console.log('Integration test teardown complete');
}
