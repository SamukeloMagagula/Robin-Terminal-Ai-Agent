import type { Provider, Message, ChatEvent, ToolDefinition } from './types.js';
import { AuthStore } from '../auth-store.js';
import { openBrowser } from '../browser.js';
import { UnsupportedModelStore } from './unsupported-models.js';
import { toOpenAiWireMessage, toOpenAiToolsPayload, streamOpenAiCompatibleChat } from './openai-compatible.js';

const CLIENT_ID = '01ab8ac9400c4e429b23';
const COPILOT_API = 'https://api.githubcopilot.com';
const EDITOR_VERSION = 'vscode/1.85.1';
const INTEGRATION_ID = 'vscode-chat';
/** Used only when the catalogue call fails, so the picker is never empty. */
const FALLBACK_MODELS = ['gpt-4o', 'gpt-4o-mini'];

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CopilotProvider implements Provider {
  readonly id = 'copilot';
  readonly name = 'GitHub Copilot';

  private copilotToken: string | undefined;
  private copilotTokenExpiresAt = 0;

  constructor(
    private readonly authStore: AuthStore = new AuthStore(),
    private readonly unsupportedStore: UnsupportedModelStore = new UnsupportedModelStore()
  ) {}

  async isAuthenticated(): Promise<boolean> {
    const stored = await this.authStore.get(this.id);
    return typeof stored?.githubToken === 'string';
  }

  async login(): Promise<void> {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
    });
    if (!res.ok) throw new Error(`Failed to start device login: ${res.status}`);
    const data = (await res.json()) as DeviceCodeResponse;

    console.log(`Go to ${data.verification_uri} and enter code: ${data.user_code}`);
    if (openBrowser(data.verification_uri_complete ?? data.verification_uri)) {
      console.log('Opening your browser to authorize...');
    } else {
      console.log('No graphical browser detected here (e.g. an SSH/PuTTY session) — open the link above on a device with a browser.');
    }

    const githubToken = await this.pollForToken(data.device_code, data.interval, data.expires_in);
    await this.authStore.set(this.id, { githubToken });
  }

  private async pollForToken(
    deviceCode: string,
    intervalSeconds: number,
    expiresInSeconds = 900
  ): Promise<string> {
    let interval = intervalSeconds;
    // GitHub expires the device code; without this the loop would poll forever
    // on a permanent `authorization_pending` and never hand control back.
    const deadline = Date.now() + expiresInSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(interval * 1000);
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data = (await res.json()) as AccessTokenResponse;
      if (data.access_token) return data.access_token;
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        interval += 5;
        continue;
      }
      throw new Error(`GitHub device login failed: ${data.error ?? 'unknown error'}`);
    }
    throw new Error('GitHub device login timed out — the code expired. Run `login copilot` again.');
  }

  private async getCopilotToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.copilotToken && now < this.copilotTokenExpiresAt - 60) {
      return this.copilotToken;
    }
    const stored = await this.authStore.get(this.id);
    const githubToken = stored?.githubToken as string | undefined;
    if (!githubToken) throw new Error('Not logged in to Copilot. Run `login copilot` first.');

    const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: { authorization: `token ${githubToken}` },
    });
    if (!res.ok) throw new Error(`Failed to refresh Copilot token: ${res.status}`);
    const data = (await res.json()) as CopilotTokenResponse;
    this.copilotToken = data.token;
    this.copilotTokenExpiresAt = data.expires_at;
    return this.copilotToken;
  }

  /**
   * The catalogue is served by the API, not hardcoded — it currently lists ~50
   * models against the two this used to return.
   *
   * `capabilities.type` is the authoritative chat/embeddings discriminator;
   * `model_picker_enabled` is false on every entry, including working models,
   * so it cannot be used as a filter. If the call fails, fall back to a pair
   * known to exist rather than leaving the user with no models at all.
   */
  async listModels(): Promise<string[]> {
    try {
      const token = await this.getCopilotToken();
      const res = await fetch(`${COPILOT_API}/models`, {
        headers: {
          authorization: `Bearer ${token}`,
          'Editor-Version': EDITOR_VERSION,
          'Copilot-Integration-Id': INTEGRATION_ID,
        },
      });
      if (!res.ok) return FALLBACK_MODELS;
      const body = (await res.json()) as {
        data?: { id?: string; capabilities?: { type?: string } }[];
      };
      const ids = (body.data ?? [])
        .filter((m) => m.capabilities?.type === 'chat' && typeof m.id === 'string')
        .map((m) => m.id as string);
      if (ids.length === 0) return FALLBACK_MODELS;
      // The catalogue advertises models this account cannot call and nothing
      // in it says which, so drop the ones already proven unsupported.
      const usable = await this.unsupportedStore.filter(this.id, ids);
      return usable.length > 0 ? usable : FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    }
  }

  async *chat(model: string, messages: Message[], tools?: ToolDefinition[]): AsyncIterable<ChatEvent> {
    const token = await this.getCopilotToken();
    const res = await fetch(`${COPILOT_API}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'Editor-Version': EDITOR_VERSION,
        'Editor-Plugin-Version': 'copilot-chat/0.12.0',
        'Copilot-Integration-Id': INTEGRATION_ID,
      },
      body: JSON.stringify({
        model,
        messages: messages.map(toOpenAiWireMessage),
        stream: true,
        ...toOpenAiToolsPayload(tools),
      }),
    });
    yield* streamOpenAiCompatibleChat(res, 'Copilot');
  }

  async logout(): Promise<void> {
    await this.authStore.delete(this.id);
    this.copilotToken = undefined;
    this.copilotTokenExpiresAt = 0;
  }
}
