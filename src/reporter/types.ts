import type { WebRunResult } from '../executors/web';

export interface TestReport {
  testName: string;
  platform: string;
  timestamp: string;
  duration?: number;
  result: WebRunResult;
}

export interface ReporterOptions {
  outputPath: string;
  embedScreenshots?: boolean;
}
