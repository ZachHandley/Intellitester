import { describe, expect, it } from 'vitest';

import { parseAutotesterConfig, parseTestDefinition } from '../src/core/loader';

describe('schemas', () => {
  it('parses a minimal web test', () => {
    const yaml = `
name: Basic web flow
platform: web
steps:
  - type: navigate
    value: /login
  - type: input
    target:
      testId: email-input
    value: test@example.com
  - type: tap
    target:
      text: "Sign In"
`;

    const parsed = parseTestDefinition(yaml);
    expect(parsed.name).toBe('Basic web flow');
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0].type).toBe('navigate');
  });

  it('validates the wait action requires a target or timeout', () => {
    const yaml = `
name: Invalid wait
platform: web
steps:
  - type: wait
`;

    expect(() => parseTestDefinition(yaml)).toThrowError(/wait/);
  });

  it('parses the runner config shape', () => {
    const yaml = `
defaults:
  timeout: 30000
  screenshots: on-failure
platforms:
  web:
    baseUrl: https://example.com
    headless: true
appwrite:
  endpoint: https://cloud.appwrite.io/v1
  projectId: example-project
  apiKey: secret
email:
  provider: inbucket
  endpoint: http://localhost:9000
`;

    const config = parseAutotesterConfig(yaml);
    expect(config.defaults?.timeout).toBe(30000);
    expect(config.platforms?.web?.baseUrl).toBe('https://example.com');
    expect(config.appwrite?.projectId).toBe('example-project');
    expect(config.email?.provider).toBe('inbucket');
  });
});
