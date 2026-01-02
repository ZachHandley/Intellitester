import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import dotenv from 'dotenv';

export interface MissingEnvVar {
  name: string;
  description?: string;
}

/**
 * Displays a formatted box showing missing environment variables
 */
export function displayMissingEnvVars(missing: string[]): void {
  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│  ⚠️  Missing Environment Variables          │');
  console.log('├─────────────────────────────────────────────┤');
  for (const name of missing) {
    console.log(`│  • ${name.padEnd(39)}│`);
  }
  console.log('└─────────────────────────────────────────────┘\n');
}

/**
 * Prompts the user to add missing environment variables to .env file
 * Returns true if variables were successfully added, false otherwise
 */
export async function promptAddToEnv(
  missing: string[],
  envPath: string
): Promise<boolean> {
  const { shouldAdd } = await prompts({
    type: 'confirm',
    name: 'shouldAdd',
    message: `Add missing variables to ${path.basename(envPath)}?`,
    initial: true,
  });

  if (!shouldAdd) return false;

  // Collect values for each missing var
  const values: Record<string, string> = {};
  for (const name of missing) {
    const { value } = await prompts({
      type: 'password', // Hide sensitive values
      name: 'value',
      message: `Enter value for ${name}:`,
    });
    if (value !== undefined) {
      values[name] = value;
    }
  }

  // Append to .env file (create if doesn't exist)
  const lines = Object.entries(values)
    .map(([key, val]) => `${key}=${val}`)
    .join('\n');

  let existingContent = '';
  try {
    existingContent = await fs.readFile(envPath, 'utf8');
  } catch {
    // File doesn't exist, that's okay
  }

  const newContent = existingContent
    ? `${existingContent.trimEnd()}\n${lines}\n`
    : `${lines}\n`;

  await fs.writeFile(envPath, newContent, 'utf8');
  console.log(`\n✓ Added ${missing.length} variable(s) to ${path.basename(envPath)}\n`);

  // Reload env vars
  dotenv.config({ path: envPath, override: true });

  return true;
}

/**
 * Main function to check and handle missing environment variables
 * Returns true if all required vars are available (or were successfully added),
 * false if the user chose not to provide them
 */
export async function validateEnvVars(
  missing: string[],
  projectDir: string
): Promise<boolean> {
  if (missing.length === 0) return true;

  displayMissingEnvVars(missing);

  const envPath = path.join(projectDir, '.env');
  const added = await promptAddToEnv(missing, envPath);

  if (!added) {
    console.log('Cannot continue without required environment variables.');
    return false;
  }

  return true;
}
