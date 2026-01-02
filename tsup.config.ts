import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
    'integration/index': 'src/integration/index.ts',
    'core/cleanup/index': 'src/core/cleanup/index.ts',
    'providers/index': 'src/providers/index.ts',
    'providers/appwrite/index': 'src/providers/appwrite/index.ts',
    'providers/postgres/index': 'src/providers/postgres/index.ts',
    'providers/mysql/index': 'src/providers/mysql/index.ts',
    'providers/sqlite/index': 'src/providers/sqlite/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  outDir: 'dist',
  target: 'node18',
  shims: true,
});
