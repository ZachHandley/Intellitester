import { z } from 'zod';
import { SUPPORTED_PROVIDERS } from '../ai/types';

const nonEmptyString = z.string().trim().min(1, 'Value cannot be empty');

// Transform empty strings to undefined for optional fields
const _optionalString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().trim().optional()
);

// Transform empty strings to undefined for optional URL fields
const optionalUrl = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().trim().url().optional()
);

const trackSchema = z.object({
  type: nonEmptyString.describe('Tracked resource type (e.g., row, user, file)'),
  id: nonEmptyString.describe('Tracked resource ID'),
  includeStepContext: z.boolean().optional().describe('Include step context with tracked resource'),
}).passthrough().describe('Optional tracking metadata for cleanup');

const trackableSchema = z.object({
  track: trackSchema.optional(),
});

// Error condition for immediate failure (no waiting)
export const errorIfSchema = z.enum(['not-found', 'not-visible', 'disabled', 'empty'])
  .describe('Fail immediately if this condition is met (no waiting)');

export const LocatorSchema = z
  .object({
    description: z.string().trim().optional().describe('AI-friendly description of the element to find'),
    testId: z.string().trim().optional().describe('data-testid attribute value'),
    text: z.string().trim().optional().describe('Visible text content'),
    css: z.string().trim().optional().describe('CSS selector'),
    xpath: z.string().trim().optional().describe('XPath selector'),
    role: z.string().trim().optional().describe('ARIA role'),
    name: z.string().trim().optional().describe('Accessible name'),
  })
  .describe('Defines how to locate an element on the page. At least one selector must be provided.')
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

export const FrameLocatorSchema = z
  .object({
    css: z.string().trim().optional().describe('CSS selector for the iframe element'),
    name: z.string().trim().optional().describe('Name or id attribute of the iframe'),
    index: z.number().int().nonnegative().optional().describe('Zero-based index when multiple iframes match (default: 0)'),
  })
  .describe('Defines how to locate an iframe on the page. Either css or name must be provided.')
  .refine(
    (locator) => Boolean(locator.css || locator.name),
    { message: 'FrameLocator requires css or name' },
  );

const navigateActionSchema = z.object({
  type: z.literal('navigate'),
  value: nonEmptyString.describe('URL or path to navigate to'),
}).describe('Navigate to a URL');

const tapActionSchema = z.object({
  type: z.literal('tap'),
  target: LocatorSchema,
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  errorIf: errorIfSchema.optional(),
}).describe('Click or tap on an element');

const inputActionSchema = z.object({
  type: z.literal('input'),
  target: LocatorSchema,
  value: z.string().describe('Text to input (can reference variables with ${VAR_NAME})'),
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  errorIf: errorIfSchema.optional(),
}).describe('Input text into a field (clears field first)');

const typeActionSchema = z.object({
  type: z.literal('type'),
  target: LocatorSchema.optional().describe('Element to type into (if omitted, types into the currently focused element)'),
  value: z.string().describe('Text to type character-by-character (appends to existing content)'),
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  delay: z.number().int().nonnegative().optional().describe('Delay between keystrokes in milliseconds (default: 50)'),
  errorIf: errorIfSchema.optional(),
}).describe('Type text character-by-character without clearing (for Stripe, special inputs)');

const clearActionSchema = z.object({
  type: z.literal('clear'),
  target: LocatorSchema,
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  errorIf: errorIfSchema.optional(),
}).describe('Clear the contents of an input field');

// Inline synthetic file: caller supplies name + content directly, no disk read.
const uploadInlineFileSchema = z.object({
  name: nonEmptyString.describe('Filename presented to the page (e.g. "resume.pdf")'),
  mimeType: z.string().trim().optional()
    .describe('MIME type. If omitted, derived from `name` extension; falls back to application/octet-stream.'),
  content: z.string().optional()
    .describe('Plain-text file contents. Mutually exclusive with `base64`.'),
  base64: z.string().optional()
    .describe('Base64-encoded file contents. Mutually exclusive with `content`.'),
}).refine((o) => (o.content !== undefined) !== (o.base64 !== undefined), {
  message: 'inline upload file requires exactly one of `content` or `base64`',
});

// A single entry in an upload action's `files`: a string (local path or http(s) URL) or an inline object.
const uploadFileEntrySchema = z.union([
  nonEmptyString.describe('File path (relative to test YAML, absolute, or http(s):// URL). Supports {{var}} interpolation.'),
  uploadInlineFileSchema,
]);

const uploadActionSchema = z.object({
  type: z.literal('upload'),
  target: LocatorSchema.optional()
    .describe('The <input type="file"> element. Works even when CSS-hidden. Use this OR `trigger`, not both.'),
  trigger: LocatorSchema.optional()
    .describe('A button that opens the OS file chooser when clicked. Use this OR `target`, not both.'),
  files: z.union([uploadFileEntrySchema, z.array(uploadFileEntrySchema).min(1)])
    .describe('One file or an ordered list of files. Strings are local paths or http(s) URLs; objects are inline synthetic files.'),
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target/trigger element'),
  errorIf: errorIfSchema.optional(),
}).describe('Upload one or more files to a file input or filechooser-triggering button');

const hoverActionSchema = z.object({
  type: z.literal('hover'),
  target: LocatorSchema,
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  errorIf: errorIfSchema.optional(),
}).describe('Hover over an element');

const selectActionSchema = z.object({
  type: z.literal('select'),
  target: LocatorSchema,
  value: z.string().describe('Option value, label, or index to select'),
  errorIf: errorIfSchema.optional(),
}).describe('Select an option from a dropdown');

const checkActionSchema = z.object({
  type: z.literal('check'),
  target: LocatorSchema,
  errorIf: errorIfSchema.optional(),
}).describe('Check a checkbox');

const uncheckActionSchema = z.object({
  type: z.literal('uncheck'),
  target: LocatorSchema,
  errorIf: errorIfSchema.optional(),
}).describe('Uncheck a checkbox');

const pressActionSchema = z.object({
  type: z.literal('press'),
  key: nonEmptyString.describe('Key to press (e.g., Enter, Tab, Escape, ArrowDown)'),
  target: LocatorSchema.optional().describe('Element to focus before pressing key'),
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element or keyboard action'),
  errorIf: errorIfSchema.optional(),
}).describe('Press a keyboard key');

const focusActionSchema = z.object({
  type: z.literal('focus'),
  target: LocatorSchema,
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  errorIf: errorIfSchema.optional(),
}).describe('Focus an element');

const assertActionSchema = z.object({
  type: z.literal('assert'),
  target: LocatorSchema,
  value: z.string().optional().describe('Expected text content'),
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  errorIf: errorIfSchema.optional(),
}).describe('Assert that an element exists or contains expected text');

const waitActionSchema = z
  .object({
    type: z.literal('wait'),
    target: LocatorSchema.optional().describe('Element to wait for'),
    timeout: z.number().int().positive().optional().describe('Time to wait in milliseconds'),
    frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
    errorIf: errorIfSchema.optional(),
  })
  .describe('Wait for an element or timeout')
  .refine((action) => action.target || action.timeout, {
    message: 'wait requires a target or timeout',
  });

const scrollActionSchema = z.object({
  type: z.literal('scroll'),
  target: LocatorSchema.optional().describe('Element to scroll'),
  direction: z.enum(['up', 'down']).optional().describe('Direction to scroll'),
  amount: z.number().int().positive().optional().describe('Amount to scroll in pixels'),
  errorIf: errorIfSchema.optional(),
}).describe('Scroll the page or an element');

const screenshotActionSchema = z.object({
  type: z.literal('screenshot'),
  name: z.string().optional().describe('Name for the screenshot file'),
  waitBefore: z.number().int().nonnegative().optional().describe('Milliseconds to wait before capturing for visual stability (default: 500)'),
}).describe('Take a screenshot');

const setVarActionSchema = z.object({
  type: z.literal('setVar'),
  name: nonEmptyString.describe('Variable name to set'),
  value: z.string().optional().describe('Static value to set'),
  from: z.enum(['response', 'element', 'email']).optional().describe('Extract value from a source'),
  path: z.string().optional().describe('JSON path or selector for extraction'),
  pattern: z.string().optional().describe('Regular expression pattern for extraction'),
}).describe('Set a variable for use in later steps');

const emailWaitForActionSchema = z.object({
  type: z.literal('email.waitFor'),
  mailbox: nonEmptyString.describe('Email address or mailbox to check'),
  timeout: z.number().int().positive().optional().describe('How long to wait for email in milliseconds'),
  subjectContains: z.string().optional().describe('Filter by email subject'),
}).describe('Wait for an email to arrive');

const emailExtractCodeActionSchema = z.object({
  type: z.literal('email.extractCode'),
  saveTo: nonEmptyString.describe('Variable name to save the extracted code'),
  pattern: z.string().optional().describe('Regular expression to extract code'),
}).describe('Extract a verification code from email');

const emailExtractLinkActionSchema = z.object({
  type: z.literal('email.extractLink'),
  saveTo: nonEmptyString.describe('Variable name to save the extracted link'),
  pattern: z.string().optional().describe('Regular expression to match specific links'),
}).describe('Extract a link from email');

const emailClearActionSchema = z.object({
  type: z.literal('email.clear'),
  mailbox: nonEmptyString.describe('Email address or mailbox to clear'),
}).describe('Clear emails from a mailbox');

const appwriteVerifyEmailActionSchema = z.object({
  type: z.literal('appwrite.verifyEmail'),
}).describe('Verify email using Appwrite');

const debugActionSchema = z.object({
  type: z.literal('debug'),
}).describe('Pause execution and open Playwright Inspector for debugging');

const waitForSelectorActionSchema = z.object({
  type: z.literal('waitForSelector'),
  target: LocatorSchema,
  state: z.enum(['enabled', 'disabled', 'visible', 'hidden', 'attached', 'detached'])
    .describe('Element state to wait for'),
  timeout: z.number().int().positive().optional()
    .describe('Time to wait in milliseconds'),
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  errorIf: errorIfSchema.optional(),
}).describe('Wait for an element to reach a specific state');

const logActionSchema = z.object({
  type: z.literal('log'),
  message: z.string().optional().describe('Static message to log (supports ${VAR_NAME} interpolation)'),
  eval: z.string().optional().describe('JavaScript expression to evaluate in page context'),
  target: LocatorSchema.optional().describe('Element to extract content from'),
  frame: FrameLocatorSchema.optional().describe('Iframe context for the target element'),
  format: z.enum(['text', 'html', 'json']).optional().describe('Output format for element content (default: text)'),
}).describe('Log a message, evaluate JS, or extract element content for debugging')
  .refine(
    (action) => action.message || action.eval || action.target,
    { message: 'log requires message, eval, or target' },
  );

const failActionSchema = z.object({
  type: z.literal('fail'),
  message: nonEmptyString.describe('Error message to display when test fails'),
}).describe('Explicitly fail the test with a custom message');

const evaluateActionSchema = z.object({
  type: z.literal('evaluate'),
  expected: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Text to find in screenshot (substring or regex)'),
  mode: z.enum(['ocr', 'ai', 'auto']).optional()
    .describe('ocr=OCR only, ai=LLM vision only, auto=OCR first then AI fallback (default: auto)'),
  regex: z.boolean().optional()
    .describe('Treat expected as regex patterns (default: false)'),
  prompt: z.string().optional()
    .describe('Custom prompt for AI mode'),
  waitBefore: z.number().int().nonnegative().optional()
    .describe('ms to wait before screenshot for visual stability (default: 500)'),
  fullPage: z.boolean().optional()
    .describe('Full page or viewport only (default: true)'),
  confidence: z.number().min(0).max(100).optional()
    .describe('Min OCR confidence threshold, below falls back to AI in auto mode (default: 60)'),
}).describe('Evaluate page state via screenshot analysis (OCR and/or AI vision)');

const saveStorageStateActionSchema = z.object({
  type: z.literal('saveStorageState'),
  path: nonEmptyString.optional()
    .describe('File path (relative to cwd) to write Playwright storageState JSON. Calls page.context().storageState({ path }).'),
  handler: nonEmptyString.optional()
    .describe('Path (relative to cwd) to a TS/JS file exporting `default async ({ page, context, variables }) => void`. Called instead of the built-in writer for custom serialization (e.g., to Python pickle, SQLite, S3, ...).'),
}).describe('Persist the current browser context state (cookies, localStorage) for reuse via config.web.storageState in subsequent runs.')
  .refine(
    (action) => action.path || action.handler,
    { message: 'saveStorageState requires either `path` or `handler`' },
  );

const assertCookiesActionSchema = z.object({
  type: z.literal('assertCookies'),
  has: z.array(nonEmptyString).optional()
    .describe('Cookie names that MUST be present in the context.'),
  not: z.array(nonEmptyString).optional()
    .describe('Cookie names that MUST NOT be present in the context.'),
  match: z.record(z.string(), z.string()).optional()
    .describe('Map of cookie name to value-matching pattern (substring by default; wrap in /.../ for regex).'),
  url: nonEmptyString.optional()
    .describe('Optional URL/origin filter passed to context.cookies(url).'),
}).describe('Assert presence/absence (and optionally values) of cookies in the browser context. Sees HttpOnly cookies.')
  .refine(
    (a) => Boolean(a.has?.length) || Boolean(a.not?.length) || Boolean(a.match && Object.keys(a.match).length > 0),
    { message: 'assertCookies requires at least one of `has`, `not`, or `match`' },
  );

const expectResponseActionSchema = z.object({
  type: z.literal('expectResponse'),
  url: nonEmptyString.describe('URL pattern: glob by default (** = any path, * = single segment), or /regex/ for regex.'),
  status: z.number().int().min(100).max(599).optional()
    .describe('Expected HTTP status code (exact match).'),
  headers: z.record(z.string(), z.string()).optional()
    .describe('Headers that must all match. Header name is case-insensitive. Values: substring match by default, or /regex/ for regex.'),
  since: z.union([
    z.literal('previousStep'),
    z.literal('testStart'),
    z.number(),
  ]).optional().describe('Time window lower bound. Default: previousStep.'),
  timeout: z.number().int().positive().optional()
    .describe('Max wait in ms for a matching response (default 5000).'),
}).describe('Assert that a network response matching the given URL/status/headers was seen since `since`.');

// Base action schema without conditional (used for nested steps in conditional)
const BaseActionSchema = z.discriminatedUnion('type', [
  navigateActionSchema,
  tapActionSchema,
  inputActionSchema,
  typeActionSchema,
  clearActionSchema,
  uploadActionSchema,
  hoverActionSchema,
  selectActionSchema,
  checkActionSchema,
  uncheckActionSchema,
  pressActionSchema,
  focusActionSchema,
  assertActionSchema,
  waitActionSchema,
  scrollActionSchema,
  screenshotActionSchema,
  saveStorageStateActionSchema,
  assertCookiesActionSchema,
  expectResponseActionSchema,
  setVarActionSchema,
  emailWaitForActionSchema,
  emailExtractCodeActionSchema,
  emailExtractLinkActionSchema,
  emailClearActionSchema,
  appwriteVerifyEmailActionSchema,
  debugActionSchema,
  waitForSelectorActionSchema,
  logActionSchema,
  failActionSchema,
  evaluateActionSchema,
]);

const TrackableBaseActionSchema = z.intersection(BaseActionSchema, trackableSchema);

const conditionalActionSchema = z.intersection(z.object({
  type: z.literal('conditional'),
  condition: z.object({
    type: z.enum(['exists', 'notExists', 'visible', 'hidden']),
    target: LocatorSchema,
  }).describe('Condition to check'),
  then: z.array(TrackableBaseActionSchema).describe('Steps to execute if condition is true'),
  else: z.array(TrackableBaseActionSchema).optional().describe('Steps to execute if condition is false'),
}).describe('Execute steps conditionally based on element state'), trackableSchema);

// Branch definition - can be inline actions OR a workflow file reference
const branchSchema = z.union([
  z.array(TrackableBaseActionSchema),  // Inline actions
  z.object({
    workflow: z.string().trim().min(1).describe('Path to workflow file relative to current file'),
    variables: z.record(z.string(), z.string()).optional().describe('Variables to pass to the workflow'),
  }),
]).describe('Actions to execute - either inline steps or a workflow file reference');

const waitForBranchActionSchema = z.intersection(z.object({
  type: z.literal('waitForBranch'),
  target: LocatorSchema.describe('Element to wait for'),
  timeout: z.number().int().positive().optional().describe('Maximum time to wait for element in milliseconds (default: 30000)'),
  state: z.enum(['visible', 'attached', 'enabled']).optional().describe('Element state to wait for (default: visible)'),
  onAppear: branchSchema.describe('Actions to execute when element appears within timeout'),
  onTimeout: branchSchema.optional().describe('Actions to execute if timeout occurs (silent continue if omitted)'),
  pollInterval: z.number().int().positive().optional().describe('How often to check for element in milliseconds (default: 100)'),
}).describe('Wait for an element and branch based on whether it appears or times out'), trackableSchema);

export const ActionSchema = z.union([TrackableBaseActionSchema, conditionalActionSchema, waitForBranchActionSchema]);

const defaultsSchema = z.object({
  timeout: z.number().int().positive().optional().describe('Default timeout in milliseconds for all actions'),
  screenshots: z.enum(['on-failure', 'always', 'never']).optional().describe('When to capture screenshots during test execution'),
}).describe('Default settings that apply to all tests unless overridden');

const webConfigSchema = z.object({
  baseUrl: optionalUrl.describe('Base URL for the web application'),
  browser: z.string().trim().optional().describe('Browser to use for testing'),
  headless: z.boolean().optional().describe('Run browser in headless mode'),
  timeout: z.number().int().positive().optional().describe('Timeout in milliseconds for web actions'),
  storageState: z.union([
    z.string(),
    z.object({
      cookies: z.array(z.any()).optional(),
      origins: z.array(z.any()).optional(),
    }).passthrough(),
  ]).optional().describe('Playwright storageState: file path (string) or inline {cookies, origins} object. Maps to browser.newContext({ storageState }).'),
}).describe('Web platform configuration');

const androidConfigSchema = z.object({
  appId: z.string().trim().optional().describe('Android application ID'),
  device: z.string().trim().optional().describe('Device name or ID to run tests on'),
}).describe('Android platform configuration');

const iosConfigSchema = z.object({
  bundleId: z.string().trim().optional().describe('iOS bundle identifier'),
  simulator: z.string().trim().optional().describe('Simulator name to run tests on'),
}).describe('iOS platform configuration');

const emailConfigSchema = z.object({
  provider: z.literal('inbucket').describe('Email testing provider'),
  endpoint: optionalUrl.describe('Email service endpoint URL'),
}).describe('Email testing configuration');

const appwriteConfigSchema = z.object({
  endpoint: nonEmptyString.url().describe('Appwrite API endpoint'),
  projectId: nonEmptyString.describe('Appwrite project ID'),
  apiKey: nonEmptyString.describe('Appwrite API key with appropriate permissions'),
  cleanup: z.boolean().optional().describe('Enable automatic cleanup of created resources'),
  cleanupOnFailure: z.boolean().optional().describe('Clean up resources even when test fails'),
}).describe('Appwrite backend configuration');

const healingSchema = z.object({
  enabled: z.boolean().optional().describe('Enable AI-assisted test healing on failures'),
  maxAttempts: z.number().int().min(1).max(10).default(3).describe('Maximum AI healing attempts per failure (default: 3)'),
  strategies: z.array(z.string().trim()).optional().describe('Healing strategies to use'),
}).describe('AI-assisted test healing configuration');

export const webServerEntrySchema = z
  .object({
    name: nonEmptyString.optional().describe('Identifier used in logs and the marker file (defaults to server-1, server-2, ...)'),
    command: nonEmptyString.optional().describe('Command to start the web server'),
    auto: z.boolean().optional().describe('Automatically detect and run the dev server from package.json'),
    static: z.string().optional().describe('Serve a static directory instead of running a command'),
    url: nonEmptyString.url().describe('URL to wait for before this server is considered ready'),
    port: z.number().int().positive().optional().describe('Port number for the web server'),
    reuseExistingServer: z.boolean().default(true).describe('Reuse an existing server already running at the URL'),
    timeout: z.number().int().positive().default(30000).describe('Timeout in milliseconds to wait for server to become available'),
    workdir: z.string().optional().describe('Working directory for the server command'),
    cwd: z.string().optional().describe('Deprecated: use workdir instead'),
  })
  .describe('Configuration for a single web server process')
  .refine((config) => config.command || config.auto || config.static, {
    message: 'WebServerConfig requires command, auto: true, or static directory',
  });

// `webServer` accepts either a single object (existing single-process behaviour)
// or an array of entries (new). Array entries are started sequentially in order,
// each waits for its `url` to respond before the next is started.
const webServerSchema = z.union([
  webServerEntrySchema,
  z.array(webServerEntrySchema).min(1).describe('Ordered list of dev processes to start before tests (e.g. API then frontend)'),
]);

const aiSourceSchema = z.object({
  pagesDir: z.string().optional().describe('Directory containing page components'),
  componentsDir: z.string().optional().describe('Directory containing reusable components'),
  extensions: z.array(z.string()).default(['.vue', '.astro', '.tsx', '.jsx', '.svelte']).describe('File extensions to include in source code analysis'),
}).optional().describe('Source code directories for AI to analyze when generating tests');

export const defaultModelForProvider = (provider: string): string => {
  switch (provider) {
    case 'anthropic': return 'claude-haiku-4-5-20251001';
    case 'openrouter': return 'anthropic/claude-haiku-4.5';
    case 'openai': return 'gpt-4o-mini';
    case 'gemini': return 'gemini-2.5-flash';
    case 'groq': return 'llama-3.1-8b-instant';
    case 'together': return 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
    case 'mistral': return 'mistral-small-latest';
    case 'deepseek': return 'deepseek-chat';
    case 'fireworks': return 'accounts/fireworks/models/llama-v3p3-70b-instruct';
    case 'perplexity': return 'sonar';
    case 'xai': return 'grok-2-latest';
    case 'cohere': return 'command-r-plus';
    case 'fal': return 'anthropic/claude-haiku-4.5';
    case 'ollama': return 'llama3.2:3b';
    case 'lmStudio': return 'local-model';
    // azure, bedrock, openaiCompat require explicit model — no sensible default
    default: return 'claude-haiku-4-5-20251001';
  }
};

const aiConfigSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS).describe('AI provider to use for test generation'),
  model: z.string().trim().optional().describe('Model name to use (defaults based on provider if omitted)'),
  apiKey: z.string().trim().optional().describe('API key for the AI provider (supports ${ENV_VAR} syntax)'),
  baseUrl: optionalUrl.describe('Base URL for the AI API (required for Ollama, auto-set for groq/openrouter)'),
  temperature: z.number().min(0).max(2).default(0.2).describe('Temperature for AI generation (0 = deterministic, 2 = very creative)'),
  maxTokens: z.number().int().positive().default(4096).describe('Maximum tokens for AI responses'),
  providerOptions: z.record(z.string(), z.unknown()).optional().describe('Extra provider-specific options passed verbatim to the Blazen factory (e.g., azure resourceName/deploymentName, bedrock region, fal endpoint, ollama host/port, openaiCompat providerName/defaultModel). Supports ${ENV_VAR} substitution in string values.'),
  source: aiSourceSchema,
}).describe('AI configuration for test generation and healing');

// Cleanup discovery configuration
export const cleanupDiscoverSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable auto-discovery of cleanup handlers in specified paths'),
  paths: z.array(z.string()).default(['./tests/cleanup']).describe('Directories to search for cleanup handler files'),
  pattern: z.string().default('**/*.ts').describe('Glob pattern to match handler files'),
}).optional().describe('Auto-discovery configuration for cleanup handlers');

// Main cleanup configuration
export const cleanupConfigSchema = z.object({
  provider: z.string().optional().describe('Primary cleanup provider to use'),
  parallel: z.boolean().default(false).describe('Execute cleanup operations in parallel'),
  retries: z.number().min(1).max(10).default(3).describe('Number of retry attempts for failed cleanup operations'),
  types: z.record(z.string(), z.string()).optional().describe('Map resource types to cleanup handler methods'),
  handlers: z.array(z.string()).optional().describe('Explicit paths to custom cleanup handler files'),
  discover: cleanupDiscoverSchema,
  scanUntracked: z.boolean().optional().describe('Scan for untracked resources using provider heuristics'),
}).passthrough().describe('Comprehensive resource cleanup configuration'); // Allow provider-specific configs like appwrite: {...}

// Export the inferred type
export type CleanupConfig = z.infer<typeof cleanupConfigSchema>;

const platformsSchema = z.object({
  web: webConfigSchema.optional(),
  android: androidConfigSchema.optional(),
  ios: iosConfigSchema.optional(),
}).describe('Platform-specific configurations');

// Preview configuration for --preview flag
export const previewConfigSchema = z.object({
  build: z.object({
    command: z.string().optional().describe('Command to build the project'),
  }).optional().describe('Build configuration'),
  preview: z.object({
    command: z.string().optional().describe('Command to start the preview server after build'),
  }).optional().describe('Preview server configuration'),
  url: optionalUrl.describe('URL to wait for before starting tests'),
  timeout: z.number().int().positive().optional().describe('Timeout in milliseconds to wait for preview server'),
}).describe('Configuration for the --preview flag (build and serve production build)');

export const TestConfigSchema = z.object({
  defaults: defaultsSchema.optional(),
  web: webConfigSchema.optional(),
  android: androidConfigSchema.optional(),
  ios: iosConfigSchema.optional(),
  email: emailConfigSchema.optional(),
  appwrite: appwriteConfigSchema.optional(),
  healing: healingSchema.optional(),
  ai: aiConfigSchema.optional(),
}).describe('Test-specific configuration that overrides global settings');

export const TestDefinitionSchema = z.object({
  name: nonEmptyString.describe('The name of the test'),
  platform: z.enum(['web', 'android', 'ios']).describe('The platform to run the test on'),
  variables: z.record(z.string(), z.string()).optional().describe('Variables that can be referenced in test steps using ${VARIABLE_NAME} syntax'),
  config: TestConfigSchema.optional(),
  steps: z.array(ActionSchema).min(1).describe('The sequence of actions to execute in this test'),
}).describe('Schema for IntelliTester test definition files');

export const IntellitesterConfigSchema = z.object({
  defaults: defaultsSchema.optional(),
  ai: aiConfigSchema.optional(),
  platforms: platformsSchema.optional(),
  healing: healingSchema.optional(),
  email: emailConfigSchema.optional(),
  appwrite: appwriteConfigSchema.optional(),
  cleanup: cleanupConfigSchema.optional(),
  webServer: webServerSchema.optional(),
  preview: previewConfigSchema.optional(),
  secrets: z.record(z.string(), z.string().trim()).optional().describe('Secret values that can be referenced in tests'),
}).describe('Global configuration file for IntelliTester');
