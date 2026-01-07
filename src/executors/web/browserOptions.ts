/**
 * Performance-optimized browser launch options
 * These settings help with slow page loads and work well in both local and CI/Docker environments
 */

export interface BrowserLaunchOptions {
  headless: boolean;
}

/**
 * Get optimized launch options for Playwright browsers
 */
export function getBrowserLaunchOptions(options: BrowserLaunchOptions) {
  return {
    headless: options.headless,
    args: [
      // Shared memory - critical for Docker/CI, harmless locally
      '--disable-dev-shm-usage',

      // GPU acceleration - not needed in headless mode
      '--disable-gpu',

      // Reduce overhead
      '--disable-extensions',

      // Prevent JavaScript throttling (helps with slow page loads)
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',

      // Process isolation - reduces overhead for testing
      '--disable-features=IsolateOrigins,site-per-process',

      // Networking tweaks
      '--disable-features=VizDisplayCompositor',
      '--disable-blink-features=AutomationControlled',
    ],
  };
}
