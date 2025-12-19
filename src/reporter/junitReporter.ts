import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReporterOptions, TestReport } from './types';
import type { StepResult } from '../executors/web';

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatActionName(step: StepResult, index: number): string {
  const { action } = step;
  switch (action.type) {
    case 'navigate':
      return `step-${index + 1}: navigate to ${action.value}`;
    case 'tap':
      return `step-${index + 1}: tap element`;
    case 'input':
      return `step-${index + 1}: input text`;
    case 'assert':
      return `step-${index + 1}: assert element`;
    case 'wait':
      return `step-${index + 1}: wait`;
    case 'scroll':
      return `step-${index + 1}: scroll ${action.direction ?? 'down'}`;
    case 'screenshot':
      return `step-${index + 1}: screenshot`;
  }
}

function generateTestCaseXml(step: StepResult, index: number, testName: string): string {
  const caseName = escapeXml(formatActionName(step, index));
  const className = escapeXml(testName);

  if (step.status === 'passed') {
    return `    <testcase name="${caseName}" classname="${className}" />`;
  }

  const errorMessage = escapeXml(step.error ?? 'Test step failed');
  return `    <testcase name="${caseName}" classname="${className}">
      <failure message="${errorMessage}"><![CDATA[${step.error ?? 'Test step failed'}]]></failure>
    </testcase>`;
}

function generateJunitXml(report: TestReport): string {
  const totalTests = report.result.steps.length;
  const failures = report.result.steps.filter((s) => s.status === 'failed').length;
  const timestamp = new Date(report.timestamp).toISOString();
  const duration = report.duration ? (report.duration / 1000).toFixed(3) : '0.000';

  const testCases = report.result.steps
    .map((step, index) => generateTestCaseXml(step, index, report.testName))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${escapeXml(report.testName)}" tests="${totalTests}" failures="${failures}" errors="0" skipped="0" timestamp="${timestamp}" time="${duration}">
${testCases}
  </testsuite>
</testsuites>`;
}

export async function generateJunitReport(
  report: TestReport,
  options: ReporterOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  const xml = generateJunitXml(report);
  await fs.writeFile(options.outputPath, xml, 'utf8');
}
