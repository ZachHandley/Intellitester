# AutoTester

AI-powered automated testing framework that converts natural language into executable tests across web and mobile platforms.

## Vision

```
"Test that a user can login, add item to cart, and checkout"
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

## Features

- **Natural Language → Tests**: Describe what to test in plain English, get executable YAML
- **Cross-Platform**: Same test definition runs on web (Playwright), Android (Maestro/ADB), iOS (Maestro/Simulator)
- **AI-Powered Locators**: Find elements by description ("the login button") not just selectors
- **Self-Healing**: Tests auto-recover when UI changes using AI vision fallback
- **LiteLLM Integration**: Use local Ollama or cloud providers (OpenAI, Anthropic, etc.)
- **Appwrite Integration**: Auto-create test users, track via audit logs, clean up all data after tests

## Installation

```bash
npm install -g @blackleafdigital/autotester
# or
pnpm add -g @blackleafdigital/autotester
```

## Quick Start

```bash
# Initialize in your project
autotester init

# Generate a test from natural language
autotester generate "test user login with valid credentials"

# Run tests
autotester run tests/

# Run with visible browser
autotester run tests/ --headed
```

## Test Definition (YAML)

```yaml
# tests/login.test.yaml
name: User login flow
platform: web

config:
  web:
    baseUrl: https://myapp.com

steps:
  - type: navigate
    value: /login

  - type: input
    target:
      description: email input field
      testId: email-input          # fallback selector
    value: "test@example.com"

  - type: input
    target:
      description: password field
    value: "${secrets.TEST_PASSWORD}"

  - type: tap
    target:
      text: "Sign In"

  - type: assert
    target:
      description: welcome message or dashboard
```

## Configuration

```yaml
# autotester.config.yaml
defaults:
  timeout: 30000
  screenshots: on-failure

ai:
  provider: litellm
  model: ollama/qwen2.5-vl    # local
  # model: gpt-4o             # cloud fallback

platforms:
  web:
    browser: chromium
    headless: true
    baseUrl: ${BASE_URL}

  android:
    appId: com.example.app
    device: Pixel_7_API_34

  ios:
    bundleId: com.example.app
    simulator: iPhone 15 Pro

healing:
  enabled: true
  strategies:
    - alternative-selectors
    - ai-reidentification

# Appwrite integration for test isolation
appwrite:
  enabled: true
  endpoint: https://cloud.appwrite.io/v1
  projectId: ${APPWRITE_PROJECT_ID}
  apiKey: ${APPWRITE_API_KEY}          # Server API key with users.write, databases.write
  # OR deploy a cleanup function:
  # functionId: cleanup-test-data       # Appwrite Function for cleanup

secrets:
  TEST_PASSWORD: ${TEST_PASSWORD}
```

## Appwrite Integration (E2E Testing)

AutoTester provides true end-to-end testing for Appwrite apps with automatic email verification and cleanup.

### Setup

```bash
# 1. Run Inbucket (catches all test emails)
docker run -d -p 9000:9000 -p 2500:2500 inbucket/inbucket

# 2. Point Appwrite SMTP to Inbucket (in Appwrite console or .env)
_APP_SMTP_HOST=localhost
_APP_SMTP_PORT=2500
```

### Test Flow

```yaml
# tests/auth-flow.test.yaml
name: User registration and onboarding
platform: web

email:
  provider: inbucket
  endpoint: http://localhost:9000

appwrite:
  cleanup: true  # Wipe all user data after test

steps:
  # 1. Real UI signup
  - type: navigate
    value: /register

  - type: input
    target: { testId: email }
    value: "test-{{uuid}}@test.local"

  - type: input
    target: { testId: password }
    value: "TestPass123!"

  - type: tap
    target: { text: "Sign Up" }

  # 2. Get verification code from Inbucket
  - type: email.waitFor
    mailbox: "test-{{uuid}}@test.local"
    timeout: 30000

  - type: email.extractCode
    pattern: "\\d{6}"  # 6-digit OTP
    saveTo: verificationCode

  # 3. Enter code in UI
  - type: input
    target: { testId: verification-code }
    value: "{{verificationCode}}"

  - type: tap
    target: { text: "Verify" }

  # 4. Now logged in - do stuff
  - type: tap
    target: { text: "Create Post" }

  - type: input
    target: { testId: post-title }
    value: "Test Post"

  - type: tap
    target: { text: "Publish" }

  - type: assert
    target: { text: "Test Post" }

# After test: AutoTester cleans up via Appwrite API
# - Deletes all documents created by user
# - Deletes user account
# - Clears Inbucket mailbox
```

### What Gets Cleaned Up
- User account (via Appwrite API)
- All documents created by user (`$createdBy` queries)
- Storage files uploaded by user
- Team memberships & sessions
- Test emails (via Inbucket API)

### Config

```yaml
# autotester.config.yaml
appwrite:
  endpoint: https://cloud.appwrite.io/v1
  projectId: ${APPWRITE_PROJECT_ID}
  apiKey: ${APPWRITE_API_KEY}  # needs users.write, databases.write

email:
  provider: inbucket
  endpoint: http://localhost:9000
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `autotester init` | Initialize AutoTester in a project |
| `autotester generate <prompt>` | Generate test from natural language |
| `autotester run [pattern]` | Execute tests |
| `autotester run --platform android` | Run on specific platform |
| `autotester validate tests/` | Validate test YAML files |
| `autotester heal --apply` | Apply self-healing fixes to tests |

## Architecture

```
src/
├── core/           # Types, schema, config
├── executors/
│   ├── web/        # Playwright-based
│   ├── android/    # Maestro + ADB + AI Vision
│   └── ios/        # Maestro + Simulator
├── ai/             # LiteLLM provider abstraction
├── generator/      # NL → YAML pipeline
├── healing/        # Self-healing engine
├── reporter/       # HTML/JSON/JUnit output
├── integrations/
│   ├── email/      # Inbucket client (test email capture)
│   └── appwrite/   # User tracking & cleanup
└── cli/            # Command implementations
```

## Tech Stack

- **Runtime**: Node.js 20+
- **Web Automation**: Playwright
- **Mobile Automation**: Maestro CLI + ADB
- **AI**: LiteLLM (Ollama local + cloud providers)
- **Schema Validation**: Zod
- **Testing**: Vitest

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Local development
pnpm dev
```

## License

MIT
