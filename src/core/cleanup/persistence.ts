import fs from 'node:fs/promises';
import path from 'node:path';
import type { TrackedResource } from '../../integration/index.js';

// Types
export interface FailedCleanup {
  sessionId: string;
  timestamp: string;
  resources: TrackedResource[];
  // Generic provider config (no secrets!)
  providerConfig: {
    provider: string;  // 'appwrite' | 'postgres' | 'mysql' | 'sqlite'
    [key: string]: unknown;  // endpoint, projectId, database, etc. - NO passwords/keys
  };
  errors: string[];
}

const CLEANUP_DIR = '.intellitester/cleanup/failed';

// Save failed cleanup to disk
export async function saveFailedCleanup(
  cleanup: FailedCleanup,
  cwd: string = process.cwd()
): Promise<void> {
  const dir = path.join(cwd, CLEANUP_DIR);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${cleanup.sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(cleanup, null, 2), 'utf8');
  console.log(`Saved failed cleanup to ${filePath}`);
}

// Load all failed cleanups from disk
export async function loadFailedCleanups(
  cwd: string = process.cwd()
): Promise<FailedCleanup[]> {
  const dir = path.join(cwd, CLEANUP_DIR);
  try {
    const files = await fs.readdir(dir);
    const cleanups: FailedCleanup[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(dir, file), 'utf8');
        cleanups.push(JSON.parse(content));
      }
    }
    return cleanups;
  } catch (error) {
    // Directory doesn't exist = no failed cleanups
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Remove a failed cleanup file after successful retry
export async function removeFailedCleanup(
  sessionId: string,
  cwd: string = process.cwd()
): Promise<void> {
  const filePath = path.join(cwd, CLEANUP_DIR, `${sessionId}.json`);
  try {
    await fs.unlink(filePath);
    console.log(`Removed failed cleanup file: ${sessionId}.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
