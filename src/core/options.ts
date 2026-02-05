/**
 * Shared option types for CLI and executors.
 * Single source of truth for runtime configuration options.
 */
import type { BrowserName } from '../executors/web/playwrightExecutor.js';

/** Viewport size presets (Tailwind breakpoints) or custom 'WxH' format */
export type ViewportSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;

/**
 * Unified runtime options for all executors (workflow, pipeline, test).
 * This is the canonical type used by executor functions.
 */
export interface ExecutorOptions {
  /** Run browser in headed mode (visible to user) */
  headed?: boolean;
  /** Browser engine to use */
  browser?: BrowserName;
  /** Enable interactive mode with AI assistance */
  interactive?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Session ID for tracking resources */
  sessionId?: string;
  /** Directory for tracking files */
  trackDir?: string;
  /** Viewport sizes to test at */
  testSizes?: ViewportSize[];
  /** Skip tracking setup (reuse from parent context) */
  skipTrackingSetup?: boolean;
  /** Skip web server start (reuse from parent context) */
  skipWebServerStart?: boolean;
}

/**
 * CLI-specific options as parsed by Commander.
 * Uses 'visible' instead of 'headed' to match CLI convention (--visible flag).
 */
export interface CLIRunOptions {
  /** Run browser in visible (headed) mode */
  visible?: boolean;
  /** Browser engine to use */
  browser?: BrowserName;
  /** Enable interactive mode */
  interactive?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Session ID for resource tracking */
  sessionId?: string;
  /** Directory for tracking files */
  trackDir?: string;
  /** Viewport sizes to test (string array from CLI) */
  testSizes?: string[];
  /** Skip tracking setup */
  skipTrackingSetup?: boolean;
  /** Skip web server start */
  skipWebServerStart?: boolean;
}

/**
 * Maps CLI options to executor options.
 * Handles the 'visible' -> 'headed' naming translation.
 */
export function mapCLIToExecutorOptions(cli: CLIRunOptions): ExecutorOptions {
  return {
    headed: cli.visible,
    browser: cli.browser,
    interactive: cli.interactive,
    debug: cli.debug,
    sessionId: cli.sessionId,
    trackDir: cli.trackDir,
    testSizes: cli.testSizes as ViewportSize[] | undefined,
    skipTrackingSetup: cli.skipTrackingSetup,
    skipWebServerStart: cli.skipWebServerStart,
  };
}
