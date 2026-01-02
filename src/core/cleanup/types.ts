import type { TrackedResource } from '../../integration/index.js';

export interface CleanupHandler {
  (resource: TrackedResource): Promise<void>;
}

export interface CleanupUntrackedOptions {
  testStartTime: string;    // ISO timestamp when test started
  userId?: string;          // Test user ID to match
  sessionId?: string;       // Session ID for logging
}

export interface CleanupUntrackedResult {
  success: boolean;
  scanned: number;          // Number of tables/collections scanned
  deleted: string[];        // Resource IDs deleted
  failed: string[];         // Resource IDs that failed to delete
}

export interface CleanupProvider {
  name: string;
  configure(config: Record<string, unknown>): Promise<void>;
  methods: Record<string, CleanupHandler>;
  // Scan and clean up resources created during test that weren't explicitly tracked
  cleanupUntracked?(options: CleanupUntrackedOptions): Promise<CleanupUntrackedResult>;
}

export interface CleanupDiscoverConfig {
  enabled?: boolean;
  paths?: string[];
  pattern?: string;
}

export interface CleanupConfig {
  provider?: string;
  parallel?: boolean;               // default: false
  retries?: number;                 // default: 3
  types?: Record<string, string>;   // type -> 'provider.method'
  handlers?: string[];              // explicit paths
  discover?: CleanupDiscoverConfig;
  scanUntracked?: boolean;          // Enable scanning for untracked resources
  [providerName: string]: unknown;  // provider-specific configs
}

export interface CleanupResult {
  success: boolean;
  deleted: string[];
  failed: string[];
}

export interface ExecutorOptions {
  parallel?: boolean;
  retries?: number;
  sessionId?: string;
  testStartTime?: string;   // When the test started (ISO timestamp)
  userId?: string;          // Test user ID for matching
  providerConfig?: {
    provider: string;
    [key: string]: unknown;
  };
  cwd?: string;
}
