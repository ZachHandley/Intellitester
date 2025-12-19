import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReporterOptions, TestReport } from './types';
import type { StepResult } from '../executors/web';

async function readScreenshotAsBase64(screenshotPath: string): Promise<string> {
  try {
    const buffer = await fs.readFile(screenshotPath);
    return buffer.toString('base64');
  } catch {
    return '';
  }
}

function formatActionDetails(step: StepResult): string {
  const { action } = step;
  switch (action.type) {
    case 'navigate':
      return `Navigate to: ${action.value}`;
    case 'tap':
      return `Tap: ${JSON.stringify(action.target)}`;
    case 'input':
      return `Input "${action.value}" into: ${JSON.stringify(action.target)}`;
    case 'assert':
      return `Assert: ${JSON.stringify(action.target)}${action.value ? ` contains "${action.value}"` : ''}`;
    case 'wait':
      return `Wait: ${action.target ? JSON.stringify(action.target) : `${action.timeout}ms`}`;
    case 'scroll':
      return `Scroll ${action.direction ?? 'down'}: ${action.amount ?? 500}px`;
    case 'screenshot':
      return `Screenshot: ${action.name ?? 'unnamed'}`;
    default:
      return JSON.stringify(action);
  }
}

async function generateHtmlContent(
  report: TestReport,
  options: ReporterOptions,
): Promise<string> {
  const passedSteps = report.result.steps.filter((s) => s.status === 'passed').length;
  const failedSteps = report.result.steps.filter((s) => s.status === 'failed').length;
  const totalSteps = report.result.steps.length;

  const stepsHtml = await Promise.all(
    report.result.steps.map(async (step, index) => {
      const statusIcon = step.status === 'passed' ? '✓' : '✗';
      const statusClass = step.status === 'passed' ? 'passed' : 'failed';
      const actionDetails = formatActionDetails(step);

      let screenshotHtml = '';
      if (step.screenshotPath) {
        if (options.embedScreenshots) {
          const base64 = await readScreenshotAsBase64(step.screenshotPath);
          if (base64) {
            screenshotHtml = `
              <div class="screenshot">
                <img src="data:image/png;base64,${base64}" alt="Screenshot ${index + 1}" />
              </div>
            `;
          }
        } else {
          screenshotHtml = `
            <div class="screenshot-link">
              <a href="${step.screenshotPath}" target="_blank">View Screenshot</a>
            </div>
          `;
        }
      }

      const errorHtml = step.error
        ? `
        <div class="error-details">
          <strong>Error:</strong>
          <pre>${step.error}</pre>
        </div>
      `
        : '';

      return `
        <tr class="${statusClass}">
          <td class="step-number">${index + 1}</td>
          <td class="status-icon">${statusIcon}</td>
          <td class="action-type">${step.action.type}</td>
          <td class="action-details">
            ${actionDetails}
            ${errorHtml}
            ${screenshotHtml}
          </td>
        </tr>
      `;
    }),
  );

  const overallStatus = report.result.status === 'passed' ? 'PASSED' : 'FAILED';
  const overallClass = report.result.status === 'passed' ? 'passed' : 'failed';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Report: ${report.testName}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
    }

    .header h1 {
      font-size: 28px;
      margin-bottom: 10px;
    }

    .header .meta {
      opacity: 0.9;
      font-size: 14px;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      padding: 30px;
      background: #fafafa;
      border-bottom: 1px solid #e0e0e0;
    }

    .summary-card {
      background: white;
      padding: 20px;
      border-radius: 6px;
      border-left: 4px solid #667eea;
    }

    .summary-card.passed {
      border-left-color: #10b981;
    }

    .summary-card.failed {
      border-left-color: #ef4444;
    }

    .summary-card .label {
      font-size: 12px;
      text-transform: uppercase;
      color: #666;
      margin-bottom: 8px;
      font-weight: 600;
    }

    .summary-card .value {
      font-size: 32px;
      font-weight: 700;
    }

    .summary-card.passed .value {
      color: #10b981;
    }

    .summary-card.failed .value {
      color: #ef4444;
    }

    .steps {
      padding: 30px;
    }

    .steps h2 {
      font-size: 20px;
      margin-bottom: 20px;
      color: #333;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      background: #f9fafb;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #374151;
      border-bottom: 2px solid #e5e7eb;
      font-size: 14px;
    }

    td {
      padding: 16px 12px;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: top;
    }

    .step-number {
      width: 60px;
      text-align: center;
      font-weight: 600;
      color: #6b7280;
    }

    .status-icon {
      width: 40px;
      text-align: center;
      font-size: 20px;
      font-weight: bold;
    }

    tr.passed .status-icon {
      color: #10b981;
    }

    tr.failed .status-icon {
      color: #ef4444;
    }

    .action-type {
      width: 120px;
      font-weight: 500;
      color: #6366f1;
      text-transform: capitalize;
    }

    .action-details {
      color: #4b5563;
      font-size: 14px;
    }

    .error-details {
      margin-top: 10px;
      padding: 12px;
      background: #fef2f2;
      border-left: 3px solid #ef4444;
      border-radius: 4px;
    }

    .error-details strong {
      color: #dc2626;
      display: block;
      margin-bottom: 6px;
    }

    .error-details pre {
      color: #991b1b;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: 'Courier New', monospace;
      font-size: 13px;
    }

    .screenshot {
      margin-top: 12px;
    }

    .screenshot img {
      max-width: 100%;
      height: auto;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    .screenshot-link {
      margin-top: 8px;
    }

    .screenshot-link a {
      color: #6366f1;
      text-decoration: none;
      font-size: 13px;
    }

    .screenshot-link a:hover {
      text-decoration: underline;
    }

    @media (max-width: 768px) {
      body {
        padding: 10px;
      }

      .header {
        padding: 20px;
      }

      .header h1 {
        font-size: 22px;
      }

      .summary {
        padding: 20px;
        grid-template-columns: 1fr;
      }

      .steps {
        padding: 20px;
      }

      table {
        font-size: 13px;
      }

      td, th {
        padding: 10px 8px;
      }

      .step-number,
      .action-type {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${report.testName}</h1>
      <div class="meta">
        <div>Platform: ${report.platform}</div>
        <div>Timestamp: ${new Date(report.timestamp).toLocaleString()}</div>
        ${report.duration ? `<div>Duration: ${(report.duration / 1000).toFixed(2)}s</div>` : ''}
      </div>
    </div>

    <div class="summary">
      <div class="summary-card ${overallClass}">
        <div class="label">Overall Status</div>
        <div class="value">${overallStatus}</div>
      </div>
      <div class="summary-card">
        <div class="label">Total Steps</div>
        <div class="value">${totalSteps}</div>
      </div>
      <div class="summary-card passed">
        <div class="label">Passed</div>
        <div class="value">${passedSteps}</div>
      </div>
      <div class="summary-card failed">
        <div class="label">Failed</div>
        <div class="value">${failedSteps}</div>
      </div>
    </div>

    <div class="steps">
      <h2>Test Steps</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Status</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          ${stepsHtml.join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
  `.trim();
}

export async function generateHtmlReport(
  report: TestReport,
  options: ReporterOptions,
): Promise<void> {
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  const html = await generateHtmlContent(report, options);
  await fs.writeFile(options.outputPath, html, 'utf8');
}
