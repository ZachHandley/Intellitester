/**
 * Performance-optimized browser launch options
 * These settings help with slow page loads and work well in both local and CI/Docker environments
 */

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

/**
 * Viewport sizes matching Tailwind breakpoints for responsive testing.
 */
export type ViewportSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export const VIEWPORT_SIZES: Record<ViewportSize, { width: number; height: number }> = {
  xs: { width: 320, height: 568 },   // Mobile portrait
  sm: { width: 640, height: 800 },   // Small tablet
  md: { width: 768, height: 1024 },  // Tablet
  lg: { width: 1024, height: 768 },  // Desktop
  xl: { width: 1280, height: 720 },  // Large desktop
};

/**
 * Parse a viewport size string into width and height dimensions.
 * Accepts either a named size ('xs', 'sm', 'md', 'lg', 'xl') or a custom
 * dimension string like '1280x800' or '1920x1080'.
 *
 * @param size - The viewport size string to parse
 * @returns The parsed dimensions, or null if invalid
 */
export function parseViewportSize(size: string): { width: number; height: number } | null {
  // Check if it's a named size
  if (size in VIEWPORT_SIZES) {
    return VIEWPORT_SIZES[size as ViewportSize];
  }

  // Try to parse as WxH format (e.g., '1280x800', '1920x1080')
  const match = size.match(/^(\d+)x(\d+)$/);
  if (match) {
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  return null;
}

/**
 * Browser-specific timing configuration for wait strategies.
 * Different browsers have varying network idle detection behavior.
 */
export interface BrowserTimingConfig {
  networkIdleTimeout: number;
  screenshotNetworkIdleTimeout: number;
}

/**
 * Get browser-specific timing configuration.
 * Firefox needs longer timeouts as its network idle detection can be inconsistent.
 */
export function getBrowserTimingConfig(browser: BrowserName): BrowserTimingConfig {
  switch (browser) {
    case 'firefox':
      return {
        networkIdleTimeout: 15000,           // 50% longer for Firefox
        screenshotNetworkIdleTimeout: 8000,
      };
    case 'webkit':
      return {
        networkIdleTimeout: 12000,
        screenshotNetworkIdleTimeout: 6000,
      };
    default: // chromium
      return {
        networkIdleTimeout: 10000,
        screenshotNetworkIdleTimeout: 5000,
      };
  }
}

export interface BrowserLaunchOptions {
  headless: boolean;
  browser?: BrowserName;
}

/**
 * Get optimized launch options for Playwright browsers
 * Returns browser-specific options to avoid compatibility issues
 */
export function getBrowserLaunchOptions(options: BrowserLaunchOptions) {
  const { headless, browser } = options;

  // Chromium-specific flags (not supported by Firefox/WebKit)
  if (browser === 'chromium' || !browser) {
    return {
      headless,
      args: [
        // Use Chrome's new headless mode which behaves more like regular browser
        ...(headless ? ['--headless=new'] : []),

        // For Docker/CI environments - disables sandboxing (required for root/container)
        '--no-sandbox',

        // Shared memory - critical for Docker/CI, harmless locally
        '--disable-dev-shm-usage',

        // GPU acceleration - not needed in headless mode
        '--disable-gpu',

        // Set explicit window size (fallback for viewport)
        '--window-size=1920,1080',

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

  // Firefox-specific optimizations (via firefoxUserPrefs)
  if (browser === 'firefox') {
    return {
      headless,
      firefoxUserPrefs: {
        // Enable JIT (disabled in automation mode by default, causes 2-4x JS slowdown)
        'javascript.options.jit': true,
        // Disable fission for stability/speed
        'fission.autostart': false,
        // Disable hardware acceleration overhead in headless
        'layers.acceleration.disabled': true,
        'gfx.webrender.all': false,

        // Disable speculative network activity that interferes with networkidle detection
        // These are prefetch/preconnect features, NOT actual workers or app functionality
        'network.http.speculative-parallel-limit': 0,  // Disable speculative connections
        'network.predictor.enabled': false,            // Disable network predictor
        'network.prefetch-next': false,                // Disable link prefetching
        'network.dns.disablePrefetch': true,           // Disable DNS prefetch
      },
    };
  }

  // WebKit/Safari - minimal options (no Chrome flags supported)
  return { headless };
}
