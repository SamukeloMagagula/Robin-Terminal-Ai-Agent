import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CopilotProvider } from '../../src/providers/copilot';
import { AuthStore } from '../../src/auth-store';

describe('CopilotProvider', () => {
  let tmpFile: string;
  let authStore: AuthStore;
  let provider: CopilotProvider;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-test-'));
    tmpFile = path.join(dir, 'auth.json');
    authStore = new AuthStore(tmpFile);
    provider = new CopilotProvider(authStore);
  });

  it('isAuthenticated is false with no stored token', async () => {
    expect(await provider.isAuthenticated()).toBe(false);
  });

  it('isAuthenticated is true after a github token is stored', async () => {
    await authStore.set('copilot', { githubToken: 'gh-token' });
    expect(await provider.isAuthenticated()).toBe(true);
  });

  it('login prints the verification link and polls until approved', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: 'dev123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 900,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'authorization_pending' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gh-token-final' }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const loginPromise = provider.login();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await loginPromise;

    vi.useRealTimers();
    expect(await authStore.get('copilot')).toEqual({ githubToken: 'gh-token-final' });
  });

  it('chat streams content deltas parsed from SSE', async () => {
    await authStore.set('copilot', { githubToken: 'gh-token' });
    const encoder = new TextEncoder();
    const sseLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' there' } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('copilot_internal')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            token: 'copilot-token',
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
        });
      }
      let i = 0;
      return Promise.resolve({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (i < sseLines.length) {
                return { done: false, value: encoder.encode(sseLines[i++]) };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      });
    }) as unknown as typeof fetch;

    const events: { type: string; text?: string }[] = [];
    for await (const event of provider.chat('gpt-4o', [{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'text', text: ' there' },
    ]);
  });

  it('logout clears the stored token', async () => {
    await authStore.set('copilot', { githubToken: 'gh-token' });
    await provider.logout();
    expect(await authStore.get('copilot')).toBeUndefined();
  });
});
