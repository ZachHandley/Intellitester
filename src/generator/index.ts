/**
 * Test generator module - converts natural language to YAML test definitions
 */

export { generateTest } from './testGenerator';
export type { GeneratorOptions, GeneratorResult } from './testGenerator';
export { SYSTEM_PROMPT, buildPrompt, buildSourceAwareSystemPrompt } from './prompts';
export type { PromptContext } from './prompts';
export { scanProjectSource, formatScanResultsForPrompt } from './sourceScanner';
export type { SourceConfig, SourceScanResult, RouteInfo, ComponentInfo } from './sourceScanner';
export { extractElements } from './elementExtractor';
export type { ElementInfo } from './elementExtractor';
