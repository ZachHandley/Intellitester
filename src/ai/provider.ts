import { Anthropic } from '@llamaindex/anthropic';
import { OpenAI } from '@llamaindex/openai';
import { Ollama } from '@llamaindex/ollama';
import type { AIConfig, AIProvider } from './types';

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
    const apiKey = config.apiKey ? resolveEnvVars(config.apiKey) : undefined;
    this.client = new Anthropic({
      apiKey,
      model: this.config.model,
      temperature: this.config.temperature,
    });
  }

  async generateCompletion(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.client.chat({ messages });

    const content = response.message.content;
    if (!content) {
      throw new Error('No content in Anthropic response');
    }
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}

class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
    const apiKey = config.apiKey ? resolveEnvVars(config.apiKey) : undefined;
    const baseURL = config.baseUrl;
    this.client = new OpenAI({
      apiKey,
      model: this.config.model,
      temperature: this.config.temperature,
      baseURL,
    });
  }

  async generateCompletion(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.client.chat({ messages });

    const content = response.message.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
    }
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}

class OllamaProvider implements AIProvider {
  private client: Ollama;
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
    this.client = new Ollama({
      model: this.config.model,
      options: {
        temperature: this.config.temperature,
      },
    });
  }

  async generateCompletion(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.client.chat({ messages });

    const content = response.message.content;
    if (!content) {
      throw new Error('No content in Ollama response');
    }
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}

export function createAIProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
  }
}
