export const SUPPORTED_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'groq',
  'together',
  'mistral',
  'deepseek',
  'fireworks',
  'perplexity',
  'xai',
  'cohere',
  'azure',
  'bedrock',
  'fal',
  'ollama',
  'lmStudio',
  'openaiCompat',
] as const;

export type AIProvider = (typeof SUPPORTED_PROVIDERS)[number];

export type AIConfig = {
  provider: AIProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
  providerOptions?: Record<string, unknown>;
};
