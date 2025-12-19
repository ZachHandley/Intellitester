import type { AstroIntegration } from 'astro';
import { autotester as vitePlugin } from 'vite-plugin-autotester';
import type { AstroAutotesterOptions } from './types';
import { validateSSROutput } from './ssr-testing';
import { testHydrationDirectives } from './hydration';

export function createIntegration(options: AstroAutotesterOptions = {}): AstroIntegration {
  return {
    name: '@autotester/astro',
    hooks: {
      'astro:config:setup': ({ updateConfig, injectRoute, logger }) => {
        logger.info('Setting up AutoTester integration');

        // Add Vite plugin
        updateConfig({
          vite: {
            plugins: [vitePlugin({
              testsDir: options.testsDir,
              runOnBuild: options.runOnBuild,
            })]
          }
        });

        // Inject test runner route
        injectRoute({
          pattern: '/__autotester',
          entrypoint: '@autotester/astro/pages/test-runner.astro'
        });
      },

      'astro:server:setup': ({ server, logger }) => {
        logger.info('AutoTester dev server ready');
        // Could add custom middleware here
      },

      'astro:build:done': async ({ dir, routes, logger }) => {
        if (options.testSSR) {
          logger.info('Running SSR tests...');
          const result = await validateSSROutput(dir, routes);
          if (!result.passed) {
            logger.error('SSR tests failed: ' + result.errors.join(', '));
          }
        }

        if (options.testHydration) {
          logger.info('Running hydration tests...');
          // Run hydration tests
        }
      }
    }
  };
}
