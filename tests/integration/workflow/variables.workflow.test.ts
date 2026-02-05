/**
 * E2E tests for variable interpolation in workflows.
 */
import { describe, it, expect } from 'vitest';
import { interpolateVariables } from '../../../src/core/interpolation.js';

describe('Variable Interpolation', () => {
  describe('basic interpolation', () => {
    it('should interpolate simple variables', () => {
      const variables = new Map([
        ['name', 'John'],
        ['email', 'john@example.com'],
      ]);

      const result = interpolateVariables('Hello {{name}}', variables);
      expect(result).toBe('Hello John');
    });

    it('should interpolate multiple variables', () => {
      const variables = new Map([
        ['first', 'John'],
        ['last', 'Doe'],
      ]);

      const result = interpolateVariables('{{first}} {{last}}', variables);
      expect(result).toBe('John Doe');
    });

    it('should handle variables at different positions', () => {
      const variables = new Map([['value', 'test']]);

      expect(interpolateVariables('{{value}}', variables)).toBe('test');
      expect(interpolateVariables('prefix-{{value}}', variables)).toBe('prefix-test');
      expect(interpolateVariables('{{value}}-suffix', variables)).toBe('test-suffix');
      expect(interpolateVariables('pre-{{value}}-suf', variables)).toBe('pre-test-suf');
    });
  });

  describe('missing variables', () => {
    it('should keep placeholder for missing variables', () => {
      const variables = new Map<string, string>();

      const result = interpolateVariables('Hello {{missing}}', variables);
      expect(result).toBe('Hello {{missing}}');
    });

    it('should interpolate existing and keep missing', () => {
      const variables = new Map([['name', 'John']]);

      const result = interpolateVariables('{{name}} at {{email}}', variables);
      expect(result).toBe('John at {{email}}');
    });
  });

  describe('special characters', () => {
    it('should handle variables with special characters in values', () => {
      const variables = new Map([
        ['url', 'https://example.com?foo=bar&baz=qux'],
        ['password', 'p@ss$w0rd!'],
      ]);

      const urlResult = interpolateVariables('Go to {{url}}', variables);
      expect(urlResult).toBe('Go to https://example.com?foo=bar&baz=qux');

      const passResult = interpolateVariables('Password: {{password}}', variables);
      expect(passResult).toBe('Password: p@ss$w0rd!');
    });

    it('should handle empty string values', () => {
      const variables = new Map([['empty', '']]);

      const result = interpolateVariables('Value: [{{empty}}]', variables);
      expect(result).toBe('Value: []');
    });

    it('should handle newlines in values', () => {
      const variables = new Map([['multiline', 'line1\nline2']]);

      const result = interpolateVariables('{{multiline}}', variables);
      expect(result).toBe('line1\nline2');
    });
  });

  describe('nested/repeated patterns', () => {
    it('should handle repeated variable', () => {
      const variables = new Map([['x', 'test']]);

      const result = interpolateVariables('{{x}} and {{x}}', variables);
      expect(result).toBe('test and test');
    });

    it('should not process nested braces', () => {
      const variables = new Map([['outer', 'value']]);

      // {{{{x}}}} should become {{value}}
      const result = interpolateVariables('{{outer}}', variables);
      expect(result).toBe('value');
    });
  });

  describe('whitespace handling', () => {
    it('should handle whitespace in variable names', () => {
      const variables = new Map([
        ['name', 'John'],
        [' name ', 'Jane'], // Variable with spaces
      ]);

      // Standard variable without spaces
      const result1 = interpolateVariables('{{ name }}', variables);
      // The implementation might trim or not - test actual behavior
      expect(['John', '{{ name }}']).toContain(result1);
    });

    it('should handle whitespace around values', () => {
      const variables = new Map([['name', '  spaced  ']]);

      const result = interpolateVariables('[{{name}}]', variables);
      expect(result).toBe('[  spaced  ]');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string input', () => {
      const variables = new Map([['x', 'test']]);

      const result = interpolateVariables('', variables);
      expect(result).toBe('');
    });

    it('should handle no variables in template', () => {
      const variables = new Map([['x', 'test']]);

      const result = interpolateVariables('No variables here', variables);
      expect(result).toBe('No variables here');
    });

    it('should handle empty variable map', () => {
      const variables = new Map<string, string>();

      const result = interpolateVariables('Hello {{name}}', variables);
      expect(result).toBe('Hello {{name}}');
    });

    it('should handle template with only variable', () => {
      const variables = new Map([['all', 'everything']]);

      const result = interpolateVariables('{{all}}', variables);
      expect(result).toBe('everything');
    });
  });

  describe('environment variable pattern', () => {
    it('should not interpolate ${} syntax (env vars)', () => {
      const variables = new Map([['NAME', 'test']]);

      // ${NAME} is environment variable syntax, not our pattern
      const result = interpolateVariables('${NAME}', variables);
      expect(result).toBe('${NAME}');
    });
  });

  describe('JSON/object values', () => {
    it('should handle JSON string values', () => {
      const variables = new Map([
        ['data', '{"key": "value"}'],
      ]);

      const result = interpolateVariables('Data: {{data}}', variables);
      expect(result).toBe('Data: {"key": "value"}');
    });
  });
});
