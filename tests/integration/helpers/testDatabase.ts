/**
 * Test database management utilities.
 * Creates isolated SQLite databases for each test/suite.
 */
import { randomUUID } from 'crypto';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import path from 'path';

const TEST_DB_DIR = path.join(process.cwd(), '.intellitester/test-dbs');

export interface TestDatabase {
  /** The better-sqlite3 database instance */
  db: any;
  /** Path to the database file */
  path: string;
  /** Close the database connection */
  close: () => void;
  /** Close and delete the database file */
  cleanup: () => void;
}

export interface TestDatabaseOptions {
  /** Additional SQL schema to execute */
  schema?: string;
  /** Seed function to populate initial data */
  seed?: (db: any) => void;
}

/**
 * Create an isolated test database with optional schema and seed data.
 * Throws if better-sqlite3 is not available.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  // Ensure test DB directory exists
  mkdirSync(TEST_DB_DIR, { recursive: true });

  const dbPath = path.join(TEST_DB_DIR, `test-${randomUUID()}.db`);

  // Dynamic import since better-sqlite3 is an optional dependency
  let DatabaseModule: any;
  try {
    DatabaseModule = await import('better-sqlite3');
  } catch (error) {
    throw new Error(
      'better-sqlite3 is not available. Install it with: pnpm install better-sqlite3\n' +
      'Note: This requires native compilation. On some systems you may need build tools.'
    );
  }

  const Database = DatabaseModule.default || DatabaseModule;
  let db: any;

  try {
    db = new Database(dbPath);
  } catch (error) {
    throw new Error(
      `Failed to create SQLite database: ${error instanceof Error ? error.message : String(error)}\n` +
      'This may be due to missing native bindings. Try: pnpm rebuild better-sqlite3'
    );
  }

  // Apply default schema for common test tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES teams(id),
      user_id TEXT REFERENCES users(id),
      role TEXT DEFAULT 'member',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Apply custom schema if provided
  if (options.schema) {
    db.exec(options.schema);
  }

  // Run seed function if provided
  if (options.seed) {
    options.seed(db);
  }

  return {
    db,
    path: dbPath,
    close: () => {
      try {
        db.close();
      } catch {
        // Already closed
      }
    },
    cleanup: () => {
      try {
        db.close();
      } catch {
        // Already closed
      }
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    },
  };
}

/**
 * Clean up all test databases (useful in globalTeardown).
 */
export async function cleanupAllTestDatabases(): Promise<void> {
  if (!existsSync(TEST_DB_DIR)) return;

  try {
    const files = await readdir(TEST_DB_DIR);
    for (const file of files) {
      if (file.endsWith('.db') || file.endsWith('.db-wal') || file.endsWith('.db-shm')) {
        await unlink(path.join(TEST_DB_DIR, file)).catch(() => {});
      }
    }
  } catch {
    // Directory doesn't exist or other error
  }
}

/**
 * Insert a test user into the database.
 */
export function insertTestUser(
  db: any,
  data: { id?: string; email?: string; name?: string }
): string {
  const id = data.id || randomUUID();
  const email = data.email || `test-${id}@example.com`;
  const name = data.name || `Test User ${id.slice(0, 8)}`;

  db.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id, email, name);
  return id;
}

/**
 * Insert a test resource into the database.
 */
export function insertTestResource(
  db: any,
  data: { id?: string; type: string; data?: Record<string, unknown> }
): string {
  const id = data.id || randomUUID();
  const dataJson = data.data ? JSON.stringify(data.data) : null;

  db.prepare('INSERT INTO resources (id, type, data) VALUES (?, ?, ?)').run(id, data.type, dataJson);
  return id;
}
