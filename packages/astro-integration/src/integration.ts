import type { AstroIntegration } from 'astro';
import { intellitester as vitePlugin } from 'vite-plugin-intellitester';
import type { AstroIntellitesterOptions } from './types';
import { validateSSROutput } from './ssr-testing';
import { testHydrationDirectives } from './hydration';

export function createIntegration(options: AstroIntellitesterOptions = {}): AstroIntegration {
  return {
    name: '@intellitester/astro',
    hooks: {
      'astro:config:setup': ({ updateConfig, injectRoute, logger }) => {
        logger.info('Setting up IntelliTester integration');

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
          pattern: '/__intellitester',
          entrypoint: '@intellitester/astro/pages/test-runner.astro'
        });
      },

      'astro:server:setup': ({ server, logger }) => {
        logger.info('IntelliTester dev server ready');
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
