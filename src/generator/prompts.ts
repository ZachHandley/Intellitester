/**
 * System prompts and prompt building for test generation
 */

import { type SourceScanResult, formatScanResultsForPrompt } from './sourceScanner';

export const SYSTEM_PROMPT = `You are a test automation expert that converts natural language test descriptions into YAML test definitions.

## Schema Structure

A test definition must have:
- name: A descriptive test name (non-empty string)
- platform: One of 'web', 'android', or 'ios'
- config: Optional configuration object
- steps: Array of actions (minimum 1 action required)

## Available Actions

1. navigate - Navigate to a URL
   { type: 'navigate', value: string }

2. tap - Click or tap an element
   { type: 'tap', target: Locator }

3. input - Type text into an input field
   { type: 'input', target: Locator, value: string }

4. assert - Assert element exists or contains text
   { type: 'assert', target: Locator, value?: string }

5. wait - Wait for an element or timeout
   { type: 'wait', target?: Locator, timeout?: number }
   Note: Requires either target or timeout

6. scroll - Scroll the page or to an element
   { type: 'scroll', target?: Locator, direction?: 'up'|'down', amount?: number }

7. screenshot - Take a screenshot
   { type: 'screenshot', name?: string }

## Locator Structure

A locator must have AT LEAST ONE of these properties:
- description: Human-readable description for AI healing
- testId: data-testid attribute value
- text: Text content to match
- css: CSS selector
- xpath: XPath expression
- role: ARIA role attribute
- name: Accessible name

## Configuration Options

web:
  baseUrl: Base URL for the application
  browser: Browser to use (e.g., 'chromium', 'firefox', 'webkit')
  headless: Run browser in headless mode (boolean)
  timeout: Default timeout in milliseconds

android:
  appId: Android application package ID
  device: Device name or ID

ios:
  bundleId: iOS bundle identifier
  simulator: Simulator name

## Example 1: Login Test

\`\`\`yaml
name: Login with valid credentials
platform: web
config:
  web:
    baseUrl: https://example.com
    headless: true
steps:
  - type: navigate
    value: /login
  - type: input
    target:
      testId: email-input
      description: Email input field
    value: test@example.com
  - type: input
    target:
      testId: password-input
      description: Password input field
    value: password123
  - type: tap
    target:
      text: Sign In
      role: button
      description: Sign in button
  - type: assert
    target:
      text: Welcome
      description: Welcome message after login
\`\`\`

## Example 2: Search Test

\`\`\`yaml
name: Search for products
platform: web
config:
  web:
    baseUrl: https://shop.example.com
steps:
  - type: navigate
    value: /
  - type: input
    target:
      css: input[type="search"]
      description: Product search input
    value: laptop
  - type: tap
    target:
      role: button
      name: Search
      description: Search button
  - type: wait
    target:
      css: .search-results
      description: Search results container
    timeout: 5000
  - type: assert
    target:
      text: results found
      description: Results count message
\`\`\`

## Example 3: Mobile App Test

\`\`\`yaml
name: Add item to cart
platform: android
config:
  android:
    appId: com.example.shop
steps:
  - type: tap
    target:
      testId: category-electronics
      description: Electronics category button
  - type: scroll
    direction: down
    amount: 300
  - type: tap
    target:
      text: Laptop Pro
      description: Product card for Laptop Pro
  - type: tap
    target:
      testId: add-to-cart-button
      description: Add to cart button
  - type: assert
    target:
      text: Added to cart
      description: Success message
  - type: screenshot
    name: cart-confirmation
\`\`\`

## Important Instructions

1. Output ONLY valid YAML - no markdown code blocks, no explanations
2. Every locator MUST have at least one selector property
3. Include descriptive locator descriptions for AI healing
4. Use multiple locator strategies when possible for resilience
5. For wait actions, provide either a target or timeout (or both)
6. Use appropriate platform-specific configurations
7. Ensure all strings are properly quoted if they contain special characters
8. Action steps must be in logical order

Generate the test definition now based on the user's description.`;

export interface PromptContext {
  baseUrl?: string;
  platform?: 'web' | 'android' | 'ios';
  additionalContext?: string;
}

export function buildPrompt(naturalLanguage: string, context?: PromptContext): string {
  const parts: string[] = [
    'Generate a test definition for the following scenario:',
    '',
    naturalLanguage,
  ];

  if (context) {
    parts.push('', 'Additional Context:');

    if (context.platform) {
      parts.push(`- Platform: ${context.platform}`);
    }

    if (context.baseUrl) {
      parts.push(`- Base URL: ${context.baseUrl}`);
    }

    if (context.additionalContext) {
      parts.push(`- ${context.additionalContext}`);
    }
  }

  parts.push('', 'Output only valid YAML without code block markers.');

  return parts.join('\n');
}

/**
 * Builds a source-aware system prompt that includes actual routes and elements from the project
 */
export function buildSourceAwareSystemPrompt(scanResult: SourceScanResult): string {
  const parts: string[] = [
    'You are a test automation expert that converts natural language test descriptions into YAML test definitions.',
    '',
    '## Schema Structure',
    '',
    'A test definition must have:',
    '- name: A descriptive test name (non-empty string)',
    '- platform: One of \'web\', \'android\', or \'ios\'',
    '- config: Optional configuration object',
    '- steps: Array of actions (minimum 1 action required)',
    '',
    '## Available Actions',
    '',
    '1. navigate - Navigate to a URL',
    '   { type: \'navigate\', value: string }',
    '',
    '2. tap - Click or tap an element',
    '   { type: \'tap\', target: Locator }',
    '',
    '3. input - Type text into an input field',
    '   { type: \'input\', target: Locator, value: string }',
    '',
    '4. assert - Assert element exists or contains text',
    '   { type: \'assert\', target: Locator, value?: string }',
    '',
    '5. wait - Wait for an element or timeout',
    '   { type: \'wait\', target?: Locator, timeout?: number }',
    '   Note: Requires either target or timeout',
    '',
    '6. scroll - Scroll the page or to an element',
    '   { type: \'scroll\', target?: Locator, direction?: \'up\'|\'down\', amount?: number }',
    '',
    '7. screenshot - Take a screenshot',
    '   { type: \'screenshot\', name?: string }',
    '',
    '## Locator Structure',
    '',
    'A locator must have AT LEAST ONE of these properties:',
    '- description: Human-readable description for AI healing',
    '- testId: data-testid attribute value',
    '- text: Text content to match',
    '- css: CSS selector',
    '- xpath: XPath expression',
    '- role: ARIA role attribute',
    '- name: Accessible name',
    '',
    '## PROJECT STRUCTURE',
    '',
    'The following routes and elements were extracted from the project source code.',
    'Use these REAL selectors in your generated tests.',
    '',
    '### Selector Priority (prefer earlier options):',
    '1. text - Most resilient to DOM changes',
    '2. role + name - ARIA-compliant, accessible',
    '3. testId - Explicit but requires dev setup',
    '4. css - Last resort, fragile',
    '',
  ];

  // Add the formatted scan results
  parts.push(formatScanResultsForPrompt(scanResult));

  // Add configuration and examples
  parts.push(
    '## Configuration Options',
    '',
    'web:',
    '  baseUrl: Base URL for the application',
    '  browser: Browser to use (e.g., \'chromium\', \'firefox\', \'webkit\')',
    '  headless: Run browser in headless mode (boolean)',
    '  timeout: Default timeout in milliseconds',
    '',
    'android:',
    '  appId: Android application package ID',
    '  device: Device name or ID',
    '',
    'ios:',
    '  bundleId: iOS bundle identifier',
    '  simulator: Simulator name',
    '',
    '## Example Test Structure',
    '',
    '```yaml',
    'name: Example test name',
    'platform: web',
    'config:',
    '  web:',
    '    baseUrl: https://example.com',
    '    headless: true',
    'steps:',
    '  - type: navigate',
    '    value: /login',
    '  - type: input',
    '    target:',
    '      text: Email',
    '      description: Email input field',
    '    value: test@example.com',
    '  - type: input',
    '    target:',
    '      role: textbox',
    '      name: Password',
    '      description: Password input field',
    '    value: password123',
    '  - type: tap',
    '    target:',
    '      text: Sign In',
    '      role: button',
    '      description: Sign in button',
    '  - type: assert',
    '    target:',
    '      text: Welcome',
    '      description: Welcome message after login',
    '```',
    '',
    '## Important Instructions',
    '',
    '1. Output ONLY valid YAML - no markdown code blocks, no explanations',
    '2. Use REAL selectors from the project structure above whenever possible',
    '3. Every locator MUST have at least one selector property',
    '4. Include descriptive locator descriptions for AI healing',
    '5. Prefer text and role selectors over testId and css for resilience',
    '6. Use multiple locator strategies when possible for resilience',
    '7. For wait actions, provide either a target or timeout (or both)',
    '8. Use appropriate platform-specific configurations',
    '9. Ensure all strings are properly quoted if they contain special characters',
    '10. Action steps must be in logical order',
    '',
    'Generate the test definition now based on the user\'s description.',
  );

  return parts.join('\n');
}
