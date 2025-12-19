/**
 * Configuration options for the AutoTester Vite plugin
 */
export interface AutotesterOptions {
  /**
   * Directory where test files are stored
   * @default './tests'
   */
  testsDir?: string;

  /**
   * Glob patterns for components to scan and generate test stubs for
   * @example ['src/components/**\/*.tsx', 'src/pages/**\/*.tsx']
   */
  include?: string[];

  /**
   * Whether to run tests after build completes
   * @default false
   */
  runOnBuild?: boolean;

  /**
   * Whether to watch test files and re-run tests in dev mode
   * @default true
   */
  watchTests?: boolean;

  /**
   * Path to autotester.config.yaml
   * @default 'autotester.config.yaml'
   */
  configPath?: string;

  /**
   * Base URL for the dev server endpoint
   * @default '/__autotester'
   */
  endpoint?: string;
}

/**
 * Component information extracted from scanning
 */
export interface ComponentInfo {
  name: string;
  path: string;
  relativePath: string;
}
