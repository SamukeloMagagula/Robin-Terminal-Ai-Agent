import type { Provider } from './types.js';
import { CopilotProvider } from './copilot.js';
import { OllamaProvider } from './ollama.js';
import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { AnthropicProvider } from './anthropic.js';

const providers: Provider[] = [
  new CopilotProvider(),
  new OllamaProvider(),
  new GeminiProvider(),
  new OpenRouterProvider(),
  new AnthropicProvider(),
];

export function listProviders(): Provider[] {
  return providers;
}

export function getProvider(id: string): Provider {
  const provider = providers.find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Unknown provider "${id}". Available: ${providers.map((p) => p.id).join(', ')}`);
  }
  return provider;
}

export type { Provider, Message } from './types.js';
