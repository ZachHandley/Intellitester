# Usage Example

## Basic Setup

### 1. Install the plugin

```bash
pnpm add vite-plugin-autotester
```

### 2. Configure Vite

Create or update your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { autotester } from 'vite-plugin-autotester';

export default defineConfig({
  plugins: [
    react(),
    autotester({
      include: [
        'src/components/**/*.{tsx,jsx}',
        'src/pages/**/*.{tsx,jsx}'
      ],
      testsDir: './tests',
      watchTests: true,
    }),
  ],
});
```

### 3. Start the dev server

```bash
pnpm dev
```

Visit `http://localhost:5173/__autotester` to see the test management UI.

## What Happens Next

1. **Test Stub Generation**: The plugin scans your components based on the `include` patterns
2. **Automatic File Creation**: Creates YAML test stubs in the `tests` directory for components without tests
3. **Dev Server Integration**: Provides a web UI at `/__autotester` to view test status

## Example Generated Test

For a component at `src/components/Button.tsx`, the plugin generates:

```yaml
# tests/components/Button.test.yaml
name: Button Component Test
platform: web

config:
  web:
    baseUrl: http://localhost:5173
    headless: false
    timeout: 30000

steps:
  - type: navigate
    value: /

  - type: screenshot
    name: button-initial-state
```

## Customizing Tests

Edit the generated YAML files to add your specific test steps:

```yaml
name: Button Component Test
platform: web

config:
  web:
    baseUrl: http://localhost:5173
    headless: false

steps:
  - type: navigate
    value: /components/button

  - type: wait
    target:
      testId: primary-button
    timeout: 5000

  - type: tap
    target:
      testId: primary-button

  - type: assert
    target:
      testId: button-clicked-message
    value: Button was clicked!

  - type: screenshot
    name: button-after-click
```

## Running Tests

Use the AutoTester CLI to execute your tests:

```bash
# Run all tests
npx autotester run

# Run a specific test
npx autotester run tests/components/Button.test.yaml

# Watch mode
npx autotester run --watch
```

## Advanced Configuration

### Multiple Component Directories

```typescript
autotester({
  include: [
    'src/components/**/*.tsx',
    'src/features/**/components/*.tsx',
    'src/pages/**/*.tsx',
    'src/layouts/**/*.tsx',
  ],
  testsDir: './e2e-tests',
})
```

### Run Tests After Build

```typescript
autotester({
  include: ['src/**/*.tsx'],
  runOnBuild: true,  // Runs tests after production build
})
```

### Custom Config Path

```typescript
autotester({
  include: ['src/**/*.tsx'],
  configPath: './config/autotester.config.yaml',
})
```

## Project Structure

```
my-app/
├── src/
│   ├── components/
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   └── Card.tsx
│   └── pages/
│       ├── Home.tsx
│       └── About.tsx
├── tests/
│   ├── components/
│   │   ├── Button.test.yaml    # Auto-generated
│   │   ├── Input.test.yaml     # Auto-generated
│   │   └── Card.test.yaml      # Auto-generated
│   └── pages/
│       ├── Home.test.yaml      # Auto-generated
│       └── About.test.yaml     # Auto-generated
├── vite.config.ts
├── autotester.config.yaml
└── package.json
```

## AutoTester Global Config

Create `autotester.config.yaml` in your project root:

```yaml
defaults:
  timeout: 30000
  screenshots: on-failure

platforms:
  web:
    browser: chromium
    headless: true

ai:
  provider: anthropic
  model: claude-3-sonnet-20240229
  temperature: 0.2
```

## Tips

1. **Add test IDs**: Use `data-testid` attributes in your components for reliable test targeting
2. **Don't edit auto-generated stubs**: Customize tests after generation; the plugin won't overwrite modified files
3. **Use the dev UI**: Visit `/__autotester` to monitor your test suite
4. **Organize tests**: Mirror your component structure in the tests directory
