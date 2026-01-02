/**
 * Source scanner for extracting component information from project source files
 */

import { glob } from 'glob';
import { promises as fs } from 'fs';
import * as path from 'path';
import { extractElements, type ElementInfo } from './elementExtractor';

export interface SourceConfig {
  /** Directory containing page/route components */
  pagesDir?: string;
  /** Directory containing reusable components */
  componentsDir?: string;
  /** File extensions to scan */
  extensions?: string[];
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
}

export interface RouteInfo {
  /** Route path (e.g., /signup, /login) */
  path: string;
  /** Source file path */
  file: string;
  /** Component name */
  name: string;
}

export interface ComponentInfo {
  /** Component name */
  name: string;
  /** Source file path */
  file: string;
  /** Elements found in the component */
  elements: ElementInfo[];
}

export interface SourceScanResult {
  /** Detected routes */
  routes: RouteInfo[];
  /** Scanned components with their elements */
  components: ComponentInfo[];
  /** All elements across all components (flattened) */
  allElements: ElementInfo[];
}

const DEFAULT_EXTENSIONS = ['.vue', '.astro', '.tsx', '.jsx', '.svelte'];

/**
 * Converts a file path to a route path using file-based routing conventions
 */
function fileToRoute(filePath: string, pagesDir: string): string {
  // Get relative path from pages directory
  let route = path.relative(pagesDir, filePath);

  // Remove extension
  route = route.replace(/\.(vue|astro|tsx|jsx|svelte)$/, '');

  // Handle index files
  route = route.replace(/\/index$/, '');
  route = route.replace(/^index$/, '');

  // Handle dynamic routes: [param] -> :param, [...slug] -> *
  route = route.replace(/\[\.\.\.(\w+)\]/g, '*');
  route = route.replace(/\[(\w+)\]/g, ':$1');

  // Ensure leading slash
  route = '/' + route;

  // Clean up double slashes
  route = route.replace(/\/+/g, '/');

  // Remove trailing slash (except for root)
  if (route.length > 1) {
    route = route.replace(/\/$/, '');
  }

  return route;
}

/**
 * Extracts component name from file path
 */
function getComponentName(filePath: string): string {
  const basename = path.basename(filePath);
  return basename.replace(/\.(vue|astro|tsx|jsx|svelte)$/, '');
}

/**
 * Scans a directory for component files
 */
async function scanDirectory(
  dir: string,
  extensions: string[],
  cwd: string,
): Promise<string[]> {
  const fullDir = path.resolve(cwd, dir);

  try {
    await fs.access(fullDir);
  } catch {
    // Directory doesn't exist
    return [];
  }

  const patterns = extensions.map((ext) => `**/*${ext}`);
  const files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: fullDir,
      absolute: true,
      nodir: true,
    });
    files.push(...matches);
  }

  return files;
}

/**
 * Scans project source files to extract routes, components, and elements
 */
export async function scanProjectSource(config: SourceConfig): Promise<SourceScanResult> {
  const cwd = config.cwd ?? process.cwd();
  const extensions = config.extensions ?? DEFAULT_EXTENSIONS;

  const routes: RouteInfo[] = [];
  const components: ComponentInfo[] = [];
  const allElements: ElementInfo[] = [];

  // Scan pages directory for routes
  if (config.pagesDir) {
    const pageFiles = await scanDirectory(config.pagesDir, extensions, cwd);
    const pagesFullDir = path.resolve(cwd, config.pagesDir);

    for (const file of pageFiles) {
      const routePath = fileToRoute(file, pagesFullDir);
      const name = getComponentName(file);

      routes.push({
        path: routePath,
        file,
        name,
      });

      // Extract elements from page component
      const content = await fs.readFile(file, 'utf-8');
      const elements = extractElements(content, file, routePath);

      components.push({
        name,
        file,
        elements,
      });

      allElements.push(...elements);
    }
  }

  // Scan components directory
  if (config.componentsDir) {
    const componentFiles = await scanDirectory(config.componentsDir, extensions, cwd);

    for (const file of componentFiles) {
      // Skip if already processed as a page
      if (components.some((c) => c.file === file)) {
        continue;
      }

      const name = getComponentName(file);
      const content = await fs.readFile(file, 'utf-8');
      const elements = extractElements(content, file, undefined);

      components.push({
        name,
        file,
        elements,
      });

      allElements.push(...elements);
    }
  }

  // If no specific dirs provided, try common defaults
  if (!config.pagesDir && !config.componentsDir) {
    const commonPageDirs = ['src/pages', 'pages', 'app', 'src/app', 'src/routes'];
    const commonComponentDirs = ['src/components', 'components', 'src/lib', 'lib'];

    // Try to find pages
    for (const dir of commonPageDirs) {
      const files = await scanDirectory(dir, extensions, cwd);
      if (files.length > 0) {
        const pagesFullDir = path.resolve(cwd, dir);

        for (const file of files) {
          const routePath = fileToRoute(file, pagesFullDir);
          const name = getComponentName(file);

          routes.push({
            path: routePath,
            file,
            name,
          });

          const content = await fs.readFile(file, 'utf-8');
          const elements = extractElements(content, file, routePath);

          components.push({
            name,
            file,
            elements,
          });

          allElements.push(...elements);
        }
        break; // Use first matching directory
      }
    }

    // Try to find components
    for (const dir of commonComponentDirs) {
      const files = await scanDirectory(dir, extensions, cwd);
      if (files.length > 0) {
        for (const file of files) {
          if (components.some((c) => c.file === file)) {
            continue;
          }

          const name = getComponentName(file);
          const content = await fs.readFile(file, 'utf-8');
          const elements = extractElements(content, file, undefined);

          components.push({
            name,
            file,
            elements,
          });

          allElements.push(...elements);
        }
        break; // Use first matching directory
      }
    }
  }

  return {
    routes,
    components,
    allElements,
  };
}

/**
 * Formats scan results for use in AI prompts
 */
export function formatScanResultsForPrompt(result: SourceScanResult): string {
  const lines: string[] = [];

  // Routes section
  if (result.routes.length > 0) {
    lines.push('## ROUTES');
    lines.push('');
    for (const route of result.routes) {
      lines.push(`- ${route.path}: ${route.name}`);
    }
    lines.push('');
  }

  // Elements by route
  const elementsByRoute = new Map<string, ElementInfo[]>();

  for (const element of result.allElements) {
    const route = element.route ?? 'shared';
    if (!elementsByRoute.has(route)) {
      elementsByRoute.set(route, []);
    }
    elementsByRoute.get(route)!.push(element);
  }

  lines.push('## ELEMENTS');
  lines.push('');

  for (const [route, elements] of elementsByRoute) {
    lines.push(`### ${route === 'shared' ? 'Shared Components' : route}`);
    lines.push('');

    for (const el of elements) {
      const locators: string[] = [];

      if (el.testId) locators.push(`data-testid="${el.testId}"`);
      if (el.text) locators.push(`text="${el.text}"`);
      if (el.role) locators.push(`role="${el.role}"`);
      if (el.name) locators.push(`name="${el.name}"`);
      if (el.placeholder) locators.push(`placeholder="${el.placeholder}"`);
      if (el.type) locators.push(`type="${el.type}"`);

      const locatorStr = locators.length > 0 ? `[${locators.join(', ')}]` : '';
      const description = el.description ? ` - ${el.description}` : '';

      lines.push(`- <${el.tag}>${locatorStr}${description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
