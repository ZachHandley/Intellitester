import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin, ViteDevServer, HmrContext } from 'vite';
import type { AutotesterOptions } from './types';
import { scanComponents, getTestFilePath } from './scanner';
import { generateTestStub, generateTestSuite } from './generator';

const DEFAULT_OPTIONS: Required<AutotesterOptions> = {
  testsDir: './tests',
  include: [],
  runOnBuild: false,
  watchTests: true,
  configPath: 'autotester.config.yaml',
  endpoint: '/__autotester',
};

/**
 * Creates the AutoTester Vite plugin
 * @param options Plugin configuration options
 * @returns Vite plugin
 */
export function autotester(options: AutotesterOptions = {}): Plugin {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let server: ViteDevServer | undefined;
  let root: string = process.cwd();
  let baseUrl: string | undefined;

  return {
    name: 'vite-plugin-autotester',
    enforce: 'pre',

    configResolved(config) {
      root = config.root;
      // Construct base URL from config
      const port = config.server?.port || 5173;
      const host = config.server?.host || 'localhost';
      baseUrl = `http://${host}:${port}`;
    },

    configureServer(devServer: ViteDevServer) {
      server = devServer;

      // Add middleware for the AutoTester endpoint
      devServer.middlewares.use(opts.endpoint, async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }

        try {
          const testsDir = path.resolve(root, opts.testsDir);
          const configPath = path.resolve(root, opts.configPath);

          // Check if tests directory exists
          const testsExist = fs.existsSync(testsDir);
          const configExists = fs.existsSync(configPath);

          // Scan for test files
          let testFiles: string[] = [];
          if (testsExist) {
            testFiles = fs.readdirSync(testsDir, { recursive: true })
              .filter((file): file is string => typeof file === 'string' && file.endsWith('.yaml'))
              .map((file) => path.join(testsDir, file));
          }

          // Generate HTML response
          const html = generateTestRunnerHtml({
            testsExist,
            configExists,
            testFiles,
            testsDir,
            configPath,
            baseUrl: baseUrl || 'http://localhost:5173',
          });

          res.setHeader('Content-Type', 'text/html');
          res.statusCode = 200;
          res.end(html);
        } catch (error) {
          res.statusCode = 500;
          res.end(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },

    async buildStart() {
      // Generate test stubs if include patterns are provided
      if (opts.include.length > 0) {
        try {
          const components = await scanComponents(opts.include, root);
          const testsDir = path.resolve(root, opts.testsDir);

          // Ensure tests directory exists
          if (!fs.existsSync(testsDir)) {
            fs.mkdirSync(testsDir, { recursive: true });
          }

          // Generate test stubs for components without tests
          let createdCount = 0;
          for (const component of components) {
            const testFilePath = getTestFilePath(component.path, opts.testsDir, root);
            const absoluteTestPath = path.resolve(root, testFilePath);

            // Only create if it doesn't exist
            if (!fs.existsSync(absoluteTestPath)) {
              const testDir = path.dirname(absoluteTestPath);
              if (!fs.existsSync(testDir)) {
                fs.mkdirSync(testDir, { recursive: true });
              }

              const testContent = generateTestStub(component, baseUrl);
              fs.writeFileSync(absoluteTestPath, testContent, 'utf-8');
              createdCount++;
            }
          }

          if (createdCount > 0) {
            console.log(`\n[autotester] Generated ${createdCount} test stub(s) in ${opts.testsDir}\n`);
          }
        } catch (error) {
          console.error('[autotester] Error generating test stubs:', error);
        }
      }
    },

    async buildEnd() {
      // Run tests if runOnBuild is enabled
      if (opts.runOnBuild) {
        console.log('\n[autotester] Running tests after build...\n');
        // TODO: Execute AutoTester CLI or programmatic API
        // This would require AutoTester to be installed as a dependency
        console.log('[autotester] Test execution not yet implemented');
      }
    },

    handleHotUpdate(ctx: HmrContext) {
      // Re-run tests if a test file changed and watchTests is enabled
      if (opts.watchTests && ctx.file.endsWith('.yaml') && ctx.file.includes(opts.testsDir)) {
        console.log(`\n[autotester] Test file changed: ${path.relative(root, ctx.file)}\n`);
        // TODO: Execute AutoTester CLI or programmatic API for the specific test
        console.log('[autotester] Test re-execution not yet implemented');
      }
    },
  };
}

/**
 * Generates HTML for the test runner endpoint
 */
function generateTestRunnerHtml(info: {
  testsExist: boolean;
  configExists: boolean;
  testFiles: string[];
  testsDir: string;
  configPath: string;
  baseUrl: string;
}): string {
  const { testsExist, configExists, testFiles, testsDir, configPath, baseUrl } = info;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AutoTester - Test Runner</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 2rem;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      padding: 2rem;
    }
    h1 {
      color: #2c3e50;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .status {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 4px;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .status.success { background: #d4edda; color: #155724; }
    .status.warning { background: #fff3cd; color: #856404; }
    .status.error { background: #f8d7da; color: #721c24; }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      margin: 2rem 0;
    }
    .info-card {
      padding: 1rem;
      background: #f8f9fa;
      border-radius: 6px;
      border-left: 4px solid #007bff;
    }
    .info-card h3 {
      font-size: 0.875rem;
      color: #6c757d;
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .info-card p {
      font-size: 1rem;
      color: #212529;
      font-weight: 500;
    }
    .test-list {
      margin-top: 2rem;
    }
    .test-list h2 {
      color: #2c3e50;
      margin-bottom: 1rem;
      font-size: 1.25rem;
    }
    .test-item {
      padding: 0.75rem 1rem;
      background: #f8f9fa;
      border-radius: 4px;
      margin-bottom: 0.5rem;
      font-family: 'Courier New', monospace;
      font-size: 0.875rem;
    }
    .empty-state {
      text-align: center;
      padding: 3rem;
      color: #6c757d;
    }
    .empty-state svg {
      width: 64px;
      height: 64px;
      margin-bottom: 1rem;
      opacity: 0.5;
    }
    .btn {
      display: inline-block;
      padding: 0.5rem 1rem;
      background: #007bff;
      color: white;
      text-decoration: none;
      border-radius: 4px;
      font-weight: 500;
      margin-top: 1rem;
      transition: background 0.2s;
    }
    .btn:hover {
      background: #0056b3;
    }
    code {
      background: #f8f9fa;
      padding: 0.2rem 0.4rem;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      🤖 AutoTester
      ${testsExist ? '<span class="status success">Tests Found</span>' : '<span class="status warning">No Tests</span>'}
      ${configExists ? '<span class="status success">Config Found</span>' : '<span class="status warning">No Config</span>'}
    </h1>

    <div class="info-grid">
      <div class="info-card">
        <h3>Base URL</h3>
        <p>${baseUrl}</p>
      </div>
      <div class="info-card">
        <h3>Tests Directory</h3>
        <p>${testsDir}</p>
      </div>
      <div class="info-card">
        <h3>Config Path</h3>
        <p>${configPath}</p>
      </div>
      <div class="info-card">
        <h3>Test Files</h3>
        <p>${testFiles.length} found</p>
      </div>
    </div>

    ${testFiles.length > 0 ? `
      <div class="test-list">
        <h2>Available Tests</h2>
        ${testFiles.map(file => `<div class="test-item">${file}</div>`).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p>No test files found</p>
        <p style="margin-top: 0.5rem; font-size: 0.875rem;">
          Add <code>include</code> patterns to your plugin config to auto-generate test stubs
        </p>
      </div>
    `}

    <div style="margin-top: 2rem; padding-top: 2rem; border-top: 1px solid #dee2e6;">
      <p style="font-size: 0.875rem; color: #6c757d;">
        To run tests, use the AutoTester CLI: <code>npx autotester run</code>
      </p>
    </div>
  </div>
</body>
</html>`;
}
