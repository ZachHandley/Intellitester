# AutoTester - Project Handoff Document

**Last Updated:** January 1, 2026
**Version:** 1.0.0
**Status:** Production-ready for web testing, email integration, and Appwrite cleanup

---

## 1. Project Overview

### What is AutoTester?

AutoTester is an AI-powered, cross-platform automated testing framework that converts natural language test descriptions into executable YAML test definitions. It provides true end-to-end testing capabilities with automatic cleanup for Appwrite-based applications.

**Key Differentiators:**
- Human-readable YAML test definitions that can be edited manually
- AI-powered test generation from natural language
- Built-in email verification testing via Inbucket
- Automatic Appwrite resource tracking and cleanup
- Cross-platform vision: same test definition runs on web, Android, and iOS

### Vision

```
"Test user signup with email verification and create a post"
                              ↓
                    ┌─────────────────┐
                    │  AI Generator   │
                    └────────┬────────┘
                             ↓
                    ┌─────────────────┐
                    │   YAML Test     │  ← Human-readable, editable
                    └────────┬────────┘
                             ↓
              ┌──────────────┼──────────────┐
              ↓              ↓              ↓
           ┌─────┐       ┌───────┐      ┌─────┐
           │ Web │       │Android│      │ iOS │
           └─────┘       └───────┘      └─────┘
```

### Current State (v1.0.0)

**Completed:**
- Web testing with Playwright (chromium, firefox, webkit)
- YAML test definitions with Zod schema validation
- Variable interpolation system (`{{uuid}}`, `{{varName}}`)
- Email integration with Inbucket (wait, extract codes/links, clear mailbox)
- Appwrite integration (network interception, resource tracking, automatic cleanup)
- AI test generation (Anthropic, OpenAI, Ollama support via LlamaIndex)
- Web server auto-start (auto-detect package.json scripts, serve static, or custom command)
- Reporters (JSON, HTML, JUnit XML)
- CLI commands (init, run, validate, generate)
- CI/CD workflows for Forgejo (lint, typecheck, build, test, integration tests, publish, Docker)
- Docker image with Playwright and Inbucket bundled

**Not Yet Implemented:**
- Mobile executors (Android via Maestro/ADB, iOS via Maestro/Simulator)
- Self-healing engine with AI re-identification
- VS Code extension
- Web dashboard for test results
- Parallel test execution
- Visual regression testing

---

## 2. Architecture

### Package Structure

```
autotester/
├── src/
│   ├── core/              # Schema, types, YAML parsing
│   ├── executors/
│   │   └── web/           # Playwright-based web executor
│   ├── integrations/
│   │   ├── email/         # Inbucket client for test emails
│   │   └── appwrite/      # Resource tracking & cleanup
│   ├── ai/                # AI provider abstraction (Anthropic, OpenAI, Ollama)
│   ├── generator/         # Natural language → YAML
│   ├── reporter/          # JSON, HTML, JUnit output
│   └── cli/               # Command-line interface
├── packages/              # Future workspace packages
│   ├── vite-plugin-autotester/
│   └── astro-integration/
├── tests/                 # Unit and integration tests
├── .forgejo/workflows/    # CI/CD pipelines
└── dist/                  # Build output
```

**Package Manager:** pnpm (v10)
**Runtime:** Node.js 22+
**Build System:** TypeScript 5.9

### Core Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| **core** | Schema validation, YAML parsing, type definitions | `schema.ts`, `loader.ts`, `types.ts` |
| **executors/web** | Playwright-based browser automation | `playwrightExecutor.ts` |
| **integrations/email** | Inbucket REST API client for email testing | `inbucketClient.ts` |
| **integrations/appwrite** | Network interception, resource tracking, cleanup | `appwriteClient.ts`, `types.ts` |
| **ai** | AI provider abstraction layer | `provider.ts`, `types.ts` |
| **generator** | NL → YAML test generation | `testGenerator.ts`, `prompts.ts` |
| **reporter** | Test result output formats | `htmlReporter.ts`, `jsonReporter.ts`, `junitReporter.ts` |
| **cli** | Command-line interface | `index.ts` |

### Data Flow

```
CLI Command
    ↓
Load autotester.config.yaml + test YAML
    ↓
Parse & validate with Zod schemas
    ↓
Initialize execution context (variables, email client, Appwrite tracking)
    ↓
Execute test steps sequentially
    ↓
Intercept network responses (track Appwrite resources)
    ↓
Cleanup resources (if configured)
    ↓
Generate reports (JSON/HTML/JUnit)
```

---

## 3. Features Implemented

### 3.1 YAML Test Definitions

**What it does:** Human-readable test definitions validated with Zod schemas.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/core/schema.ts` - Zod schemas
- `/Users/zach/GitHub/AutoTester/src/core/loader.ts` - YAML parsing
- `/Users/zach/GitHub/AutoTester/src/core/types.ts` - TypeScript types

**How to use:**

```yaml
name: User login test
platform: web

variables:
  EMAIL: "test@example.com"
  PASSWORD: "TestPass123!"

config:
  web:
    baseUrl: http://localhost:3000

steps:
  - type: navigate
    value: /login

  - type: input
    target: { testId: email-input }
    value: "{{EMAIL}}"

  - type: input
    target: { css: "#password" }
    value: "{{PASSWORD}}"

  - type: tap
    target: { text: "Sign In" }

  - type: assert
    target: { text: "Welcome" }
```

**Supported action types:**
- `navigate` - Navigate to URL
- `tap` - Click/tap element
- `input` - Type into input field
- `assert` - Assert element exists/contains text
- `wait` - Wait for element or timeout
- `scroll` - Scroll page or to element
- `screenshot` - Capture screenshot
- `setVar` - Set variable value
- `email.waitFor` - Wait for email to arrive
- `email.extractCode` - Extract OTP from email
- `email.extractLink` - Extract link from email
- `email.clear` - Clear mailbox

**Locator strategies:**
- `testId` - data-testid attribute
- `text` - Text content
- `css` - CSS selector
- `xpath` - XPath expression
- `role` - ARIA role + optional name
- `description` - Natural language (for AI healing)

### 3.2 Web Executor (Playwright)

**What it does:** Executes tests in Chromium, Firefox, or WebKit browsers with full screenshot capture.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/executors/web/playwrightExecutor.ts`
- `/Users/zach/GitHub/AutoTester/src/executors/web/index.ts`

**Features:**
- Multi-browser support (chromium, firefox, webkit)
- Headed/headless mode
- Automatic screenshot capture on failure
- Default 30s timeout (configurable)
- Locator resolution chain: testId → text → css/xpath → role/name → description
- Screenshot directory: `artifacts/screenshots/` (auto-created)

**How to use:**

```typescript
import { runWebTest } from 'autotester';

const result = await runWebTest(testDefinition, {
  baseUrl: 'http://localhost:3000',
  browser: 'chromium',
  headed: false,
  defaultTimeoutMs: 30000,
});
```

### 3.3 Variable System

**What it does:** Dynamic variable interpolation with `{{varName}}` syntax and special `{{uuid}}` generator.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/executors/web/playwrightExecutor.ts` (lines 71-78)

**Features:**
- Define variables in test YAML or set dynamically with `setVar`
- `{{uuid}}` generates short UUIDs (8 chars)
- Variables can reference other variables
- Used in navigate values, input values, email mailboxes, etc.

**Example:**

```yaml
variables:
  TEST_EMAIL: "test-{{uuid}}@test.local"
  TEST_PASSWORD: "TestPass123!"

steps:
  - type: input
    target: { testId: email }
    value: "{{TEST_EMAIL}}"

  - type: email.waitFor
    mailbox: "{{TEST_EMAIL}}"
```

### 3.4 Email Integration (Inbucket)

**What it does:** Captures test emails, extracts verification codes/links, enables true E2E signup flows.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/integrations/email/inbucketClient.ts`
- `/Users/zach/GitHub/AutoTester/src/integrations/email/types.ts`

**Actions:**

```yaml
# Wait for email to arrive
- type: email.waitFor
  mailbox: "test-{{uuid}}@test.local"
  timeout: 30000
  subjectContains: "Verify your email"

# Extract 6-digit code
- type: email.extractCode
  saveTo: verificationCode
  pattern: '\d{6}'  # Optional regex, defaults to \d{6}

# Extract verification link
- type: email.extractLink
  saveTo: verifyUrl
  pattern: 'https://example.com/verify.*'  # Optional

# Use extracted code
- type: input
  target: { testId: code-input }
  value: "{{verificationCode}}"

# Clear mailbox
- type: email.clear
  mailbox: "test-{{uuid}}@test.local"
```

**Configuration:**

```yaml
# autotester.config.yaml
email:
  provider: inbucket
  endpoint: http://localhost:9000
```

**Docker setup:**

```bash
docker run -d -p 9000:9000 -p 2500:2500 inbucket/inbucket
```

### 3.5 Appwrite Integration

**What it does:** Automatically tracks all Appwrite resources created during tests (rows, files, teams, memberships, messages) via network interception, then cleans them up after the test completes.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/integrations/appwrite/appwriteClient.ts`
- `/Users/zach/GitHub/AutoTester/src/integrations/appwrite/types.ts`
- `/Users/zach/GitHub/AutoTester/src/integrations/appwrite/index.ts`

**How it works:**

1. **Network Interception:** Playwright's `page.on('response')` handler intercepts all HTTP responses
2. **Pattern Matching:** Matches Appwrite API endpoints with regex patterns (see `APPWRITE_PATTERNS`)
3. **Resource Tracking:** Extracts resource IDs from POST/PUT/DELETE responses and stores in execution context
4. **Cleanup:** After test completes (success or failure), deletes tracked resources in reverse order
5. **User Deletion:** User account deleted last

**Tracked resources:**
- `row` (TablesDB rows) - requires databaseId, tableId
- `file` (Storage files) - requires bucketId
- `team` (Teams)
- `membership` (Team memberships) - requires teamId
- `message` (Messaging messages) - cannot be deleted, skipped
- `user` (User accounts)

**Configuration:**

```yaml
# autotester.config.yaml
appwrite:
  endpoint: https://cloud.appwrite.io/v1
  projectId: your-project-id
  apiKey: your-server-api-key  # Requires users.write, tablesdb.write, storage.write
  cleanup: true
  cleanupOnFailure: true  # Optional: cleanup even on test failure
```

**Test example:**

```yaml
name: Signup and create post
platform: web

variables:
  TEST_EMAIL: "test-{{uuid}}@test.local"

config:
  appwrite:
    endpoint: https://cloud.appwrite.io/v1
    projectId: abc123
    apiKey: ${APPWRITE_API_KEY}
    cleanup: true

steps:
  - type: navigate
    value: /signup

  - type: input
    target: { testId: email }
    value: "{{TEST_EMAIL}}"

  # ... signup flow ...
  # User created (tracked)
  # Email verified
  # Post created in TablesDB (tracked)

  # After test: All resources automatically deleted
```

**API Patterns:**

- User creation: `POST /v1/account`
- Row creation: `POST /v1/tablesdb/{databaseId}/tables/{tableId}/rows`
- File upload: `POST /v1/storage/buckets/{bucketId}/files`
- Team creation: `POST /v1/teams`
- Membership: `POST /v1/teams/{teamId}/memberships`
- Message: `POST /v1/messaging/messages`

### 3.6 Web Server Auto-Start

**What it does:** Automatically starts your dev server or static file server before running tests.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/executors/web/playwrightExecutor.ts` (lines 221-327)

**Options:**

```yaml
# autotester.config.yaml
webServer:
  # Option 1: Explicit command
  command: "npm run dev"
  url: http://localhost:3000
  reuseExistingServer: true
  timeout: 30000

  # Option 2: Auto-detect from package.json
  auto: true
  url: http://localhost:3000

  # Option 3: Serve static directory
  static: dist
  url: http://localhost:3000
  port: 3000
```

**Auto-detection logic:**
1. Check for build directory (dist, build, .next, out)
2. If Vite project: use `npx vite preview`
3. Otherwise: use `npx serve {buildDir}`
4. If no build dir, check package.json scripts:
   - `pnpm dev` / `yarn dev` / `npm run dev`
   - `npm start`
5. Detects package manager from lock files (pnpm-lock.yaml, yarn.lock, bun.lockb)

**Server lifecycle:**
- Starts before test execution
- Waits for server to be ready (polls URL)
- Reuses existing server if `reuseExistingServer: true`
- Kills server after test completion

### 3.7 AI Test Generation

**What it does:** Converts natural language descriptions into valid YAML test definitions using AI.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/generator/testGenerator.ts`
- `/Users/zach/GitHub/AutoTester/src/generator/prompts.ts`
- `/Users/zach/GitHub/AutoTester/src/ai/provider.ts`

**Supported providers:**
- **Anthropic:** Claude models (via LlamaIndex)
- **OpenAI:** GPT models (via LlamaIndex)
- **Ollama:** Local models (via LlamaIndex)

**Features:**
- Retry loop with validation (max 3 attempts)
- Schema-aware prompt with examples
- Error feedback to AI for self-correction

**Configuration:**

```yaml
# autotester.config.yaml
ai:
  provider: anthropic
  model: claude-3-5-sonnet-20241022
  apiKey: ${ANTHROPIC_API_KEY}
  temperature: 0.2
  maxTokens: 4096
```

**CLI usage:**

```bash
# Generate and output to console
autotester generate "test user login with valid credentials"

# Save to file
autotester generate "test signup flow" --output=tests/signup.test.yaml

# Specify platform and baseUrl
autotester generate "search for products" \
  --platform=web \
  --baseUrl=https://shop.example.com
```

**Programmatic usage:**

```typescript
import { generateTest } from 'autotester';

const result = await generateTest(
  "Test user can add item to cart and checkout",
  {
    aiConfig: {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: process.env.ANTHROPIC_API_KEY!,
      temperature: 0.2,
      maxTokens: 4096,
    },
    baseUrl: 'http://localhost:3000',
    platform: 'web',
  }
);

if (result.success) {
  console.log(result.yaml);
  // result.test contains parsed TestDefinition
}
```

### 3.8 Reporters

**What it does:** Generates test result reports in multiple formats.

**Key files:**
- `/Users/zach/GitHub/AutoTester/src/reporter/jsonReporter.ts` - JSON output
- `/Users/zach/GitHub/AutoTester/src/reporter/htmlReporter.ts` - Beautiful HTML report
- `/Users/zach/GitHub/AutoTester/src/reporter/junitReporter.ts` - JUnit XML for CI

**JSON Reporter:**

```typescript
import { generateJsonReport } from 'autotester';

await generateJsonReport(testReport, {
  outputPath: 'reports/test-results.json',
});
```

**HTML Reporter:**

```typescript
import { generateHtmlReport } from 'autotester';

await generateHtmlReport(testReport, {
  outputPath: 'reports/test-results.html',
  embedScreenshots: true,  // Base64-embed screenshots in HTML
});
```

Features:
- Beautiful gradient header
- Summary cards (status, total/passed/failed steps)
- Step-by-step breakdown with status icons
- Embedded or linked screenshots
- Error details with syntax highlighting
- Responsive design

**JUnit Reporter:**

```typescript
import { generateJunitReport } from 'autotester';

await generateJunitReport(testReport, {
  outputPath: 'reports/junit.xml',
});
```

CI/CD integration:
- Compatible with Jenkins, GitLab CI, GitHub Actions, Forgejo
- Test suite name, timestamp, duration
- Individual test cases with failures/errors

---

## 4. Configuration

### autotester.config.yaml Structure

```yaml
# Default settings for all tests
defaults:
  timeout: 30000                      # Default step timeout (ms)
  screenshots: on-failure             # on-failure | always | never

# AI configuration for test generation
ai:
  provider: anthropic                 # anthropic | openai | ollama
  model: claude-3-5-sonnet-20241022
  apiKey: ${ANTHROPIC_API_KEY}        # Env var interpolation
  temperature: 0.2
  maxTokens: 4096

# Platform-specific defaults
platforms:
  web:
    baseUrl: http://localhost:3000
    browser: chromium                 # chromium | firefox | webkit
    headless: true
    timeout: 30000

  android:
    appId: com.example.app
    device: Pixel_7_API_34

  ios:
    bundleId: com.example.app
    simulator: iPhone 15 Pro

# Auto-start web server before tests
webServer:
  auto: true                          # Auto-detect from package.json
  url: http://localhost:3000
  reuseExistingServer: true
  timeout: 30000

# Email testing with Inbucket
email:
  provider: inbucket
  endpoint: http://localhost:9000

# Appwrite integration
appwrite:
  endpoint: https://cloud.appwrite.io/v1
  projectId: abc123
  apiKey: ${APPWRITE_API_KEY}
  cleanup: true
  cleanupOnFailure: true

# Self-healing (not yet implemented)
healing:
  enabled: true
  strategies:
    - alternative-selectors
    - ai-reidentification

# Shared secrets available as {{secrets.NAME}}
secrets:
  TEST_PASSWORD: ${TEST_PASSWORD}
```

### Test YAML Structure

```yaml
# Required: Test name
name: User signup and verification

# Required: Platform
platform: web                         # web | android | ios

# Optional: Test-level variables
variables:
  TEST_EMAIL: "test-{{uuid}}@test.local"
  TEST_PASSWORD: "TestPass123!"

# Optional: Test-level config (overrides autotester.config.yaml)
config:
  web:
    baseUrl: http://localhost:4444
  email:
    provider: inbucket
    endpoint: http://localhost:9000
  appwrite:
    endpoint: https://cloud.appwrite.io/v1
    projectId: abc123
    apiKey: ${APPWRITE_API_KEY}
    cleanup: true

# Required: Test steps (minimum 1)
steps:
  - type: navigate
    value: /signup

  - type: input
    target:
      testId: email-input
      description: Email input field    # For AI healing
    value: "{{TEST_EMAIL}}"

  - type: tap
    target:
      text: "Create Account"
      role: button

  - type: email.waitFor
    mailbox: "{{TEST_EMAIL}}"
    timeout: 30000

  - type: email.extractCode
    saveTo: verificationCode

  - type: assert
    target:
      text: "Welcome"
```

### Environment Variables

AutoTester supports `${VAR_NAME}` interpolation in config files:

```yaml
ai:
  apiKey: ${ANTHROPIC_API_KEY}

appwrite:
  apiKey: ${APPWRITE_API_KEY}

secrets:
  TEST_PASSWORD: ${TEST_PASSWORD}
```

**Set via:**

```bash
# Shell
export ANTHROPIC_API_KEY="sk-ant-..."

# .env file (load with dotenv)
ANTHROPIC_API_KEY=sk-ant-...
APPWRITE_API_KEY=standard_abc123...
```

---

## 5. CLI Commands

### autotester init

**Creates default config and example test.**

```bash
autotester init
```

**Creates:**
- `autotester.config.yaml` - Default configuration template
- `tests/example.web.test.yaml` - Sample web test

### autotester validate

**Validates test YAML files against schema.**

```bash
# Validate single file
autotester validate tests/login.test.yaml

# Validate directory (recursive)
autotester validate tests/

# Validate all in current directory
autotester validate .
```

**Output:**
```
✓ tests/login.test.yaml valid
✓ tests/signup.test.yaml valid
```

### autotester run

**Executes test files.**

```bash
# Run single test
autotester run tests/login.test.yaml

# Run with visible browser (headed mode)
autotester run tests/login.test.yaml --headed

# Run with specific browser
autotester run tests/login.test.yaml --browser=firefox
autotester run tests/login.test.yaml --browser=webkit

# Skip auto-starting web server
autotester run tests/login.test.yaml --no-server
```

**Output:**
```
Running login.test.yaml on web (chromium)
[OK] navigate
[OK] input
[OK] tap
[OK] assert
```

**Exit codes:**
- `0` - All tests passed
- `1` - Test failed or error occurred

### autotester generate

**Generates test from natural language.**

```bash
# Output to console
autotester generate "test user login with valid credentials"

# Save to file
autotester generate "test signup flow" --output=tests/signup.test.yaml

# Specify platform
autotester generate "add item to cart" --platform=android

# Specify baseUrl
autotester generate "search for products" --baseUrl=https://shop.example.com
```

**Requires:** AI configuration in `autotester.config.yaml`

---

## 6. CI/CD Setup

### Forgejo Workflows

Located in `/Users/zach/GitHub/AutoTester/.forgejo/workflows/`

#### ci.yaml

**Runs on:** Push to `main`, pull requests, tags

**Jobs:**
1. **lint** - ESLint check
2. **typecheck** - TypeScript type checking
3. **build** - Compile TypeScript to dist/
4. **test** - Run unit tests (Vitest)
5. **integration-test** - Run integration tests with Browserless + Inbucket services
6. **trigger-publish** - Trigger publish workflow on version tags
7. **cache-cleanup** - Clean old S3 caches

**Services:**
- Browserless (Chromium) - `ghcr.io/browserless/chromium:latest`
- Inbucket - `inbucket/inbucket:latest`

**Cache:** S3-backed pnpm store cache

#### publish.yaml

**Triggered by:** Manual workflow dispatch with version input

**Jobs:**
1. **version** - Extract version from tag
2. **publish-npm** - Publish to Forgejo npm registry
3. **create-release** - Create Forgejo release with changelog

**Publishes:**
- `autotester@{version}` - Main package
- Workspace packages (if exist)

#### docker.yaml

**Triggered by:** Manual workflow dispatch or tags

**Builds:** Docker image with Playwright + Inbucket

**Pushes to:** Forgejo container registry

**Image:** `forge.blackleafdigital.com/blackleafdigital/autotester:{version}`

### How Releases Work

1. **Tag creation:**
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **CI runs** (ci.yaml):
   - Lint, typecheck, build, test, integration tests
   - On success, trigger publish workflow

3. **Publish workflow** (publish.yaml):
   - Update package.json version
   - Publish to Forgejo npm registry
   - Create GitHub-style release with changelog

4. **Docker workflow** (docker.yaml):
   - Build Docker image with version tag
   - Push to container registry

### Using in Other CI Systems

**GitHub Actions example:**

```yaml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g pnpm@10
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
```

**GitLab CI example:**

```yaml
test:
  image: node:22
  before_script:
    - npm install -g pnpm@10
    - pnpm install --frozen-lockfile
  script:
    - pnpm build
    - pnpm test
```

---

## 7. Staryo Integration

### Configuration

**File:** `/Users/zach/GitHub/staryo/website/autotester.config.yaml`

```yaml
defaults:
  timeout: 30000
  screenshots: on-failure

platforms:
  web:
    baseUrl: http://localhost:4444
    browser: chromium
    headless: true

webServer:
  auto: true
  url: http://localhost:4444
  reuseExistingServer: true
  timeout: 30000

email:
  provider: inbucket
  endpoint: ${INBUCKET_URL}

appwrite:
  endpoint: https://nyc.cloud.appwrite.io/v1
  projectId: 6851d5d00031278e2829
  apiKey: ${APPWRITE_API_KEY}
  cleanup: true
  cleanupOnFailure: true

secrets:
  TEST_PASSWORD: TestPassword123!
```

### Test Files

**Location:** `/Users/zach/GitHub/staryo/website/tests/autotester/`

**Tests:**
1. **signup-flow.test.yaml** - User signup with email verification
2. **login-flow.test.yaml** - User login flow

**Example (signup-flow.test.yaml):**

```yaml
name: User signup and verification flow
platform: web

variables:
  TEST_EMAIL: "test-{{uuid}}@test.local"
  TEST_PASSWORD: "TestPassword123!"
  TEST_NAME: "Test User"

config:
  web:
    baseUrl: http://localhost:4444

steps:
  - type: navigate
    value: /signup

  - type: wait
    timeout: 2000

  - type: input
    target: { css: "#name" }
    value: "{{TEST_NAME}}"

  - type: input
    target: { css: "#email" }
    value: "{{TEST_EMAIL}}"

  - type: input
    target: { css: "#password" }
    value: "{{TEST_PASSWORD}}"

  - type: input
    target: { css: "#confirmPassword" }
    value: "{{TEST_PASSWORD}}"

  - type: tap
    target: { css: "input[type='checkbox']" }

  - type: tap
    target: { text: "Create Account" }

  - type: wait
    timeout: 3000

  - type: screenshot
    name: signup-complete.png

  - type: assert
    target: { text: "Welcome" }
```

### Running Staryo Tests

```bash
cd /Users/zach/GitHub/staryo/website

# Set environment variables
export INBUCKET_URL=http://localhost:9000
export APPWRITE_API_KEY=your-server-api-key

# Run tests
autotester run tests/autotester/signup-flow.test.yaml
autotester run tests/autotester/login-flow.test.yaml
```

---

## 8. What's NOT Done Yet

### Mobile Executors

**Android (Maestro + ADB):**
- Maestro CLI integration
- ADB client for fallback actions
- Android emulator management
- AI vision for complex element finding

**iOS (Maestro + Simulator):**
- Maestro iOS integration
- Simulator management (xcrun simctl)
- Screenshot capture

**Status:** Schema supports `platform: android` and `platform: ios`, but executors not implemented.

### Self-Healing Engine

**Planned features:**
- Error classification (locator failed, timeout, network)
- Alternative selector strategies (try role if testId fails)
- Relationship-based healing (find element near known text)
- AI re-identification with vision models
- Healing reports showing what was fixed
- `autotester heal --apply` command to update test files

**Status:** `healing` config schema exists, but no engine implementation.

### VS Code Extension

**Planned features:**
- YAML schema validation with autocomplete
- Run tests from editor
- View test results inline
- Generate tests from selection
- Debug test execution

**Status:** Not started.

### Web Dashboard

**Planned features:**
- View test history and trends
- Compare test runs
- Screenshot gallery
- Failure analysis
- Team collaboration (comments, assignments)

**Status:** Not started.

### Parallel Test Execution

**Current:** Tests run sequentially.

**Planned:**
- Run multiple test files in parallel
- Configure max concurrency
- Shared resource locking (if needed)

**Status:** Not implemented.

### Visual Regression Testing

**Planned:**
- Screenshot diffing (pixelmatch, Playwright built-in)
- Baseline management
- Ignore regions
- Diff reports

**Status:** Not implemented.

---

## 9. How to Test Locally

### Prerequisites

```bash
# Install dependencies
cd /Users/zach/GitHub/AutoTester
pnpm install

# Build the project
pnpm build

# Link CLI globally (for local testing)
pnpm link --global

# Install Playwright browsers
pnpm exec playwright install chromium firefox webkit
```

### Running AutoTester Against Staryo

**Terminal 1: Start Inbucket (for email tests)**

```bash
docker run -d -p 9000:9000 -p 2500:2500 inbucket/inbucket:latest

# Or use docker-compose
cd /Users/zach/GitHub/AutoTester
docker-compose up -d inbucket
```

**Terminal 2: Set environment variables**

```bash
export INBUCKET_URL=http://localhost:9000
export APPWRITE_API_KEY=your-server-api-key-here
```

**Terminal 3: Run tests**

```bash
cd /Users/zach/GitHub/staryo/website

# Run signup flow (with email verification)
autotester run tests/autotester/signup-flow.test.yaml --headed

# Run login flow
autotester run tests/autotester/login-flow.test.yaml --headed

# Validate all tests
autotester validate tests/autotester/
```

**Verify email capture:**

Open http://localhost:9000 in browser to see Inbucket web UI and captured emails.

### Running with Inbucket for Email Tests

**1. Start Inbucket:**

```bash
docker run -d \
  --name inbucket \
  -p 9000:9000 \
  -p 2500:2500 \
  -p 1100:1100 \
  inbucket/inbucket:latest
```

**Ports:**
- 9000 - Web UI (view emails)
- 2500 - SMTP server (receive emails)
- 1100 - POP3 server

**2. Configure your app to send emails to Inbucket:**

For Appwrite:
```bash
# In Appwrite .env
_APP_SMTP_HOST=localhost
_APP_SMTP_PORT=2500
_APP_SMTP_SECURE=
_APP_SMTP_USERNAME=
_APP_SMTP_PASSWORD=
```

For other apps:
```javascript
// Example: Nodemailer
const transport = nodemailer.createTransport({
  host: 'localhost',
  port: 2500,
  secure: false,
  tls: { rejectUnauthorized: false }
});
```

**3. Create test with email actions:**

```yaml
name: Email verification test
platform: web

variables:
  TEST_EMAIL: "test-{{uuid}}@test.local"

config:
  email:
    provider: inbucket
    endpoint: http://localhost:9000

steps:
  - type: navigate
    value: /signup

  - type: input
    target: { testId: email }
    value: "{{TEST_EMAIL}}"

  - type: tap
    target: { text: "Send Verification" }

  # Wait for email
  - type: email.waitFor
    mailbox: "{{TEST_EMAIL}}"
    timeout: 30000

  # Extract code
  - type: email.extractCode
    saveTo: code

  # Use code
  - type: input
    target: { testId: verification-code }
    value: "{{code}}"
```

**4. Run test:**

```bash
autotester run tests/email-verification.test.yaml
```

**5. View captured emails:**

Open http://localhost:9000 and navigate to the mailbox (e.g., `test-abc12345`).

### Testing AI Generation Locally

**1. Set up AI provider:**

```bash
# For Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# For OpenAI
export OPENAI_API_KEY=sk-...

# For Ollama (local)
# Install Ollama: https://ollama.ai
ollama pull qwen2.5:7b
```

**2. Configure autotester.config.yaml:**

```yaml
ai:
  provider: anthropic  # or openai, ollama
  model: claude-3-5-sonnet-20241022
  apiKey: ${ANTHROPIC_API_KEY}
  temperature: 0.2
  maxTokens: 4096
```

**3. Generate test:**

```bash
# Generate and view
autotester generate "test user can login with valid email and password"

# Generate and save
autotester generate "test signup flow with email verification" \
  --output=tests/generated-signup.test.yaml \
  --platform=web \
  --baseUrl=http://localhost:3000

# Validate generated test
autotester validate tests/generated-signup.test.yaml

# Run generated test
autotester run tests/generated-signup.test.yaml --headed
```

### Integration Testing

**Run integration tests (requires Inbucket):**

```bash
# Start Inbucket
docker run -d -p 9000:9000 -p 2500:2500 inbucket/inbucket:latest

# Set environment
export INBUCKET_URL=http://localhost:9000
export INBUCKET_SMTP_HOST=localhost
export INBUCKET_SMTP_PORT=2500

# Run integration tests
pnpm test:integration
```

---

## 10. Key Files Reference

| File/Directory | Purpose |
|----------------|---------|
| `/Users/zach/GitHub/AutoTester/package.json` | Main package config, scripts, dependencies |
| `/Users/zach/GitHub/AutoTester/src/core/schema.ts` | Zod schemas for YAML validation |
| `/Users/zach/GitHub/AutoTester/src/core/loader.ts` | YAML parsing and validation |
| `/Users/zach/GitHub/AutoTester/src/core/types.ts` | TypeScript type definitions |
| `/Users/zach/GitHub/AutoTester/src/cli/index.ts` | CLI commands implementation |
| `/Users/zach/GitHub/AutoTester/src/executors/web/playwrightExecutor.ts` | Playwright test executor |
| `/Users/zach/GitHub/AutoTester/src/integrations/email/inbucketClient.ts` | Inbucket REST API client |
| `/Users/zach/GitHub/AutoTester/src/integrations/appwrite/appwriteClient.ts` | Appwrite cleanup client |
| `/Users/zach/GitHub/AutoTester/src/integrations/appwrite/types.ts` | Appwrite patterns and types |
| `/Users/zach/GitHub/AutoTester/src/ai/provider.ts` | AI provider abstraction |
| `/Users/zach/GitHub/AutoTester/src/generator/testGenerator.ts` | NL → YAML generator |
| `/Users/zach/GitHub/AutoTester/src/generator/prompts.ts` | AI system prompts |
| `/Users/zach/GitHub/AutoTester/src/reporter/htmlReporter.ts` | HTML report generator |
| `/Users/zach/GitHub/AutoTester/src/reporter/jsonReporter.ts` | JSON report generator |
| `/Users/zach/GitHub/AutoTester/src/reporter/junitReporter.ts` | JUnit XML reporter |
| `/Users/zach/GitHub/AutoTester/.forgejo/workflows/ci.yaml` | CI pipeline |
| `/Users/zach/GitHub/AutoTester/.forgejo/workflows/publish.yaml` | NPM publish workflow |
| `/Users/zach/GitHub/AutoTester/.forgejo/workflows/docker.yaml` | Docker build workflow |
| `/Users/zach/GitHub/AutoTester/Dockerfile` | Docker image definition |
| `/Users/zach/GitHub/AutoTester/docker-compose.yaml` | Local Inbucket setup |
| `/Users/zach/GitHub/AutoTester/tsconfig.json` | TypeScript compiler config |
| `/Users/zach/GitHub/AutoTester/vitest.config.ts` | Unit test config |
| `/Users/zach/GitHub/AutoTester/vitest.integration.config.ts` | Integration test config |
| `/Users/zach/GitHub/staryo/website/autotester.config.yaml` | Staryo test config |
| `/Users/zach/GitHub/staryo/website/tests/autotester/signup-flow.test.yaml` | Staryo signup test |
| `/Users/zach/GitHub/staryo/website/tests/autotester/login-flow.test.yaml` | Staryo login test |

---

## Additional Resources

### Documentation Files

- `/Users/zach/GitHub/AutoTester/PROJECT_README.md` - Original project vision and overview
- `/Users/zach/GitHub/AutoTester/PROJECT_DONE.md` - Completed work checklist
- `/Users/zach/GitHub/AutoTester/PROJECT_TODO.md` - Roadmap and future work
- `/Users/zach/GitHub/AutoTester/APPWRITE_TESTING.md` - Detailed Appwrite integration guide
- `/Users/zach/GitHub/AutoTester/INTERPOLATION_IMPLEMENTATION.md` - Variable system details
- `/Users/zach/GitHub/AutoTester/README.md` - Public-facing README

### Scripts

| Command | Purpose |
|---------|---------|
| `pnpm build` | Compile TypeScript to dist/ |
| `pnpm typecheck` | Type checking without emit |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Auto-fix linting issues |
| `pnpm test` | Run unit tests |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:integration` | Run integration tests |
| `pnpm format` | Check code formatting |
| `pnpm format:fix` | Auto-fix formatting |

### Dependencies

**Production:**
- `playwright@^1.57.0` - Browser automation
- `node-appwrite@^21.0.0` - Appwrite SDK
- `llamaindex@^0.12.1` - AI framework
- `@llamaindex/anthropic@^0.3.26` - Claude models
- `@llamaindex/openai@^0.4.22` - GPT models
- `@llamaindex/ollama@^0.1.23` - Local models
- `zod@^4.1.13` - Schema validation
- `yaml@^2.8.2` - YAML parsing

**Dev:**
- `typescript@^5.9.3` - TypeScript compiler
- `vitest@^4.0.15` - Testing framework
- `eslint@^9.39.2` - Linting
- `prettier@^3.7.4` - Code formatting

---

## Next Steps for Development

### Immediate Priorities

1. **Mobile Executors:**
   - Implement Maestro CLI wrapper
   - Android ADB client for fallback
   - iOS Simulator management
   - Cross-platform action mapping

2. **Self-Healing:**
   - Error classification logic
   - Alternative selector strategies
   - AI vision fallback for locator failures

3. **Parallel Execution:**
   - Worker pool implementation
   - Resource isolation
   - Aggregate reporting

### Long-term Goals

1. **VS Code Extension:**
   - IntelliSense for YAML schemas
   - Test runner integration
   - Live test debugging

2. **Web Dashboard:**
   - Test history and trends
   - Screenshot diffing
   - Team collaboration

3. **Platform Expansion:**
   - Supabase integration (similar to Appwrite)
   - Firebase integration
   - BrowserStack/Sauce Labs cloud devices

---

**End of Handoff Document**

Last updated: January 1, 2026
Project version: 1.0.0
Status: Production-ready for web testing
