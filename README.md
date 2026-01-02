# IntelliTester

Uses AI + iOS or Android emulators / web browsers to create automated test suites using simple instructions

## Prerequisites

Before running web tests with IntelliTester, you need to install Playwright browsers:

```bash
npx playwright install chromium
# Or for all browsers:
npx playwright install
```

## Editor Configuration

IntelliTester provides JSON schemas for YAML configuration files to enable autocomplete and validation in VS Code and other editors.

### VS Code Setup

Add this to your `.vscode/settings.json` (or workspace settings):

```json
{
  "yaml.schemas": {
    "./node_modules/intellitester/schemas/intellitester.config.schema.json": "intellitester.config.yaml",
    "./node_modules/intellitester/schemas/test.schema.json": "*.test.yaml",
    "./node_modules/intellitester/schemas/workflow.schema.json": "*.workflow.yaml"
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
    "./schemas/workflow.schema.json": "*.workflow.yaml"
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