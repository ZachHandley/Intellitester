import * as path from 'node:path';
import fg from 'fast-glob';
import type { ComponentInfo } from './types';

/**
 * Scans for components matching the provided glob patterns
 * @param patterns Array of glob patterns to match
 * @param cwd Working directory for pattern resolution
 * @returns Array of component information
 */
export async function scanComponents(
  patterns: string[],
  cwd: string = process.cwd()
): Promise<ComponentInfo[]> {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  const files = await fg(patterns, {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.test.*', '**/*.spec.*'],
  });

  return files.map((filePath) => ({
    name: parseComponentName(filePath),
    path: filePath,
    relativePath: path.relative(cwd, filePath),
  }));
}

/**
 * Extracts a component name from a file path
 * @param filePath Path to the component file
 * @returns Component name
 */
export function parseComponentName(filePath: string): string {
  const basename = path.basename(filePath);
  // Remove extension(s) - handles .tsx, .jsx, .ts, .js, .vue, etc.
  const nameWithoutExt = basename.replace(/\.[^.]+$/, '');
  // If the name is 'index', use the parent directory name
  if (nameWithoutExt.toLowerCase() === 'index') {
    const parentDir = path.basename(path.dirname(filePath));
    return parentDir;
  }
  return nameWithoutExt;
}

/**
 * Gets the test file path for a component
 * @param componentPath Path to the component file
 * @param testsDir Directory where tests are stored
 * @returns Path where the test file should be created
 */
export function getTestFilePath(componentPath: string, testsDir: string, cwd: string = process.cwd()): string {
  const componentName = parseComponentName(componentPath);
  const relativePath = path.relative(cwd, componentPath);
  const dir = path.dirname(relativePath);

  // Create a structured test path based on the component location
  // e.g., src/components/Button.tsx -> tests/components/Button.test.yaml
  const testFileName = `${componentName}.test.yaml`;
  const testDir = path.join(testsDir, dir.replace(/^src/, ''));

  return path.join(testDir, testFileName);
}
