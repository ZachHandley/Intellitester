# IntelliTester

Uses AI + iOS or Android emulators / web browsers to create automated test suites using simple instructions

## Prerequisites

Before running web tests with IntelliTester, you need to install Playwright browsers:

```bash
npx playwright install chromium
# Or for all browsers:
npx playwright install
```

## AI Assistant Integration

IntelliTester can generate comprehensive documentation for AI assistants (Claude, GPT, etc.) to help them write effective tests.

### Generate Guide

Use the `guide` command to create an `intellitester_guide.md` file in your project:

```bash
intellitester guide
# Or use the alias:
intellitester init-guide
```

This generates a detailed reference document that AI assistants can read to understand:
- All action types and their syntax
- Target selector options (testId, text, css, xpath, role, description)
- Variable interpolation and built-in generators
- Best practices for test organization
- Common testing patterns (login flows, form submissions, email verification)
- Configuration options for tests, workflows, and pipelines

The guide is particularly useful when:
- Using AI assistants to generate test files
- Onboarding team members who use AI coding tools
- Maintaining consistent test patterns across a team

## Editor Configuration

IntelliTester provides JSON schemas for YAML configuration files to enable autocomplete and validation in VS Code and other editors.

### VS Code Setup

Add this to your `.vscode/settings.json` (or workspace settings):

```json
{
  "yaml.schemas": {
    "./node_modules/intellitester/schemas/intellitester.config.schema.json": "intellitester.config.yaml",
    "./node_modules/intellitester/schemas/test.schema.json": "*.test.yaml",
    "./node_modules/intellitester/schemas/workflow.schema.json": "*.workflow.yaml",
    "./node_modules/intellitester/schemas/pipeline.schema.json": "*.pipeline.yaml"
  }
}
```

This enables:
- Auto-completion for all configuration properties
- Inline documentation and examples
- Real-time validation and error checking
- Type checking for action steps and configurations

### Using Local Development Schemas

If you're working on IntelliTester itself or want to use local schemas, use these paths instead:

```json
{
  "yaml.schemas": {
    "./schemas/intellitester.config.schema.json": "intellitester.config.yaml",
    "./schemas/test.schema.json": "*.test.yaml",
    "./schemas/workflow.schema.json": "*.workflow.yaml",
    "./schemas/pipeline.schema.json": "*.pipeline.yaml"
  }
}
```

## Debugging

IntelliTester provides powerful debugging capabilities to help troubleshoot failing tests.

### Debug Mode

Run tests with the `--debug` flag to pause execution on failure and open the Playwright Inspector:

```bash
# Run with debug mode - pauses on failure
intellitester run tests/login.test.yaml --headed --debug
```

### Debug Action Type

Add breakpoints directly in your test files using the `debug` action type. This pauses execution and opens the Playwright Inspector at that specific step:

```yaml
# Add breakpoints in your test
steps:
  - type: navigate
    value: /signup
  - type: debug  # Pauses here, opens Playwright Inspector
  - type: input
    target: { testId: email }
    value: test@example.com
```

When execution pauses, you can:
- Inspect the current page state
- Step through actions manually
- Examine selectors and elements
- Continue execution when ready

## Iframe Targeting (frame)

Target elements inside iframes using the `frame` property. Essential for payment forms (Stripe, PayPal), embedded widgets, and third-party integrations.

```yaml
steps:
  # Wait for Stripe iframe to load
  - type: wait
    target: { css: "div.__PrivateStripeElement iframe" }
    timeout: 10000

  # Type card number inside iframe
  - type: type
    target: { css: "[placeholder='Card number']" }
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: "4242424242424242"
    delay: 50

  # Type expiry inside iframe
  - type: type
    target: { css: "[placeholder='MM / YY']" }
    frame:
      css: "div.__PrivateStripeElement iframe"
      index: 0
    value: "12/34"
```

**Frame locator properties:**

| Property | Description |
|----------|-------------|
| `css` | CSS selector for the iframe element |
| `name` | Name or id attribute of the iframe |
| `index` | Zero-based index when multiple iframes match (default: 0) |

**Supported actions:** `tap`, `input`, `type`, `clear`, `hover`, `press`, `focus`, `assert`, `wait`, `waitForSelector`

## Character-by-Character Typing (type)

Use the `type` action for inputs that require character-by-character entry (like Stripe payment fields, autocomplete, or inputs with per-keystroke validation). Unlike `input` which clears first, `type` appends characters one at a time.

```yaml
steps:
  # Use 'type' for Stripe (validates each keystroke)
  - type: type
    target: { testId: card-number }
    value: "4242424242424242"
    delay: 50  # ms between keystrokes (default: 50)

  # Use 'input' for normal form fields (faster, clears first)
  - type: input
    target: { testId: email }
    value: "test@example.com"
```

## Fast-Fail Conditions (errorIf)

Use `errorIf` to fail a step immediately when a condition is met, without waiting for timeouts:

```yaml
steps:
  - type: tap
    target: { testId: login-btn }
    errorIf: not-found  # Fail immediately if element not found

  - type: assert
    target: { testId: welcome-msg }
    errorIf: not-visible  # Fail if element exists but not visible

  - type: input
    target: { testId: email }
    value: test@example.com
    errorIf: disabled  # Fail if input is disabled
```

**Available conditions:**

| Condition | Description |
|-----------|-------------|
| `not-found` | Element doesn't exist in DOM |
| `not-visible` | Element exists but not visible |
| `disabled` | Element is disabled |
| `empty` | Element has no text content |

> **Note:** `testId` now matches `data-testid`, `id`, and `class` attributes in that order.

## Resource Cleanup

IntelliTester automatically tracks resources created during tests and cleans them up after execution. This ensures tests don't leave behind database rows, files, users, or other artifacts.

### Built-in Providers

IntelliTester includes cleanup providers for common backends:

- **Appwrite** - Delete rows, files, teams, users, memberships
- **PostgreSQL** - Delete rows and users
- **MySQL** - Delete rows and users
- **SQLite** - Delete rows and users

### Configuration

Configure cleanup in your test YAML files or global config:

```yaml
# Using Appwrite (backwards compatible)
appwrite:
  endpoint: https://cloud.appwrite.io/v1
  projectId: ${APPWRITE_PROJECT_ID}
  apiKey: ${APPWRITE_API_KEY}
  cleanup: true
  cleanupOnFailure: true

# Or using the new cleanup config
cleanup:
  provider: appwrite
  parallel: false      # Sequential cleanup by default
  retries: 3           # Retry failed deletions

  # Provider-specific configuration
  appwrite:
    endpoint: ${APPWRITE_ENDPOINT}
    projectId: ${APPWRITE_PROJECT_ID}
    apiKey: ${APPWRITE_API_KEY}

  # Map resource types to cleanup methods
  types:
    row: appwrite.deleteRow
    team: appwrite.deleteTeam
    stripe_customer: stripe.deleteCustomer

  # Explicit handler files to load
  handlers:
    - ./src/cleanup/stripe.ts

  # Auto-discover handlers (enabled by default)
  discover:
    enabled: true
    paths:
      - ./tests/cleanup
    pattern: "**/*.ts"
```

### Custom Cleanup Handlers

Create custom handlers for resources not covered by built-in providers:

```typescript
// intellitester.cleanup.ts (auto-discovered at project root)
import { defineCleanupHandlers } from 'intellitester/cleanup';
import Stripe from 'stripe';

export default defineCleanupHandlers({
  stripe_customer: async (resource) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    await stripe.customers.del(resource.id);
  },

  stripe_subscription: async (resource) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    await stripe.subscriptions.cancel(resource.id);
  },
});
```

Handlers are loaded in this order (later definitions override earlier ones):

1. Built-in provider methods (e.g., `appwrite.deleteRow`)
2. `intellitester.cleanup.ts` at project root
3. Files in discovery paths (default: `tests/cleanup/**/*.ts`)
4. Explicit handler files from config

### Tracking Resources

In your app's server-side code, track resources for cleanup:

```typescript
import { track } from 'intellitester/integration';

// Track a database row
await track({
  type: 'row',
  id: row.$id,
  databaseId: 'main',
  tableId: 'users',
});

// Track a team
await track({
  type: 'team',
  id: team.$id,
});

// Track a custom resource (requires custom handler)
await track({
  type: 'stripe_customer',
  id: customer.id,
});
```

The `track()` function is production-safe - it's a no-op if the required environment variables aren't set. IntelliTester sets these automatically during test execution.

### File-Based Tracking (Fallback)

IntelliTester can persist tracked resources to disk in addition to (or instead of) the in-memory tracking server. This helps recover from interrupted runs and enables cleanup even if the tracking server is unavailable.

By default, the executor sets:

- `INTELLITESTER_TRACK_FILE` to a JSONL file in `.intellitester/track/TEST_SESSION_<id>.jsonl`
- `.intellitester/track/ACTIVE_TESTS.json` for heartbeats and stale session pruning

You can override the session ID or tracking directory:

```bash
intellitester run --session-id my-session --track-dir .intellitester/track
```

If `INTELLITESTER_TRACK_URL` is set, `track()` will send HTTP requests and also append to the track file (when available). If only the file is set, `track()` writes locally.

## Pipelines & Workflows

IntelliTester supports three levels of test organization:

### Test Files (`*.test.yaml`)

A single test with a sequence of steps. The most basic building block.

```yaml
name: Login Test
platform: web
variables:
  EMAIL: test@example.com
steps:
  - type: navigate
    value: /login
  - type: input
    target: { testId: email }
    value: ${EMAIL}
  - type: input
    target: { testId: password }
    value: secret123
  - type: tap
    target: { text: Sign In }
  - type: assert
    target: { text: Welcome }
```

### Workflows (`*.workflow.yaml`)

Multiple tests run in sequence with a shared browser session. Tests share cookies, local storage, and authentication state.

```yaml
name: User Onboarding
platform: web
config:
  web:
    baseUrl: http://localhost:3000
continueOnFailure: false
tests:
  - file: ./signup.test.yaml
    id: signup
  - file: ./verify-email.test.yaml
    id: verify
    variables:
      EMAIL: ${signup.EMAIL}
  - file: ./complete-profile.test.yaml
```

### Pipelines (`*.pipeline.yaml`)

Multiple workflows with shared browser session, dependencies, and variables. Pipelines orchestrate complex test suites with control over execution order and failure handling.

```yaml
name: Full E2E Suite
platform: web
on_failure: skip  # skip | fail | ignore
cleanup_on_failure: true
config:
  web:
    baseUrl: http://localhost:3000
  webServer:
    command: npm run dev
    url: http://localhost:3000
    reuseExistingServer: true
    timeout: 30000
workflows:
  - file: ./auth.workflow.yaml
    id: auth
    on_failure: fail  # Stop pipeline if auth fails

  - file: ./dashboard.workflow.yaml
    id: dashboard
    depends_on: [auth]
    variables:
      USER_TOKEN: ${auth.TOKEN}

  - file: ./settings.workflow.yaml
    depends_on: [auth]
    on_failure: ignore  # Continue even if settings tests fail

  - file: ./cleanup.workflow.yaml
    depends_on: [dashboard, settings]
```

### Pipeline Features

**Workflow Properties:**

| Property | Description |
|----------|-------------|
| `file` | Path to the workflow file (required) |
| `id` | Identifier for referencing in `depends_on` and variable passing |
| `depends_on` | Array of workflow IDs that must complete first |
| `variables` | Variables to inject, can reference outputs from dependencies |
| `on_failure` | How to handle failure: `skip`, `fail`, or `ignore` |

**Failure Handling (`on_failure`):**

- `skip` - Skip dependent workflows, continue independent ones (default)
- `fail` - Stop the entire pipeline immediately
- `ignore` - Continue as if the workflow succeeded

**Web Server (`config.webServer`):**

Start a dev server automatically before running tests:

```yaml
config:
  webServer:
    command: npm run dev        # Command to start server
    url: http://localhost:3000  # Wait for this URL
    reuseExistingServer: true   # Use existing if running
    timeout: 30000              # Startup timeout (ms)
```

**Shared Browser Session:**

All workflows in a pipeline share the same browser context, preserving:
- Cookies and session storage
- Authentication state
- Local storage data

## Responsive Testing (Viewport Sizes)

IntelliTester can run tests across multiple viewport sizes to ensure your application works correctly on different devices.

### Named Sizes

Use Tailwind-style breakpoint names:

| Size | Width | Height | Device Type |
|------|-------|--------|-------------|
| `xs` | 320 | 568 | Mobile portrait |
| `sm` | 640 | 800 | Small tablet |
| `md` | 768 | 1024 | Tablet |
| `lg` | 1024 | 768 | Desktop |
| `xl` | 1280 | 720 | Large desktop |

### Custom Sizes

Use `WIDTHxHEIGHT` format for custom dimensions:

```bash
intellitester run tests/ --test-sizes 1920x1080,375x812,414x896
```

### CLI Usage

```bash
# Run tests at all breakpoints
intellitester run tests/ --test-sizes xs,sm,md,lg,xl

# Run at specific sizes
intellitester run app.workflow.yaml --test-sizes xs,md,xl

# Mix named and custom sizes
intellitester run tests/ --test-sizes xs,1920x1080
```

### YAML Configuration

**Workflow-level:**

```yaml
name: Responsive Tests
platform: web
config:
  web:
    baseUrl: http://localhost:3000
    testSizes: ['xs', 'sm', 'md', 'lg', 'xl']
tests:
  - file: ./homepage.test.yaml
  - file: ./navigation.test.yaml
```

**Pipeline-level:**

```yaml
name: Full Responsive Suite
platform: web
config:
  web:
    testSizes: ['xs', 'md', 'xl']
workflows:
  - file: ./auth.workflow.yaml
  - file: ./dashboard.workflow.yaml
```

### Behavior

- Tests run once per specified viewport size
- Results are prefixed with size when multiple sizes are tested: `[xs] test.yaml`, `[md] test.yaml`
- Browser session (cookies, authentication state) is preserved across sizes
- Browser context is recreated for each size with new viewport dimensions

## Configuration Inheritance

IntelliTester uses a cascading configuration system. Lower-level configuration takes precedence over higher levels.

### Priority Order

```
Test Config > Workflow Config > Pipeline Config > Global Config > Defaults
     ↑              ↑                ↑                 ↑            ↑
  Highest                                                        Lowest
```

### Configuration Levels

**1. Global Config (`intellitester.yaml`):**

```yaml
defaults:
  timeout: 30000
  screenshots: on-failure

platforms:
  web:
    baseUrl: http://localhost:3000
    headless: true
```

**2. Pipeline Config (`.pipeline.yaml`):**

```yaml
config:
  web:
    headless: false  # Overrides global
    testSizes: ['xs', 'md', 'xl']
```

**3. Workflow Config (`.workflow.yaml`):**

```yaml
config:
  web:
    baseUrl: http://localhost:4000  # Overrides pipeline/global
```

**4. Test Config (`.test.yaml`):**

```yaml
config:
  defaults:
    timeout: 60000  # Overrides for this test only
```

### Configuration Options

| Setting | Test | Workflow | Pipeline | Global |
|---------|------|----------|----------|--------|
| `baseUrl` | Yes | Yes | Yes | Yes |
| `browser` | Yes | Yes | Yes | Yes |
| `headless` | Yes | Yes | Yes | Yes |
| `timeout` | Yes | Yes | Yes | Yes |
| `testSizes` | - | Yes | Yes | - |
| `webServer` | - | Yes | Yes | Yes |
| `appwrite` | Yes | Yes | Yes | Yes |
| `cleanup` | Yes | Yes | Yes | Yes |
| `email` | Yes | Yes | Yes | Yes |

### Important Notes

- Configuration uses **simple override**, not deep merge
- CLI flags (e.g., `--headed`, `--test-sizes`) override all YAML configuration
- Environment variables (`${VAR_NAME}`) are resolved at load time
