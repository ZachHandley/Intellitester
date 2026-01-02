export interface AstroIntellitesterOptions {
  // Inherited from Vite plugin
  testsDir?: string;
  runOnBuild?: boolean;

  // Astro-specific
  testSSR?: boolean;           // Validate SSR output
  testHydration?: boolean;     // Test hydration directives
  testIslands?: boolean;       // Test island isolation
}
