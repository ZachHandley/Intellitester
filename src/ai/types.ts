export type AIConfig = {
  provider: 'anthropic' | 'openai' | 'ollama' | 'groq' | 'openrouter';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
};

export interface AIProvider {
  generateCompletion(prompt: string, systemPrompt?: string): Promise<string>;
  generateVisionCompletion?(
    prompt: string,
    imageBase64: string,
    imageMimeType: string,
    systemPrompt?: string,
  ): Promise<string>;
}
