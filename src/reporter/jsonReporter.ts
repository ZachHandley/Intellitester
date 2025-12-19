import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReporterOptions, TestReport } from './types';

export async function generateJsonReport(
  report: TestReport,
  options: ReporterOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  const json = JSON.stringify(report, null, 2);
  await fs.writeFile(options.outputPath, json, 'utf8');
}
