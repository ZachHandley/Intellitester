# @autotester/astro

Astro integration for AutoTester - SSR and hydration testing for Astro applications.

## Installation

```bash
pnpm add @autotester/astro -D
```

## Usage

Add the integration to your `astro.config.mjs`:

```javascript
import { defineConfig } from 'astro/config';
import autotester from '@autotester/astro';

export default defineConfig({
  integrations: [
    autotester({
      testsDir: './tests',
      runOnBuild: true,
      testSSR: true,
      testHydration: true,
      testIslands: true,
    })
  ]
});
```

## Options

- `testsDir` - Directory containing test files (default: `./tests`)
- `runOnBuild` - Run tests during build (default: `false`)
- `testSSR` - Validate SSR output (default: `false`)
- `testHydration` - Test hydration directives (default: `false`)
- `testIslands` - Test island isolation (default: `false`)

## Features

### SSR Testing

Validates that components render correctly on the server side.

### Hydration Testing

Tests Astro's hydration directives:
- `client:load`
- `client:visible`
- `client:idle`
- `client:only`

### Island Isolation

Verifies that Astro islands are properly isolated and hydrate independently.

## Test Runner

The integration adds a `/__autotester` route to your dev server to view test results.

## License

MIT
