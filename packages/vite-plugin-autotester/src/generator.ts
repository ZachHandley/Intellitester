import type { ComponentInfo } from './types';

/**
 * Generates a test stub YAML content for a component
 * @param component Component information
 * @param baseUrl Base URL for the application (optional)
 * @returns YAML test stub content
 */
export function generateTestStub(component: ComponentInfo, baseUrl?: string): string {
  const { name, relativePath } = component;

  // Create a simple test stub following AutoTester's TestDefinitionSchema
  const yaml = `# Auto-generated test stub for ${name}
# Component: ${relativePath}
#
# This is a template - customize the steps based on your component's behavior
# See AutoTester docs for available actions and locators

name: ${name} Component Test
platform: web

config:
  web:
    baseUrl: ${baseUrl || 'http://localhost:5173'}
    headless: false
    timeout: 30000

steps:
  # Navigate to the page/component
  - type: navigate
    value: /  # Update this to the correct route

  # Example: Wait for component to be visible
  # - type: wait
  #   target:
  #     testId: ${name.toLowerCase()}-component
  #   timeout: 5000

  # Example: Interact with the component
  # - type: tap
  #   target:
  #     testId: button-submit

  # Example: Fill in an input
  # - type: input
  #   target:
  #     testId: input-name
  #   value: Test User

  # Example: Assert expected state
  # - type: assert
  #   target:
  #     testId: result-message
  #   value: Success

  # Example: Take a screenshot
  - type: screenshot
    name: ${name.toLowerCase()}-initial-state
`;

  return yaml;
}

/**
 * Generates a comprehensive test suite with multiple test cases
 * @param components Array of components to generate tests for
 * @param baseUrl Base URL for the application
 * @returns Array of test stubs (one per component)
 */
export function generateTestSuite(components: ComponentInfo[], baseUrl?: string): Map<string, string> {
  const testSuite = new Map<string, string>();

  for (const component of components) {
    const testContent = generateTestStub(component, baseUrl);
    testSuite.set(component.name, testContent);
  }

  return testSuite;
}

/**
 * Checks if a test file already exists and needs updating
 * @param existingContent Existing test file content
 * @param newContent New test stub content
 * @returns true if content should be updated
 */
export function shouldUpdateTest(existingContent: string, newContent: string): boolean {
  // Don't overwrite if the file has been customized
  // Check if it still contains the auto-generated comment
  if (!existingContent.includes('# Auto-generated test stub')) {
    return false;
  }

  // Only update if the structure has changed significantly
  return existingContent !== newContent;
}
