# Appwrite E2E Testing Integration

AutoTester provides true end-to-end testing for Appwrite-backed applications with automatic email verification and cleanup.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Test Execution Flow                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. UI: User signs up (real form submission)                    │
│     └─→ Intercept: Capture userId from POST /v1/account         │
│                                                                 │
│  2. Email: Appwrite sends verification → Inbucket catches it    │
│     └─→ API: GET /api/v1/mailbox/{email} → extract OTP          │
│                                                                 │
│  3. UI: Enter verification code                                 │
│                                                                 │
│  4. UI: User does stuff (creates rows, uploads files)           │
│     └─→ Intercept: Track all created resources                  │
│         • POST /v1/tablesdb/{db}/tables/{table}/rows            │
│         • POST /v1/storage/buckets/{bucket}/files               │
│                                                                 │
│  5. Cleanup: Delete everything we tracked                       │
│     └─→ Appwrite API: Delete rows, files, user                  │
│     └─→ Inbucket API: Clear mailbox                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Setup

### 1. Inbucket (Test Email Server)

```bash
docker run -d --name inbucket -p 9000:9000 -p 2500:2500 inbucket/inbucket
```

- Web UI: http://localhost:9000
- SMTP: localhost:2500
- API: http://localhost:9000/api/v1/mailbox/{email}

### 2. Configure Appwrite SMTP

Point Appwrite to Inbucket (in `.env` or Console):

```env
_APP_SMTP_HOST=localhost
_APP_SMTP_PORT=2500
_APP_SMTP_SECURE=
_APP_SMTP_USERNAME=
_APP_SMTP_PASSWORD=
```

### 3. Appwrite API Key

Create a Server API key with permissions:
- `users.read`, `users.write`
- `databases.read`, `databases.write`
- `storage.read`, `storage.write`

## Network Interception

We intercept Appwrite API responses to track what gets created:

```typescript
// Patterns we watch for
const APPWRITE_PATTERNS = {
  // User signup - POST /v1/account (exact, not /account/sessions)
  userCreate: /\/v1\/account$/,

  // Row created - TablesDB API
  rowCreate: /\/v1\/tablesdb\/[\w-]+\/tables\/[\w-]+\/rows$/,

  // File uploaded
  fileCreate: /\/v1\/storage\/buckets\/[\w-]+\/files$/,

  // Team membership
  teamJoin: /\/v1\/teams\/[\w-]+\/memberships$/,
};

// Response interception
page.on('response', async (response) => {
  const url = response.url();
  const method = response.request().method();

  if (method !== 'POST') return;

  // User created
  if (APPWRITE_PATTERNS.userCreate.test(url)) {
    const data = await response.json();
    context.userId = data.$id;
    context.userEmail = data.email;
  }

  // Row created
  if (APPWRITE_PATTERNS.rowCreate.test(url)) {
    const data = await response.json();
    const [, dbId, , tableId] = url.match(/tablesdb\/([\w-]+)\/tables\/([\w-]+)/);
    context.rows.push({ databaseId: dbId, tableId, rowId: data.$id });
  }

  // File uploaded
  if (APPWRITE_PATTERNS.fileCreate.test(url)) {
    const data = await response.json();
    const [, bucketId] = url.match(/buckets\/([\w-]+)/);
    context.files.push({ bucketId, fileId: data.$id });
  }
});
```

## Inbucket Email API

```typescript
const INBUCKET_URL = 'http://localhost:9000';

// Wait for email to arrive
async function waitForEmail(mailbox: string, timeout = 30000): Promise<Email> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}`);
    const messages = await res.json();
    if (messages.length > 0) {
      // Get latest message content
      const latest = messages[messages.length - 1];
      const detail = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${latest.id}`);
      return detail.json();
    }
    await sleep(1000);
  }
  throw new Error(`No email received for ${mailbox} within ${timeout}ms`);
}

// Extract OTP code from email body
function extractCode(body: string, pattern = /\d{6}/): string {
  const match = body.match(pattern);
  if (!match) throw new Error('No code found in email');
  return match[0];
}

// Extract verification link
function extractLink(body: string, pattern = /https?:\/\/[^\s]+verify[^\s]*/i): string {
  const match = body.match(pattern);
  if (!match) throw new Error('No verification link found');
  return match[0];
}

// Clear mailbox after test
async function clearMailbox(mailbox: string): Promise<void> {
  await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}`, { method: 'DELETE' });
}
```

## Cleanup Engine

```typescript
import { Client, Users, Databases, Storage } from 'node-appwrite';

interface TestContext {
  userId?: string;
  userEmail?: string;
  rows: { databaseId: string; tableId: string; rowId: string }[];
  files: { bucketId: string; fileId: string }[];
}

async function cleanup(context: TestContext, appwrite: Client) {
  const databases = new Databases(appwrite);
  const storage = new Storage(appwrite);
  const users = new Users(appwrite);

  // Delete all tracked rows
  for (const row of context.rows) {
    try {
      await databases.deleteDocument(row.databaseId, row.tableId, row.rowId);
    } catch (e) {
      console.warn(`Failed to delete row ${row.rowId}:`, e);
    }
  }

  // Delete all tracked files
  for (const file of context.files) {
    try {
      await storage.deleteFile(file.bucketId, file.fileId);
    } catch (e) {
      console.warn(`Failed to delete file ${file.fileId}:`, e);
    }
  }

  // Delete user account
  if (context.userId) {
    try {
      await users.delete(context.userId);
    } catch (e) {
      console.warn(`Failed to delete user ${context.userId}:`, e);
    }
  }

  // Clear test emails
  if (context.userEmail) {
    await clearMailbox(context.userEmail);
  }
}
```

## YAML Test Example

```yaml
name: Full signup and onboarding flow
platform: web

config:
  web:
    baseUrl: https://myapp.com

  email:
    provider: inbucket
    endpoint: http://localhost:9000

  appwrite:
    endpoint: https://cloud.appwrite.io/v1
    projectId: ${APPWRITE_PROJECT_ID}
    apiKey: ${APPWRITE_API_KEY}
    cleanup: true

steps:
  # Generate unique test email
  - type: setVar
    name: testEmail
    value: "test-{{uuid}}@test.local"

  # Sign up via UI
  - type: navigate
    value: /signup

  - type: input
    target: { testId: email-input }
    value: "{{testEmail}}"

  - type: input
    target: { testId: password-input }
    value: "TestPassword123!"

  - type: tap
    target: { text: "Create Account" }

  # Wait for and handle verification email
  - type: email.waitFor
    mailbox: "{{testEmail}}"
    timeout: 30000

  - type: email.extractCode
    pattern: "\\d{6}"
    saveTo: otpCode

  - type: input
    target: { testId: otp-input }
    value: "{{otpCode}}"

  - type: tap
    target: { text: "Verify" }

  # Now logged in - do stuff
  - type: assert
    target: { text: "Welcome" }

  - type: tap
    target: { text: "Create Post" }

  - type: input
    target: { testId: post-title }
    value: "My Test Post"

  - type: tap
    target: { text: "Publish" }

  - type: assert
    target: { text: "My Test Post" }

# After test completes:
# - All rows created during test are deleted
# - All files uploaded are deleted
# - User account is deleted
# - Test mailbox is cleared
```

## New Action Types

| Action | Description |
|--------|-------------|
| `email.waitFor` | Poll Inbucket until email arrives |
| `email.extractCode` | Regex extract OTP from email body |
| `email.extractLink` | Extract verification/magic link URL |
| `email.clear` | Clear a mailbox |
| `setVar` | Set a variable (supports `{{uuid}}`) |

## Config Reference

```yaml
# autotester.config.yaml

email:
  provider: inbucket          # Only option for now
  endpoint: http://localhost:9000

appwrite:
  endpoint: https://cloud.appwrite.io/v1
  projectId: your-project-id
  apiKey: your-server-api-key  # Needs users.write, databases.write, storage.write
  cleanup: true                # Auto-cleanup after each test

  # Optional: also cleanup on test failure
  cleanupOnFailure: true
```

## Docker Compose (Dev Setup)

```yaml
version: '3.8'

services:
  inbucket:
    image: inbucket/inbucket
    ports:
      - "9000:9000"   # Web UI + API
      - "2500:2500"   # SMTP

  # Your Appwrite instance (if self-hosted)
  # appwrite:
  #   ...
  #   environment:
  #     _APP_SMTP_HOST: inbucket
  #     _APP_SMTP_PORT: 2500
```

## Limitations

- Requires Appwrite SMTP pointed to Inbucket (can't intercept real emails)
- Server API key needed for cleanup (not client-side)
- TablesDB API only (legacy collections/documents as optional fallback)

## References

### Appwrite
- [Appwrite Node.js SDK](https://appwrite.io/docs/sdks#server)
- [Users API - Server](https://appwrite.io/docs/references/cloud/server-nodejs/users)
- [TablesDB API](https://appwrite.io/docs/products/databases)
- [Storage API](https://appwrite.io/docs/references/cloud/server-nodejs/storage)
- [SMTP Configuration](https://appwrite.io/docs/advanced/self-hosting/email)

### Inbucket
- [Inbucket GitHub](https://github.com/inbucket/inbucket)
- [Inbucket REST API](https://github.com/inbucket/inbucket/wiki/REST-API)
- [Inbucket Docker Hub](https://hub.docker.com/r/inbucket/inbucket)

### Playwright (Network Interception)
- [Playwright Network Events](https://playwright.dev/docs/network#network-events)
- [Response Interception](https://playwright.dev/docs/api/class-response)
