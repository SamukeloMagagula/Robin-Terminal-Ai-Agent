import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CopilotProvider } from '../../src/providers/copilot';
import { AuthStore } from '../../src/auth-store';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';

/** Shape of the real GET /models response, trimmed to the fields we read. */
function modelsBody(entries: { id: string; type: string }[]) {
  return {
    data: entries.map((e) => ({
      id: e.id,
      name: e.id,
      // model_picker_enabled is false on every real entry, including working
      // models, which is why it must not be used as a filter.
      model_picker_enabled: false,
      capabilities: { type: e.type },
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CopilotProvider.listModels', () => {
  let provider: CopilotProvider;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-models-'));
    const authStore = new AuthStore(path.join(dir, 'auth.json'));
    await authStore.set('copilot', { githubToken: 'gh-token' });
    // The second argument matters: without it the provider filters against the
    // real ~/.robin/unsupported-models.json, and these expectations then depend
    // on which models the machine running the tests has happened to try.
    provider = new CopilotProvider(
      authStore,
      new UnsupportedModelStore(path.join(dir, 'unsupported.json'))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** First call is the Copilot token exchange, second is the catalogue. */
  function mockFetch(catalogue: Response) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('copilot_internal/v2/token')) {
        return jsonResponse({ token: 'copilot-token', expires_at: Date.now() / 1000 + 3600 });
      }
      return catalogue;
    });
  }

  it('returns the chat models the API reports', async () => {
    mockFetch(
      jsonResponse(
        modelsBody([
          { id: 'claude-sonnet-5', type: 'chat' },
          { id: 'gpt-5.4', type: 'chat' },
        ])
      )
    );
    expect(await provider.listModels()).toEqual(['claude-sonnet-5', 'gpt-5.4']);
  });

  // capabilities.type is the authoritative discriminator; the live catalogue
  // mixes 3 embedding models in with 49 chat models.
  it('drops embedding models', async () => {
    mockFetch(
      jsonResponse(
        modelsBody([
          { id: 'gpt-4o', type: 'chat' },
          { id: 'text-embedding-3-small', type: 'embeddings' },
          { id: 'text-embedding-ada-002', type: 'embeddings' },
        ])
      )
    );
    expect(await provider.listModels()).toEqual(['gpt-4o']);
  });

  it('falls back to a known pair when the catalogue call fails', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 500));
    expect(await provider.listModels()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('falls back when the catalogue is empty of chat models', async () => {
    mockFetch(jsonResponse(modelsBody([{ id: 'text-embedding-3-small', type: 'embeddings' }])));
    expect(await provider.listModels()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('falls back when the response body is malformed', async () => {
    mockFetch(jsonResponse({ unexpected: true }));
    expect(await provider.listModels()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('falls back rather than throwing when the network fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await provider.listModels()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });
});
