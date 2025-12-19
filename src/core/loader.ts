import fs from 'node:fs/promises';

import type { ZodIssue, ZodType } from 'zod';
import { parse } from 'yaml';

import { AutotesterConfigSchema, TestDefinitionSchema } from './schema';
import type { AutotesterConfig, TestDefinition } from './types';

const formatIssues = (issues: ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.join('.') || '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

const parseWithSchema = <T>(content: string, schema: ZodType<T>, subject: string): T => {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML for ${subject}: ${message}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid ${subject}: ${formatIssues(result.error.issues)}`);
  }

  return result.data;
};

export const parseTestDefinition = (content: string): TestDefinition =>
  parseWithSchema(content, TestDefinitionSchema, 'test definition');

export const loadTestDefinition = async (filePath: string): Promise<TestDefinition> => {
  const fileContent = await fs.readFile(filePath, 'utf8');
  return parseTestDefinition(fileContent);
};

export const parseAutotesterConfig = (content: string): AutotesterConfig =>
  parseWithSchema(content, AutotesterConfigSchema, 'config');

export const loadAutotesterConfig = async (filePath: string): Promise<AutotesterConfig> => {
  const fileContent = await fs.readFile(filePath, 'utf8');
  return parseAutotesterConfig(fileContent);
};
