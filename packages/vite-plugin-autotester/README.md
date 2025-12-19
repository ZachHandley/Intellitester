# vite-plugin-autotester

Vite plugin for integrating AutoTester into your Vite projects. Automatically generates test stubs, provides a dev server endpoint for test management, and integrates with AutoTester's testing capabilities.

## Features

- **Automatic Test Stub Generation**: Scans your components and generates YAML test stubs
- **Dev Server Integration**: Adds a `/__autotester` endpoint to view and manage tests
- **Hot Module Replacement**: Watches test files and re-runs tests on changes
- **Build Integration**: Optionally run tests after build completion
- **TypeScript Support**: Full TypeScript definitions included

## Installation

```bash
npm install vite-plugin-autotester
# or
pnpm add vite-plugin-autotester
# or
yarn add vite-plugin-autotester
```

## Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { autotester } from 'vite-plugin-autotester';

export default defineConfig({
  plugins: [
    autotester({
      // Scan these patterns for components to generate test stubs
      include: ['src/components/**/*.tsx', 'src/pages/**/*.tsx'],

      // Directory for test files
      testsDir: './tests',

      // Watch test files in dev mode
      watchTests: true,

      // Run tests after build
      runOnBuild: false,

      // Path to AutoTester config
      configPath: 'autotester.config.yaml',
    }),
  ],
});
```

## Configuration Options

### `include`
- **Type**: `string[]`
- **Default**: `[]`
- **Description**: Glob patterns for components to scan and generate test stubs for

```typescript
include: ['src/components/**/*.tsx', 'src/pages/**/*.tsx']
```

### `testsDir`
- **Type**: `string`
- **Default**: `'./tests'`
- **Description**: Directory where test files are stored

### `watchTests`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Whether to watch test files and re-run tests in dev mode

### `runOnBuild`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Whether to run tests after build completes

### `configPath`
- **Type**: `string`
- **Default**: `'autotester.config.yaml'`
- **Description**: Path to autotester.config.yaml

### `endpoint`
- **Type**: `string`
- **Default**: `'/__autotester'`
- **Description**: Base URL for the dev server endpoint

## Dev Server Endpoint

When running the Vite dev server, navigate to `http://localhost:5173/__autotester` (or your configured port) to view:

- Test configuration status
- Available test files
- Test execution options

## Test Stub Generation

The plugin automatically generates test stubs for components matching your `include` patterns. Each stub follows AutoTester's YAML format:

```yaml
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

**Note**: Test stubs are only created if they don't already exist. The plugin will not overwrite your customized tests.

## Requirements

- Vite 5.x, 6.x, or 7.x
- Node.js 18+
- TypeScript 5+ (recommended)

## Integration with AutoTester

This plugin works alongside the AutoTester CLI. To run your tests:

```bash
# Install AutoTester
npm install autotester

# Run all tests
npx autotester run

# Run a specific test
npx autotester run tests/Button.test.yaml
```

## Example Project Structure

```
my-vite-app/
├── src/
│   ├── components/
│   │   ├── Button.tsx
│   │   └── Input.tsx
│   └── pages/
│       └── Home.tsx
├── tests/
│   ├── components/
│   │   ├── Button.test.yaml  # Auto-generated
│   │   └── Input.test.yaml   # Auto-generated
│   └── pages/
│       └── Home.test.yaml    # Auto-generated
├── autotester.config.yaml
├── vite.config.ts
└── package.json
```

## License

MIT

## Author

Zach Handley <zachhandley@gmail.com>
