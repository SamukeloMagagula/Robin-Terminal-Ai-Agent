import * as readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
import { AuthStore } from '../auth-store.js';
import { announceAndOpen } from '../browser.js';
import { ChatRequestError } from './chat-error.js';
import { toAnthropicRequest, toAnthropicTools } from './anthropic-wire.js';

const API_KEY_PAGE = 'https://platform.claude.com/settings/keys';

/**
 * Every current Claude model caps output at 128K except Haiku 4.5, which caps
 * at 64K. 64000 is therefore the largest value valid on every model, and the
 * request always streams, so there is no HTTP-timeout reason to go lower.
 */
const MAX_TOKENS = 64_000;

/**
 * Used when the picker is unavailable — the models endpoint needs a valid key,
 * and `robin chat anthropic` should still start.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

const FALLBACK_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
];

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';

  constructor(private readonly authStore: AuthStore = new AuthStore()) {}

  async isAuthenticated(): Promise<boolean> {
    const stored = await this.authStore.get(this.id);
    return typeof stored?.apiKey === 'string';
  }

  async login(): Promise<void> {
    announceAndOpen(API_KEY_PAGE);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let apiKey: string;
    try {
      apiKey = (await rl.question('Paste your Anthropic API key: ')).trim();
    } finally {
      rl.close();
    }
    if (!apiKey) throw new Error('No API key entered.');
    await this.authStore.set(this.id, { apiKey });
  }

  async logout(): Promise<void> {
    await this.authStore.delete(this.id);
  }

  private async client(): Promise<Anthropic> {
    const stored = await this.authStore.get(this.id);
    const apiKey = stored?.apiKey as string | undefined;
    if (!apiKey) throw new Error('Not logged in to Anthropic. Run `login anthropic` first.');
    return new Anthropic({ apiKey });
  }

  async listModels(): Promise<string[]> {
    try {
      const client = await this.client();
      const ids: string[] = [];
      for await (const model of client.models.list()) {
        ids.push(model.id);
      }
      return ids.length > 0 ? ids : FALLBACK_MODELS;
    } catch {
      // A hardcoded list beats an empty picker; the ids are stable strings.
      return FALLBACK_MODELS;
    }
  }

  async *chat(
    model: string,
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent> {
    const client = await this.client();
    const { system, messages: wireMessages } = toAnthropicRequest(messages);
    const wireTools = toAnthropicTools(tools);

    // No temperature/top_p/top_k: current Claude models reject them with a 400.
    // Thinking is left at the model's default (adaptive on Opus 5) rather than
    // disabled — disabling it is capped at `high` effort and has two documented
    // failure modes, including tool calls emitted as plain text that then never
    // run. `display: summarized` is set so reasoning is visible rather than
    // showing as a silent pause before output.
    const stream = client.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(system ? { system } : {}),
        ...(wireTools.length > 0 ? { tools: wireTools } : {}),
        messages: wireMessages,
      },
      { signal }
    );

    try {
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'thinking', text: event.delta.thinking };
        }
        // input_json_delta is deliberately ignored — tool arguments are taken
        // whole from the final message rather than reassembled from partial
        // JSON fragments.
      }

      const final = await stream.finalMessage();

      if (final.stop_reason === 'refusal') {
        throw new ChatRequestError(
          `Anthropic declined this request${describeRefusal(final)}.`,
          { status: 403, code: 'refusal' }
        );
      }

      for (const block of final.content) {
        if (block.type === 'tool_use') {
          yield {
            type: 'tool_call',
            toolCall: {
              id: block.id,
              name: block.name,
              // Robin's ToolCall carries arguments as a JSON string; the SDK
              // hands back a parsed object.
              arguments: JSON.stringify(block.input ?? {}),
            },
          };
        }
      }
    } catch (err) {
      throw toChatError(err);
    }
  }
}

function describeRefusal(message: Anthropic.Message): string {
  const details = (message as { stop_details?: { category?: string | null } }).stop_details;
  return details?.category ? ` (${details.category})` : '';
}

/**
 * Maps the SDK's typed errors onto ChatRequestError so the shared fallback
 * logic keeps working — `isProviderQuotaExhausted` reads status 429/402 and
 * `isModelUnsupported` reads 404, neither of which it can see through an
 * SDK-specific error class.
 */
function toChatError(err: unknown): unknown {
  if (err instanceof ChatRequestError) return err;
  // A cancellation must stay recognisable as one, or the fallback chain fires.
  if (err instanceof Error && err.name === 'AbortError') return err;

  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 500;
    const serverMessage = extractServerMessage(err);
    return new ChatRequestError(
      `Anthropic ${status} (request failed)${serverMessage ? ` — ${serverMessage}` : ''}`,
      { status, code: err.type ?? undefined, serverMessage }
    );
  }
  return err;
}

// Typed as unknown rather than Anthropic.APIError: the SDK exposes APIError as
// a value (usable with instanceof) but not as a type in that namespace.
function extractServerMessage(err: unknown): string | undefined {
  const body = (err as { error?: { error?: { message?: unknown } } }).error;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : undefined;
}
