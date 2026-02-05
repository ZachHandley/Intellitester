import { describe, expect, it } from 'vitest';

import { parseIntellitesterConfig, parseTestDefinition } from '../src/core/loader';

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

    const config = parseIntellitesterConfig(yaml);
    expect(config.defaults?.timeout).toBe(30000);
    expect(config.platforms?.web?.baseUrl).toBe('https://example.com');
    expect(config.appwrite?.projectId).toBe('example-project');
    expect(config.email?.provider).toBe('inbucket');
  });

  it('parses test with variables and new action types', () => {
    const yaml = `
name: Email verification flow
platform: web
variables:
  TEST_EMAIL: "test-{{uuid}}@test.local"
  BASE_URL: "https://example.com"
steps:
  - type: navigate
    value: "{{BASE_URL}}/signup"
  - type: setVar
    name: code
    value: "123456"
  - type: email.waitFor
    mailbox: "{{TEST_EMAIL}}"
    timeout: 30000
    subjectContains: "Verify"
  - type: email.extractCode
    saveTo: verificationCode
    pattern: "\\\\d{6}"
  - type: email.extractLink
    saveTo: resetLink
  - type: email.clear
    mailbox: "{{TEST_EMAIL}}"
`;

    const parsed = parseTestDefinition(yaml);
    expect(parsed.name).toBe('Email verification flow');
    expect(parsed.variables).toBeDefined();
    expect(parsed.variables?.TEST_EMAIL).toBe('test-{{uuid}}@test.local');
    expect(parsed.variables?.BASE_URL).toBe('https://example.com');
    expect(parsed.steps).toHaveLength(6);

    // Check navigate with variable interpolation
    expect(parsed.steps[0].type).toBe('navigate');
    if (parsed.steps[0].type === 'navigate') {
      expect(parsed.steps[0].value).toBe('{{BASE_URL}}/signup');
    }

    // Check setVar action
    expect(parsed.steps[1].type).toBe('setVar');
    if (parsed.steps[1].type === 'setVar') {
      expect(parsed.steps[1].name).toBe('code');
      expect(parsed.steps[1].value).toBe('123456');
    }

    // Check email.waitFor action
    expect(parsed.steps[2].type).toBe('email.waitFor');
    if (parsed.steps[2].type === 'email.waitFor') {
      expect(parsed.steps[2].mailbox).toBe('{{TEST_EMAIL}}');
      expect(parsed.steps[2].timeout).toBe(30000);
      expect(parsed.steps[2].subjectContains).toBe('Verify');
    }

    // Check email.extractCode action
    expect(parsed.steps[3].type).toBe('email.extractCode');
    if (parsed.steps[3].type === 'email.extractCode') {
      expect(parsed.steps[3].saveTo).toBe('verificationCode');
      expect(parsed.steps[3].pattern).toBe('\\d{6}');
    }

    // Check email.extractLink action
    expect(parsed.steps[4].type).toBe('email.extractLink');
    if (parsed.steps[4].type === 'email.extractLink') {
      expect(parsed.steps[4].saveTo).toBe('resetLink');
    }

    // Check email.clear action
    expect(parsed.steps[5].type).toBe('email.clear');
    if (parsed.steps[5].type === 'email.clear') {
      expect(parsed.steps[5].mailbox).toBe('{{TEST_EMAIL}}');
    }
  });

  it('parses setVar with dynamic sources', () => {
    const yaml = `
name: Dynamic variable test
platform: web
steps:
  - type: setVar
    name: userId
    from: response
    path: "$.data.id"
  - type: setVar
    name: elementText
    from: element
    pattern: "User: (\\\\w+)"
`;

    const parsed = parseTestDefinition(yaml);
    expect(parsed.steps).toHaveLength(2);

    expect(parsed.steps[0].type).toBe('setVar');
    if (parsed.steps[0].type === 'setVar') {
      expect(parsed.steps[0].name).toBe('userId');
      expect(parsed.steps[0].from).toBe('response');
      expect(parsed.steps[0].path).toBe('$.data.id');
    }

    expect(parsed.steps[1].type).toBe('setVar');
    if (parsed.steps[1].type === 'setVar') {
      expect(parsed.steps[1].name).toBe('elementText');
      expect(parsed.steps[1].from).toBe('element');
      expect(parsed.steps[1].pattern).toBe('User: (\\w+)');
    }
  });

  it('parses type action for character-by-character input', () => {
    const yaml = `
name: Type action test
platform: web
steps:
  - type: type
    target:
      css: "[placeholder='Card number']"
    value: "4242424242424242"
    delay: 50
`;

    const parsed = parseTestDefinition(yaml);
    expect(parsed.steps).toHaveLength(1);
    const step = parsed.steps[0]!;
    expect(step.type).toBe('type');
    if (step.type === 'type') {
      expect(step.target!.css).toBe("[placeholder='Card number']");
      expect(step.value).toBe('4242424242424242');
      expect(step.delay).toBe(50);
    }
  });

  it('parses frame property for iframe targeting', () => {
    const yaml = `
name: Stripe iframe test
platform: web
steps:
  - type: type
    target:
      css: "[placeholder='Card number']"
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: "4242424242424242"
  - type: input
    target:
      testId: email-field
    frame:
      name: stripe-frame
    value: "test@example.com"
  - type: tap
    target:
      text: Submit
    frame:
      css: "#checkout-iframe"
`;

    const parsed = parseTestDefinition(yaml);
    expect(parsed.steps).toHaveLength(3);

    // Check type action with frame
    expect(parsed.steps[0].type).toBe('type');
    if (parsed.steps[0].type === 'type') {
      expect(parsed.steps[0].frame?.css).toBe('div.__PrivateStripeElement iframe');
      expect(parsed.steps[0].frame?.index).toBe(0);
    }

    // Check input action with frame
    expect(parsed.steps[1].type).toBe('input');
    if (parsed.steps[1].type === 'input') {
      expect(parsed.steps[1].frame?.name).toBe('stripe-frame');
    }

    // Check tap action with frame
    expect(parsed.steps[2].type).toBe('tap');
    if (parsed.steps[2].type === 'tap') {
      expect(parsed.steps[2].frame?.css).toBe('#checkout-iframe');
    }
  });

  it('validates frame locator requires css or name', () => {
    const yaml = `
name: Invalid frame
platform: web
steps:
  - type: input
    target:
      css: "input"
    frame:
      index: 0
    value: "test"
`;

    expect(() => parseTestDefinition(yaml)).toThrowError(/css.*name|name.*css/i);
  });
});
