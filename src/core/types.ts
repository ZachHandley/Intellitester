import type { z } from 'zod';

import {
  ActionSchema,
  AutotesterConfigSchema,
  LocatorSchema,
  TestConfigSchema,
  TestDefinitionSchema,
} from './schema';

export type Locator = z.infer<typeof LocatorSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type TestConfig = z.infer<typeof TestConfigSchema>;
export type TestDefinition = z.infer<typeof TestDefinitionSchema>;
export type AutotesterConfig = z.infer<typeof AutotesterConfigSchema>;
export type WebServer = NonNullable<AutotesterConfig['webServer']>;
