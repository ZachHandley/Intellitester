import { CompletionModel } from 'blazen';
import type {
  JsAzureOptions,
  JsBedrockOptions,
  JsCompletionOptions,
  JsFalOptions,
  JsOpenAiCompatConfig,
  JsProviderOptions,
} from 'blazen';
import type { AIConfig, AIProvider } from './types';

const DEFAULT_OLLAMA_HOST = 'localhost';
const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_LM_STUDIO_HOST = 'localhost';
const DEFAULT_LM_STUDIO_PORT = 1234;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

function resolveEnvInValue(value: unknown): unknown {
  if (typeof value === 'string') return resolveEnvVars(value);
  if (Array.isArray(value)) return value.map(resolveEnvInValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveEnvInValue(v);
    }
    return out;
  }
  return value;
}

function resolveProviderOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!options) return {};
  return resolveEnvInValue(options) as Record<string, unknown>;
}

function requireString(
  options: Record<string, unknown>,
  key: string,
  provider: AIProvider,
): string {
  const v = options[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(
      `provider "${provider}" requires providerOptions.${key} (string)`,
    );
  }
  return v;
}

function optionalNumber(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = options[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

const STANDARD_PROVIDERS = {
  anthropic: CompletionModel.anthropic,
  openai: CompletionModel.openai,
  gemini: CompletionModel.gemini,
  openrouter: CompletionModel.openrouter,
  groq: CompletionModel.groq,
  together: CompletionModel.together,
  mistral: CompletionModel.mistral,
  deepseek: CompletionModel.deepseek,
  fireworks: CompletionModel.fireworks,
  perplexity: CompletionModel.perplexity,
  xai: CompletionModel.xai,
  cohere: CompletionModel.cohere,
} as const satisfies Record<
  string,
  (options?: JsProviderOptions | null) => CompletionModel
>;

type StandardProvider = keyof typeof STANDARD_PROVIDERS;

function isStandardProvider(provider: AIProvider): provider is StandardProvider {
  return provider in STANDARD_PROVIDERS;
}

export function buildModel(config: AIConfig): CompletionModel {
  const apiKey = config.apiKey ? resolveEnvVars(config.apiKey) : undefined;
  const { provider, model, baseUrl } = config;
  const providerOptions = resolveProviderOptions(config.providerOptions);

  if (isStandardProvider(provider)) {
    const options: JsProviderOptions = {
      ...(providerOptions as JsProviderOptions),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
    return STANDARD_PROVIDERS[provider](options);
  }

  switch (provider) {
    case 'ollama': {
      // Preserve historical openai-compat behaviour for configs that don't
      // explicitly opt into native host/port options. Existing configs that
      // set only baseUrl (or nothing at all) keep working unchanged.
      const hasNativeOpts = 'host' in providerOptions || 'port' in providerOptions;
      if (!hasNativeOpts) {
        return CompletionModel.openai({
          apiKey: apiKey ?? 'ollama',
          baseUrl: baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
          model,
        });
      }
      const host = (providerOptions.host as string | undefined) ?? DEFAULT_OLLAMA_HOST;
      const port = optionalNumber(providerOptions, 'port', DEFAULT_OLLAMA_PORT);
      return CompletionModel.ollama(host, port, model);
    }
    case 'lmStudio': {
      const host = (providerOptions.host as string | undefined) ?? DEFAULT_LM_STUDIO_HOST;
      const port = optionalNumber(providerOptions, 'port', DEFAULT_LM_STUDIO_PORT);
      return CompletionModel.lmStudio(host, port, model);
    }
    case 'azure': {
      const azureOptions: JsAzureOptions = {
        ...(providerOptions as Partial<JsAzureOptions>),
        resourceName: requireString(providerOptions, 'resourceName', 'azure'),
        deploymentName: requireString(providerOptions, 'deploymentName', 'azure'),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      };
      return CompletionModel.azure(azureOptions);
    }
    case 'bedrock': {
      const bedrockOptions: JsBedrockOptions = {
        ...(providerOptions as Partial<JsBedrockOptions>),
        region: requireString(providerOptions, 'region', 'bedrock'),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      };
      return CompletionModel.bedrock(bedrockOptions);
    }
    case 'fal': {
      const falOptions: JsFalOptions = {
        ...(providerOptions as Partial<JsFalOptions>),
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      };
      return CompletionModel.fal(falOptions);
    }
    case 'openaiCompat': {
      const providerId =
        typeof providerOptions.providerId === 'string'
          ? (providerOptions.providerId as string)
          : 'custom';
      const compatConfig: JsOpenAiCompatConfig = {
        ...(providerOptions as Partial<JsOpenAiCompatConfig>),
        providerName: requireString(providerOptions, 'providerName', 'openaiCompat'),
        baseUrl: baseUrl ?? requireString(providerOptions, 'baseUrl', 'openaiCompat'),
        apiKey: apiKey ?? requireString(providerOptions, 'apiKey', 'openaiCompat'),
        defaultModel:
          model ||
          (typeof providerOptions.defaultModel === 'string'
            ? (providerOptions.defaultModel as string)
            : (() => {
                throw new Error(
                  'provider "openaiCompat" requires either a top-level model or providerOptions.defaultModel',
                );
              })()),
      };
      return CompletionModel.openaiCompat(providerId, compatConfig);
    }
  }
}

export function buildCompletionOptions(config: AIConfig): JsCompletionOptions {
  return {
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    model: config.model,
  };
}
