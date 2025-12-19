export type AIConfig = {
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
};

export interface AIProvider {
  generateCompletion(prompt: string, systemPrompt?: string): Promise<string>;
}
