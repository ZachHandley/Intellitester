import fs from 'node:fs/promises';

import type { ZodIssue, ZodType } from 'zod';
import { parse } from 'yaml';

import { IntellitesterConfigSchema, TestDefinitionSchema } from './schema';
import type { IntellitesterConfig, TestDefinition } from './types';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './workflowSchema';
import { PipelineDefinitionSchema, type PipelineDefinition } from './pipelineSchema';

const formatIssues = (issues: ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.join('.') || '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

/**
 * Interpolates environment variables in a parsed YAML object.
 * Recursively replaces ${VAR_NAME} patterns with environment variable values.
 */
const interpolateEnvVars = (obj: unknown): unknown => {
  if (typeof obj === 'string') {
    // Replace ${VAR_NAME} with environment variable value
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable ${varName} is not defined`);
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }

  return obj;
};

const parseWithSchema = <T>(content: string, schema: ZodType<T>, subject: string): T => {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML for ${subject}: ${message}`);
  }

  // Interpolate environment variables in the parsed content
  const interpolated = interpolateEnvVars(parsed);

  const result = schema.safeParse(interpolated);
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

export const parseIntellitesterConfig = (content: string): IntellitesterConfig =>
  parseWithSchema(content, IntellitesterConfigSchema, 'config');

export const loadIntellitesterConfig = async (filePath: string): Promise<IntellitesterConfig> => {
  const fileContent = await fs.readFile(filePath, 'utf8');
  return parseIntellitesterConfig(fileContent);
};

export const parseWorkflowDefinition = (content: string): WorkflowDefinition =>
  parseWithSchema(content, WorkflowDefinitionSchema, 'workflow definition');

export const loadWorkflowDefinition = async (filePath: string): Promise<WorkflowDefinition> => {
  const fileContent = await fs.readFile(filePath, 'utf8');
  return parseWorkflowDefinition(fileContent);
};

export const isWorkflowFile = (filePath: string): boolean => {
  return filePath.endsWith('.workflow.yaml') || filePath.endsWith('.workflow.yml');
};

/**
 * Check if a file is a pipeline file based on naming convention.
 * Pipeline files end with .pipeline.yaml or .pipeline.yml
 */
export const isPipelineFile = (filePath: string): boolean => {
  return filePath.endsWith('.pipeline.yaml') || filePath.endsWith('.pipeline.yml');
};

/**
 * Parse pipeline definition from string content.
 */
export const parsePipelineDefinition = (content: string): PipelineDefinition =>
  parseWithSchema(content, PipelineDefinitionSchema, 'pipeline definition');

/**
 * Load and validate a pipeline definition from a YAML file.
 */
export const loadPipelineDefinition = async (filePath: string): Promise<PipelineDefinition> => {
  const fileContent = await fs.readFile(filePath, 'utf8');
  return parsePipelineDefinition(fileContent);
};

/**
 * Recursively collects all environment variable names that are referenced
 * but not defined in the process environment.
 */
export const collectMissingEnvVars = (obj: unknown): string[] => {
  const missing: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      const matches = value.matchAll(/\$\{([^}]+)\}/g);
      for (const match of matches) {
        const varName = match[1];
        if (process.env[varName] === undefined && !missing.includes(varName)) {
          missing.push(varName);
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(collect);
    }
  };

  collect(obj);
  return missing;
};
