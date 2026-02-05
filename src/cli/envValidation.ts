/**
 * Environment variable validation utilities.
 * Consolidates repeated env validation logic from CLI commands.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

import { collectMissingEnvVars } from '../core/loader.js';
import { validateEnvVars } from './envHelper.js';

const CONFIG_FILENAME = 'intellitester.config.yaml';

/**
 * Check if a file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the project root directory by walking up from startPath
 * until we find a directory containing package.json, .git, or intellitester.config.yaml
 */
async function findProjectRoot(startPath: string): Promise<string | null> {
  let currentDir = path.isAbsolute(startPath) ? startPath : path.resolve(startPath);

  // If startPath is a file, start from its directory
  try {
    const stat = await fs.stat(currentDir);
    if (!stat.isDirectory()) {
      currentDir = path.dirname(currentDir);
    }
  } catch {
    currentDir = path.dirname(currentDir);
  }

  const rootMarkers = ['package.json', '.git', CONFIG_FILENAME];

  while (currentDir !== path.dirname(currentDir)) {
    for (const marker of rootMarkers) {
      const markerPath = path.join(currentDir, marker);
      if (await fileExists(markerPath)) {
        return currentDir;
      }
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

export interface ValidateFileEnvVarsOptions {
  /** Path to the file being validated (test, workflow, or pipeline) */
  filePath: string;
  /** Parsed content of the file (already parsed YAML/JSON) */
  parsedContent: unknown;
  /** Working directory for config file lookup (defaults to cwd) */
  cwd?: string;
}

/**
 * Validates environment variables for a file (test, workflow, or pipeline).
 * Collects missing env vars from both the global config and the file content,
 * prompts user to add them if missing.
 *
 * @returns true if all env vars are available, false if validation failed
 */
export async function validateFileEnvVars(options: ValidateFileEnvVarsOptions): Promise<boolean> {
  const { filePath, parsedContent, cwd = process.cwd() } = options;

  // Check for global config file
  const configPath = path.join(cwd, CONFIG_FILENAME);
  const hasConfigFile = await fileExists(configPath);
  let parsedConfig: unknown = undefined;

  if (hasConfigFile) {
    const configContent = await fs.readFile(configPath, 'utf8');
    parsedConfig = parse(configContent);
  }

  // Collect missing env vars from both config and file
  const configMissing = parsedConfig ? collectMissingEnvVars(parsedConfig) : [];
  const fileMissing = collectMissingEnvVars(parsedContent);
  const allMissing = [...new Set([...configMissing, ...fileMissing])];

  if (allMissing.length > 0) {
    const projectRoot = await findProjectRoot(filePath);
    return validateEnvVars(allMissing, projectRoot || cwd);
  }

  return true;
}

/**
 * Validates environment variables for a config-only check (e.g., generate command).
 *
 * @param cwd Working directory for config file lookup
 * @returns true if all env vars are available, false if validation failed
 */
export async function validateConfigEnvVars(cwd: string = process.cwd()): Promise<boolean> {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  const hasConfigFile = await fileExists(configPath);

  if (!hasConfigFile) {
    return true; // No config file, nothing to validate
  }

  const configContent = await fs.readFile(configPath, 'utf8');
  const parsedConfig = parse(configContent);
  const configMissing = collectMissingEnvVars(parsedConfig);

  if (configMissing.length > 0) {
    const projectRoot = await findProjectRoot(configPath);
    return validateEnvVars(configMissing, projectRoot || cwd);
  }

  return true;
}
