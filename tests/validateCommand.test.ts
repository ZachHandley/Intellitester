import { describe, expect, it } from 'vitest';

import {
  isPipelineContent,
  isPipelineFile,
  isWorkflowContent,
  isWorkflowFile,
  parsePipelineDefinition,
  parseTestDefinition,
  parseWorkflowDefinition,
} from '../src/core/loader';

const workflowYaml = `
name: smoke
tests:
  - file: ./foo.test.yaml
`;

const pipelineYaml = `
name: ci
workflows:
  - file: ./smoke.workflow.yaml
`;

const testYaml = `
name: smoke
platform: web
steps:
  - type: navigate
    value: /
`;

describe('validate command file routing', () => {
  describe('isWorkflowFile / isPipelineFile', () => {
    it('isWorkflowFile returns true for .workflow.yaml', () => {
      expect(isWorkflowFile('flows/smoke.workflow.yaml')).toBe(true);
    });

    it('isWorkflowFile returns true for .workflow.yml', () => {
      expect(isWorkflowFile('flows/smoke.workflow.yml')).toBe(true);
    });

    it('isPipelineFile returns true for .pipeline.yaml', () => {
      expect(isPipelineFile('pipelines/ci.pipeline.yaml')).toBe(true);
    });

    it('isPipelineFile returns true for .pipeline.yml', () => {
      expect(isPipelineFile('pipelines/ci.pipeline.yml')).toBe(true);
    });

    it('returns false for .test.yaml on both workflow and pipeline checks', () => {
      expect(isWorkflowFile('tests/foo.test.yaml')).toBe(false);
      expect(isPipelineFile('tests/foo.test.yaml')).toBe(false);
    });
  });

  describe('isWorkflowContent', () => {
    it('recognizes a yaml document with a tests: array', () => {
      expect(isWorkflowContent(workflowYaml)).toBe(true);
    });

    it('returns false for yaml with steps: instead of tests:', () => {
      expect(isWorkflowContent(testYaml)).toBe(false);
    });
  });

  describe('isPipelineContent', () => {
    it('recognizes a yaml document with a workflows: array', () => {
      expect(isPipelineContent(pipelineYaml)).toBe(true);
    });

    it('returns false for yaml with steps: instead of workflows:', () => {
      expect(isPipelineContent(testYaml)).toBe(false);
    });
  });

  describe('parseWorkflowDefinition', () => {
    it('accepts a valid workflow document', () => {
      const result = parseWorkflowDefinition(workflowYaml);
      expect(result.name).toBe('smoke');
      expect(result.tests[0].file).toBe('./foo.test.yaml');
    });
  });

  describe('parsePipelineDefinition', () => {
    it('accepts a valid pipeline document', () => {
      const result = parsePipelineDefinition(pipelineYaml);
      expect(result.name).toBe('ci');
      expect(result.workflows[0].file).toBe('./smoke.workflow.yaml');
    });
  });

  describe('parseTestDefinition', () => {
    it('rejects a workflow document with "Invalid test definition"', () => {
      expect(() => parseTestDefinition(workflowYaml)).toThrow(/Invalid test definition/);
    });

    it('accepts a valid test document', () => {
      const result = parseTestDefinition(testYaml);
      expect(result.name).toBe('smoke');
      expect(result.platform).toBe('web');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].type).toBe('navigate');
    });
  });
});
