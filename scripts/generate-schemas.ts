/**
 * Generate JSON Schema files from Zod schemas
 * Uses Zod v4's built-in toJSONSchema() method
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

import {
  IntellitesterConfigSchema,
  TestDefinitionSchema,
} from '../src/core/schema.js';
import { WorkflowDefinitionSchema } from '../src/core/workflowSchema.js';
import { PipelineDefinitionSchema } from '../src/core/pipelineSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(__dirname, '..', 'schemas');

// Ensure schemas directory exists
if (!existsSync(schemasDir)) {
  mkdirSync(schemasDir, { recursive: true });
}

interface SchemaConfig {
  schema: z.ZodType;
  file: string;
  title: string;
}

const schemas: SchemaConfig[] = [
  {
    schema: IntellitesterConfigSchema,
    file: 'intellitester.config.schema.json',
    title: 'IntelliTester Configuration',
  },
  {
    schema: TestDefinitionSchema,
    file: 'test.schema.json',
    title: 'IntelliTester Test Definition',
  },
  {
    schema: WorkflowDefinitionSchema,
    file: 'workflow.schema.json',
    title: 'IntelliTester Workflow Definition',
  },
  {
    schema: PipelineDefinitionSchema,
    file: 'pipeline.schema.json',
    title: 'IntelliTester Pipeline Definition',
  },
];

console.log('Generating JSON schemas from Zod definitions...\n');

for (const { schema, file, title } of schemas) {
  try {
    // Generate JSON Schema using Zod v4's built-in method
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    jsonSchema.title = title;

    const outputPath = join(schemasDir, file);
    writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2) + '\n');
    console.log(`✓ Generated ${file}`);
  } catch (error) {
    console.error(`✗ Failed to generate ${file}:`, error);
    process.exit(1);
  }
}

console.log('\nAll schemas generated successfully!');
