import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'Value cannot be empty');

export const LocatorSchema = z
  .object({
    description: z.string().trim().optional(),
    testId: z.string().trim().optional(),
    text: z.string().trim().optional(),
    css: z.string().trim().optional(),
    xpath: z.string().trim().optional(),
    role: z.string().trim().optional(),
    name: z.string().trim().optional(),
  })
  .refine(
    (locator) =>
      Boolean(
        locator.description ||
        locator.testId ||
        locator.text ||
        locator.css ||
        locator.xpath ||
        locator.role ||
        locator.name,
      ),
    { message: 'Locator requires at least one selector or description' },
  );

const navigateActionSchema = z.object({
  type: z.literal('navigate'),
  value: nonEmptyString,
});

const tapActionSchema = z.object({
  type: z.literal('tap'),
  target: LocatorSchema,
});

const inputActionSchema = z.object({
  type: z.literal('input'),
  target: LocatorSchema,
  value: z.string(),
});

const assertActionSchema = z.object({
  type: z.literal('assert'),
  target: LocatorSchema,
  value: z.string().optional(),
});

const waitActionSchema = z
  .object({
    type: z.literal('wait'),
    target: LocatorSchema.optional(),
    timeout: z.number().int().positive().optional(),
  })
  .refine((action) => action.target || action.timeout, {
    message: 'wait requires a target or timeout',
  });

const scrollActionSchema = z.object({
  type: z.literal('scroll'),
  target: LocatorSchema.optional(),
  direction: z.enum(['up', 'down']).optional(),
  amount: z.number().int().positive().optional(),
});

const screenshotActionSchema = z.object({
  type: z.literal('screenshot'),
  name: z.string().optional(),
});

const setVarActionSchema = z.object({
  type: z.literal('setVar'),
  name: nonEmptyString,
  value: z.string().optional(),
  from: z.enum(['response', 'element', 'email']).optional(),
  path: z.string().optional(),
  pattern: z.string().optional(),
});

const emailWaitForActionSchema = z.object({
  type: z.literal('email.waitFor'),
  mailbox: nonEmptyString,
  timeout: z.number().int().positive().optional(),
  subjectContains: z.string().optional(),
});

const emailExtractCodeActionSchema = z.object({
  type: z.literal('email.extractCode'),
  saveTo: nonEmptyString,
  pattern: z.string().optional(),
});

const emailExtractLinkActionSchema = z.object({
  type: z.literal('email.extractLink'),
  saveTo: nonEmptyString,
  pattern: z.string().optional(),
});

const emailClearActionSchema = z.object({
  type: z.literal('email.clear'),
  mailbox: nonEmptyString,
});

export const ActionSchema = z.discriminatedUnion('type', [
  navigateActionSchema,
  tapActionSchema,
  inputActionSchema,
  assertActionSchema,
  waitActionSchema,
  scrollActionSchema,
  screenshotActionSchema,
  setVarActionSchema,
  emailWaitForActionSchema,
  emailExtractCodeActionSchema,
  emailExtractLinkActionSchema,
  emailClearActionSchema,
]);

const defaultsSchema = z.object({
  timeout: z.number().int().positive().optional(),
  screenshots: z.enum(['on-failure', 'always', 'never']).optional(),
});

const webConfigSchema = z.object({
  baseUrl: nonEmptyString.url().optional(),
  browser: z.string().trim().optional(),
  headless: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
});

const androidConfigSchema = z.object({
  appId: z.string().trim().optional(),
  device: z.string().trim().optional(),
});

const iosConfigSchema = z.object({
  bundleId: z.string().trim().optional(),
  simulator: z.string().trim().optional(),
});

const emailConfigSchema = z.object({
  provider: z.literal('inbucket'),
  endpoint: nonEmptyString.url(),
});

const appwriteConfigSchema = z.object({
  endpoint: nonEmptyString.url(),
  projectId: nonEmptyString,
  apiKey: nonEmptyString,
  cleanup: z.boolean().optional(),
  cleanupOnFailure: z.boolean().optional(),
});

const healingSchema = z.object({
  enabled: z.boolean().optional(),
  strategies: z.array(z.string().trim()).optional(),
});

const webServerSchema = z
  .object({
    // Option 1: Explicit command
    command: nonEmptyString.optional(),
    // Option 2: Auto-detect
    auto: z.boolean().optional(),
    // Option 3: Static directory
    static: z.string().optional(),
    // Required
    url: nonEmptyString.url(),
    port: z.number().int().positive().optional(),
    reuseExistingServer: z.boolean().default(true),
    timeout: z.number().int().positive().default(30000),
    cwd: z.string().optional(),
  })
  .refine((config) => config.command || config.auto || config.static, {
    message: 'WebServerConfig requires command, auto: true, or static directory',
  });

const aiConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'ollama']),
  model: nonEmptyString,
  apiKey: z.string().trim().optional(),
  baseUrl: z.string().trim().url().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(4096),
});

const platformsSchema = z.object({
  web: webConfigSchema.optional(),
  android: androidConfigSchema.optional(),
  ios: iosConfigSchema.optional(),
});

export const TestConfigSchema = z.object({
  defaults: defaultsSchema.optional(),
  web: webConfigSchema.optional(),
  android: androidConfigSchema.optional(),
  ios: iosConfigSchema.optional(),
  email: emailConfigSchema.optional(),
  appwrite: appwriteConfigSchema.optional(),
});

export const TestDefinitionSchema = z.object({
  name: nonEmptyString,
  platform: z.enum(['web', 'android', 'ios']),
  variables: z.record(z.string(), z.string()).optional(),
  config: TestConfigSchema.optional(),
  steps: z.array(ActionSchema).min(1),
});

export const AutotesterConfigSchema = z.object({
  defaults: defaultsSchema.optional(),
  ai: aiConfigSchema.optional(),
  platforms: platformsSchema.optional(),
  healing: healingSchema.optional(),
  email: emailConfigSchema.optional(),
  appwrite: appwriteConfigSchema.optional(),
  webServer: webServerSchema.optional(),
  secrets: z.record(z.string(), z.string().trim()).optional(),
});
