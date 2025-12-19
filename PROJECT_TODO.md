# AutoTester - Project TODO

## Phase 1: Foundation
> Goal: Working web test execution from YAML

### Setup
- [ ] Initialize package.json with @blackleafdigital/autotester
- [ ] Set up TypeScript config
- [ ] Configure ESLint + Prettier
- [ ] Set up Vitest for testing
- [ ] Create basic folder structure

### Core Types & Schema
- [ ] Define action types (tap, input, navigate, assert, wait, etc.)
- [ ] Define element locator interface (description, selectors, relationships)
- [ ] Define test definition schema (name, platform, config, steps)
- [ ] Implement YAML parsing with Zod validation
- [ ] Create config file schema (autotester.config.yaml)

### Web Executor (Playwright)
- [ ] Playwright browser lifecycle management
- [ ] Locator resolution strategies:
  - [ ] testId
  - [ ] text
  - [ ] CSS/XPath
  - [ ] role + name
- [ ] Action implementations:
  - [ ] navigate
  - [ ] tap/click
  - [ ] input/type
  - [ ] assert
  - [ ] wait
  - [ ] scroll
  - [ ] screenshot
- [ ] Screenshot capture on each step
- [ ] Error handling and reporting

### CLI (Basic)
- [ ] `autotester init` - create config file
- [ ] `autotester run <pattern>` - execute tests
- [ ] `autotester run --headed` - visible browser
- [ ] `autotester validate <path>` - schema validation
- [ ] Console output formatting

### Reporter (Basic)
- [ ] JSON results output
- [ ] HTML report generation
- [ ] Screenshot embedding
- [ ] Pass/fail summary

### Testing
- [ ] Test against https://staryo.zach-64e.workers.dev
- [ ] Create example test files
- [ ] Unit tests for schema validation
- [ ] Integration tests for web executor

---

## Phase 2: AI Integration
> Goal: Natural language test generation, AI-powered locators

### AI Provider (LiteLLM)
- [ ] LiteLLM client wrapper
- [ ] Provider configuration (Ollama, OpenAI, Anthropic)
- [ ] Rate limiting
- [ ] Error handling and retries
- [ ] Response parsing

### Test Generator
- [ ] System prompt for test generation
- [ ] Natural language → YAML pipeline
- [ ] Schema validation loop (retry on invalid)
- [ ] Test optimization (add waits, assertions)
- [ ] `autotester generate <prompt>` command
- [ ] Interactive mode (review before save)

### AI-Powered Locators
- [ ] Vision model integration (screenshot → element)
- [ ] Natural language element description → coordinates
- [ ] Confidence scoring
- [ ] Fallback chain: testId → text → CSS → AI vision

---

## Phase 3: Mobile Support
> Goal: Same YAML runs on web, Android, iOS

### Maestro Integration
- [ ] Maestro CLI wrapper
- [ ] YAML flow generation from AutoTester actions
- [ ] Device/simulator management
- [ ] Result parsing

### Android Executor
- [ ] ADB client implementation
- [ ] Hybrid execution (Maestro primary, ADB fallback)
- [ ] AI vision for complex scenarios
- [ ] Emulator management
- [ ] Screenshot capture via ADB

### iOS Executor
- [ ] Simulator management (xcrun simctl)
- [ ] Maestro iOS integration
- [ ] Screenshot capture

### Cross-Platform
- [ ] Platform router (same test → different executor)
- [ ] Platform-specific config merging
- [ ] `autotester run --platform android|ios|web`

---

## Phase 4: Self-Healing & Polish
> Goal: Production-ready with CI/CD

### Self-Healing Engine
- [ ] Error classification (locator vs timeout vs network)
- [ ] Alternative selector strategies
- [ ] Relationship-based healing (near text, position)
- [ ] AI re-identification fallback
- [ ] Healing reports
- [ ] `autotester heal --apply` command

### CI/CD Integration
- [ ] GitHub Actions workflow templates
- [ ] Android emulator in CI (KVM setup)
- [ ] iOS simulator in CI (macOS runners)
- [ ] Artifact collection (screenshots, reports)
- [ ] JUnit XML output for CI integration

### Documentation
- [ ] Getting started guide
- [ ] YAML schema reference
- [ ] Configuration options
- [ ] CI/CD integration guide
- [ ] API reference (for programmatic use)

### Polish
- [ ] Better error messages
- [ ] Progress indicators
- [ ] Parallel test execution
- [ ] Test filtering (tags, grep)
- [ ] Watch mode for development

---

## Phase 1.5: Email & Appwrite Integration
> Goal: True E2E testing with real signup flow and automatic cleanup

### Inbucket Integration (Test Email)
- [ ] Inbucket client (REST API wrapper)
- [ ] `email.waitFor` action - poll for new email in mailbox
- [ ] `email.extractCode` action - regex extract OTP/links from email body
- [ ] `email.extractLink` action - get verification/magic links
- [ ] Template variable storage ({{verificationCode}}, etc.)
- [ ] Auto-clear mailbox after test

### Appwrite Cleanup Module
- [ ] Appwrite Node.js SDK integration
- [ ] Track test user ID during signup flow
- [ ] Query documents by `$createdBy` user ID
- [ ] Bulk delete user's documents from all collections
- [ ] Delete user's storage files
- [ ] Remove team memberships & sessions
- [ ] Delete user account
- [ ] Cleanup report in test results

### New Action Types
- [ ] `email.waitFor` - wait for email to arrive
- [ ] `email.extractCode` - extract OTP with regex
- [ ] `email.extractLink` - extract URL from email
- [ ] `email.clear` - clear mailbox

### Config
- [ ] `email` config section (provider, endpoint)
- [ ] `appwrite` config section (endpoint, projectId, apiKey)
- [ ] Docker compose example with Inbucket

---

## Future Ideas
- [ ] Visual regression testing (screenshot diff)
- [ ] Cloud device farm integration (BrowserStack, Sauce Labs)
- [ ] VS Code extension
- [ ] Web dashboard for test results
- [ ] Record mode (watch user actions → generate test)
- [ ] MCP server for AI agent integration
- [ ] Flutter/WASM specific support
- [ ] Supabase integration (similar to Appwrite)
- [ ] Firebase integration

---

## Current Focus

**Working on:** Phase 1 - Foundation

**Next immediate tasks:**
1. Initialize package.json
2. Set up TypeScript
3. Create folder structure
4. Define core types
