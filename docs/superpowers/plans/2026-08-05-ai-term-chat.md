# ai-term-chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js/TypeScript terminal CLI that lets the user chat with GitHub Copilot (via GitHub device-code OAuth login) or local Ollama models, from an interactive REPL.

**Architecture:** A small `Provider` interface (`isAuthenticated`, `login`, `listModels`, `chat`, `logout`) implemented once for Copilot and once for Ollama, registered in a lookup table. A `commander`-based CLI wires `login`/`logout`/`chat` commands and a default interactive picker to a `readline`-based chat REPL that streams tokens.

**Tech Stack:** Node.js >= 18 (for global `fetch`), TypeScript (strict), `commander`, `@inquirer/prompts`, `chalk`, `vitest`.

## Global Constraints

- Node.js >= 18 required (uses global `fetch`, no `node-fetch` dependency).
- TypeScript `strict: true`.
- `~/.ai-term-chat/auth.json` must be written with `0600` permissions; never persist short-lived derived tokens (e.g. Copilot's Copilot-API token) to disk, only in memory.
- No unit test may make a real network call to GitHub or Ollama — all HTTP is mocked via `global.fetch`.
- No chat history is persisted across process restarts (in-memory only, per session).
- Module system: ESM (`"type": "module"` in package.json), `NodeNext` module resolution.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Produces: an `npm run build` command (tsc → `dist/`) and `npm test` command (`vitest run`) that later tasks rely on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ai-term-chat",
  "version": "0.1.0",
  "description": "Terminal chat client for AI models (GitHub Copilot, Ollama)",
  "type": "module",
  "bin": {
    "ai-term-chat": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/cli.js"
  },
  "dependencies": {
    "@inquirer/prompts": "^5.3.8",
    "chalk": "^5.3.0",
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.0.5",
    "@types/node": "^20.14.15"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` created, no errors.

- [ ] **Step 5: Write a trivial smoke test to verify vitest is wired up**

`tests/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run tests to verify the toolchain works**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore tests/smoke.test.ts
git commit -m "chore: scaffold project"
```

---

### Task 2: Auth store

**Files:**
- Create: `src/auth-store.ts`
- Test: `tests/auth-store.test.ts`

**Interfaces:**
- Produces: `AuthStore` class with `read()`, `get(providerId)`, `set(providerId, value)`, `delete(providerId)`; `defaultAuthPath()` function. Later tasks (Copilot provider, CLI) construct `new AuthStore()` for the default `~/.ai-term-chat/auth.json` path, or `new AuthStore(customPath)` in tests.

- [ ] **Step 1: Write the failing tests**

`tests/auth-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuthStore } from '../src/auth-store';

describe('AuthStore', () => {
  let tmpFile: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-store-test-'));
    tmpFile = path.join(dir, 'auth.json');
  });

  it('returns empty object when file does not exist', async () => {
    const store = new AuthStore(tmpFile);
    expect(await store.read()).toEqual({});
  });

  it('round-trips a value through set/get', async () => {
    const store = new AuthStore(tmpFile);
    await store.set('copilot', { token: 'abc123' });
    expect(await store.get('copilot')).toEqual({ token: 'abc123' });
  });

  it('deletes a stored value', async () => {
    const store = new AuthStore(tmpFile);
    await store.set('copilot', { token: 'abc123' });
    await store.delete('copilot');
    expect(await store.get('copilot')).toBeUndefined();
  });

  it('preserves other providers when setting one', async () => {
    const store = new AuthStore(tmpFile);
    await store.set('copilot', { token: 'a' });
    await store.set('ollama', { note: 'b' });
    expect(await store.get('copilot')).toEqual({ token: 'a' });
    expect(await store.get('ollama')).toEqual({ note: 'b' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- auth-store`
Expected: FAIL — `src/auth-store.ts` does not exist.

- [ ] **Step 3: Implement `src/auth-store.ts`**

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type AuthData = Record<string, Record<string, unknown>>;

export function defaultAuthPath(): string {
  return path.join(os.homedir(), '.ai-term-chat', 'auth.json');
}

export class AuthStore {
  constructor(private readonly filePath: string = defaultAuthPath()) {}

  async read(): Promise<AuthData> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as AuthData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  async get(providerId: string): Promise<Record<string, unknown> | undefined> {
    const data = await this.read();
    return data[providerId];
  }

  async set(providerId: string, value: Record<string, unknown>): Promise<void> {
    const data = await this.read();
    data[providerId] = value;
    await this.write(data);
  }

  async delete(providerId: string): Promise<void> {
    const data = await this.read();
    delete data[providerId];
    await this.write(data);
  }

  private async write(data: AuthData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- auth-store`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/auth-store.ts tests/auth-store.test.ts
git commit -m "feat: add auth store for persisting provider tokens"
```

---

### Task 3: Ollama provider

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/ollama.ts`
- Test: `tests/providers/ollama.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Message` type `{ role: 'user' | 'assistant' | 'system'; content: string }` and `Provider` interface `{ id, name, isAuthenticated(), login(), listModels(), chat(model, messages), logout() }` in `src/providers/types.ts`, reused by the Copilot provider (Task 4) and registry (Task 5). `OllamaProvider` class implementing `Provider`.

- [ ] **Step 1: Write `src/providers/types.ts`**

```ts
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Provider {
  id: string;
  name: string;
  isAuthenticated(): Promise<boolean>;
  login(): Promise<void>;
  listModels(): Promise<string[]>;
  chat(model: string, messages: Message[]): AsyncIterable<string>;
  logout(): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

`tests/providers/ollama.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../../src/providers/ollama';

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider();
  });

  it('isAuthenticated returns true when server responds ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    expect(await provider.isAuthenticated()).toBe(true);
  });

  it('isAuthenticated returns false when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    expect(await provider.isAuthenticated()).toBe(false);
  });

  it('login throws an instructional error when server is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(provider.login()).rejects.toThrow(/ollama serve/);
  });

  it('listModels parses model names from /api/tags', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3' }, { name: 'phi3' }] }),
    }) as unknown as typeof fetch;
    expect(await provider.listModels()).toEqual(['llama3', 'phi3']);
  });

  it('chat yields streamed content chunks', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Hel' } }) + '\n',
      JSON.stringify({ message: { content: 'lo' } }) + '\n',
      JSON.stringify({ done: true }) + '\n',
    ];
    let i = 0;
    const encoder = new TextEncoder();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < lines.length) {
              return { done: false, value: encoder.encode(lines[i++]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const chunk of provider.chat('llama3', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('Hello');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- ollama`
Expected: FAIL — `src/providers/ollama.ts` does not exist.

- [ ] **Step 4: Implement `src/providers/ollama.ts`**

```ts
import type { Provider, Message } from './types.js';

const BASE_URL = 'http://localhost:11434';

interface TagsResponse {
  models: { name: string }[];
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';

  async isAuthenticated(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE_URL}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async login(): Promise<void> {
    const ok = await this.isAuthenticated();
    if (!ok) {
      throw new Error(
        'Ollama is not reachable at http://localhost:11434.\n' +
          'Start it with `ollama serve`, or install it from https://ollama.com if needed.'
      );
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/api/tags`);
    if (!res.ok) throw new Error(`Failed to list Ollama models: ${res.status}`);
    const data = (await res.json()) as TagsResponse;
    return data.models.map((m) => m.name);
  }

  async *chat(model: string, messages: Message[]): AsyncIterable<string> {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat request failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) yield parsed.message.content;
      }
    }
  }

  async logout(): Promise<void> {
    // No-op: Ollama has no auth state to clear.
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- ollama`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/providers/ollama.ts tests/providers/ollama.test.ts
git commit -m "feat: add provider interface and Ollama provider"
```

---

### Task 4: Copilot provider

**Files:**
- Create: `src/providers/copilot.ts`
- Test: `tests/providers/copilot.test.ts`

**Interfaces:**
- Consumes: `Provider`, `Message` from `src/providers/types.ts` (Task 3); `AuthStore` from `src/auth-store.ts` (Task 2) — `new AuthStore()` default, or injected via constructor for tests.
- Produces: `CopilotProvider` class implementing `Provider`, constructor `new CopilotProvider(authStore?: AuthStore)`.

- [ ] **Step 1: Write the failing tests**

`tests/providers/copilot.test.ts`:

```ts
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

    const chunks: string[] = [];
    for await (const chunk of provider.chat('gpt-4o', [{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('Hi there');
  });

  it('logout clears the stored token', async () => {
    await authStore.set('copilot', { githubToken: 'gh-token' });
    await provider.logout();
    expect(await authStore.get('copilot')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- copilot`
Expected: FAIL — `src/providers/copilot.ts` does not exist.

- [ ] **Step 3: Implement `src/providers/copilot.ts`**

```ts
import type { Provider, Message } from './types.js';
import { AuthStore } from '../auth-store.js';

const CLIENT_ID = '01ab8ac9400c4e429b23';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
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

  constructor(private readonly authStore: AuthStore = new AuthStore()) {}

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

    const githubToken = await this.pollForToken(data.device_code, data.interval);
    await this.authStore.set(this.id, { githubToken });
  }

  private async pollForToken(deviceCode: string, intervalSeconds: number): Promise<string> {
    let interval = intervalSeconds;
    while (true) {
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

  async listModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini'];
  }

  async *chat(model: string, messages: Message[]): AsyncIterable<string> {
    const token = await this.getCopilotToken();
    const res = await fetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Copilot chat request failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '[DONE]') return;
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
    }
  }

  async logout(): Promise<void> {
    await this.authStore.delete(this.id);
    this.copilotToken = undefined;
    this.copilotTokenExpiresAt = 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- copilot`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/providers/copilot.ts tests/providers/copilot.test.ts
git commit -m "feat: add Copilot provider with device-code login and streaming chat"
```

---

### Task 5: Provider registry

**Files:**
- Create: `src/providers/index.ts`
- Test: `tests/providers/index.test.ts`

**Interfaces:**
- Consumes: `CopilotProvider` (Task 4), `OllamaProvider` (Task 3).
- Produces: `listProviders(): Provider[]` and `getProvider(id: string): Provider` (throws on unknown id), re-exports `Provider` and `Message` types. Later tasks (CLI, commands) import `getProvider`/`listProviders` from `src/providers/index.js`.

- [ ] **Step 1: Write the failing tests**

`tests/providers/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { listProviders, getProvider } from '../../src/providers/index';

describe('provider registry', () => {
  it('lists copilot and ollama', () => {
    const ids = listProviders().map((p) => p.id);
    expect(ids).toEqual(['copilot', 'ollama']);
  });

  it('getProvider returns the matching provider', () => {
    expect(getProvider('ollama').name).toBe('Ollama (local)');
  });

  it('getProvider throws for unknown id', () => {
    expect(() => getProvider('nope')).toThrow(/Unknown provider/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- providers/index`
Expected: FAIL — `src/providers/index.ts` does not exist.

- [ ] **Step 3: Implement `src/providers/index.ts`**

```ts
import type { Provider } from './types.js';
import { CopilotProvider } from './copilot.js';
import { OllamaProvider } from './ollama.js';

const providers: Provider[] = [new CopilotProvider(), new OllamaProvider()];

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- providers/index`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/providers/index.ts tests/providers/index.test.ts
git commit -m "feat: add provider registry"
```

---

### Task 6: Login/logout commands

**Files:**
- Create: `src/commands/auth-commands.ts`
- Test: `tests/commands/auth-commands.test.ts`

**Interfaces:**
- Consumes: `Provider` type from `src/providers/types.ts` (Task 3).
- Produces: `runLogin(provider: Provider): Promise<void>`, `runLogout(provider: Provider): Promise<void>`. Later CLI task (Task 8) calls these with a `Provider` resolved via `getProvider(id)`.

- [ ] **Step 1: Write the failing tests**

`tests/commands/auth-commands.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Provider } from '../../src/providers/types';
import { runLogin, runLogout } from '../../src/commands/auth-commands';

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    isAuthenticated: vi.fn().mockResolvedValue(false),
    login: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    chat: (async function* () {})(),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Provider;
}

describe('auth commands', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('runLogin calls provider.login when not authenticated', async () => {
    const provider = fakeProvider({ isAuthenticated: vi.fn().mockResolvedValue(false) });
    await runLogin(provider);
    expect(provider.login).toHaveBeenCalledOnce();
  });

  it('runLogin skips login when already authenticated', async () => {
    const provider = fakeProvider({ isAuthenticated: vi.fn().mockResolvedValue(true) });
    await runLogin(provider);
    expect(provider.login).not.toHaveBeenCalled();
  });

  it('runLogout calls provider.logout', async () => {
    const provider = fakeProvider();
    await runLogout(provider);
    expect(provider.logout).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- auth-commands`
Expected: FAIL — `src/commands/auth-commands.ts` does not exist.

- [ ] **Step 3: Implement `src/commands/auth-commands.ts`**

```ts
import chalk from 'chalk';
import type { Provider } from '../providers/types.js';

export async function runLogin(provider: Provider): Promise<void> {
  if (await provider.isAuthenticated()) {
    console.log(chalk.yellow(`Already logged in to ${provider.name}.`));
    return;
  }
  await provider.login();
  console.log(chalk.green(`Logged in to ${provider.name}.`));
}

export async function runLogout(provider: Provider): Promise<void> {
  await provider.logout();
  console.log(chalk.green(`Logged out of ${provider.name}.`));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- auth-commands`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/commands/auth-commands.ts tests/commands/auth-commands.test.ts
git commit -m "feat: add login/logout command handlers"
```

---

### Task 7: REPL command parsing and chat loop

**Files:**
- Create: `src/repl/parse-command.ts`
- Create: `src/repl/run-repl.ts`
- Test: `tests/repl/parse-command.test.ts`

**Interfaces:**
- Consumes: `Provider`, `Message` from `src/providers/types.ts` (Task 3).
- Produces: `parseCommand(input: string): ParsedCommand` where `ParsedCommand = { type: 'help' | 'exit' | 'clear' | 'model' | 'provider' | 'message'; arg?: string }`. `runRepl(deps: ReplDeps): Promise<void>` where `ReplDeps = { provider: Provider; model: string; pickModel: (provider: Provider) => Promise<string>; pickProvider: () => Promise<Provider> }`. Task 8 (CLI) supplies `pickModel`/`pickProvider` implementations backed by `@inquirer/prompts`.

- [ ] **Step 1: Write the failing tests for `parseCommand`**

`tests/repl/parse-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/repl/parse-command';

describe('parseCommand', () => {
  it('parses /help', () => {
    expect(parseCommand('/help')).toEqual({ type: 'help' });
  });

  it('parses /exit', () => {
    expect(parseCommand('/exit')).toEqual({ type: 'exit' });
  });

  it('parses /clear', () => {
    expect(parseCommand('/clear')).toEqual({ type: 'clear' });
  });

  it('parses /model', () => {
    expect(parseCommand('/model')).toEqual({ type: 'model' });
  });

  it('parses /provider', () => {
    expect(parseCommand('/provider')).toEqual({ type: 'provider' });
  });

  it('treats anything else as a message, trimmed', () => {
    expect(parseCommand('  hello there  ')).toEqual({ type: 'message', arg: 'hello there' });
  });

  it('treats an unknown slash command as a literal message', () => {
    expect(parseCommand('/bogus')).toEqual({ type: 'message', arg: '/bogus' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- parse-command`
Expected: FAIL — `src/repl/parse-command.ts` does not exist.

- [ ] **Step 3: Implement `src/repl/parse-command.ts`**

```ts
export interface ParsedCommand {
  type: 'help' | 'exit' | 'clear' | 'model' | 'provider' | 'message';
  arg?: string;
}

const KNOWN_COMMANDS: Record<string, ParsedCommand['type']> = {
  '/help': 'help',
  '/exit': 'exit',
  '/clear': 'clear',
  '/model': 'model',
  '/provider': 'provider',
};

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  const known = KNOWN_COMMANDS[trimmed];
  if (known) return { type: known };
  return { type: 'message', arg: trimmed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- parse-command`
Expected: 7 passed.

- [ ] **Step 5: Implement `src/repl/run-repl.ts`** (thin I/O layer, verified manually in Task 9 rather than unit tested)

```ts
import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Provider, Message } from '../providers/types.js';
import { parseCommand } from './parse-command.js';

export interface ReplDeps {
  provider: Provider;
  model: string;
  pickModel: (provider: Provider) => Promise<string>;
  pickProvider: () => Promise<Provider>;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  let provider = deps.provider;
  let model = deps.model;
  let history: Message[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(chalk.cyan(`Connected to ${provider.name} (${model}). Type your message, /help for commands.`));

  while (true) {
    const line = await rl.question('> ');
    const cmd = parseCommand(line);

    if (cmd.type === 'exit') break;

    if (cmd.type === 'help') {
      console.log('/help, /exit, /clear, /model, /provider');
      continue;
    }

    if (cmd.type === 'clear') {
      history = [];
      console.log(chalk.gray('Conversation cleared.'));
      continue;
    }

    if (cmd.type === 'model') {
      model = await deps.pickModel(provider);
      history = [];
      continue;
    }

    if (cmd.type === 'provider') {
      provider = await deps.pickProvider();
      model = await deps.pickModel(provider);
      history = [];
      continue;
    }

    if (!cmd.arg) continue;

    history.push({ role: 'user', content: cmd.arg });
    process.stdout.write(chalk.magenta('assistant> '));
    let reply = '';
    try {
      for await (const chunk of provider.chat(model, history)) {
        process.stdout.write(chunk);
        reply += chunk;
      }
      process.stdout.write('\n');
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      console.log(chalk.red(`\nError: ${(err as Error).message}`));
    }
  }

  rl.close();
}
```

- [ ] **Step 6: Build to confirm it type-checks**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/repl/parse-command.ts src/repl/run-repl.ts tests/repl/parse-command.test.ts
git commit -m "feat: add REPL command parsing and chat loop"
```

---

### Task 8: CLI entry point

**Files:**
- Create: `src/cli.ts`
- Modify: `package.json` (already has `bin` field from Task 1 — verify it points at `dist/cli.js`)

**Interfaces:**
- Consumes: `listProviders`, `getProvider` from `src/providers/index.ts` (Task 5); `runLogin`, `runLogout` from `src/commands/auth-commands.ts` (Task 6); `runRepl` from `src/repl/run-repl.ts` (Task 7).
- Produces: the `ai-term-chat` executable (compiled to `dist/cli.js`) with `login <provider>`, `logout <provider>`, `chat [provider]`, and default (no-args) commands.

- [ ] **Step 1: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import type { Provider } from './providers/types.js';
import { listProviders, getProvider } from './providers/index.js';
import { runLogin, runLogout } from './commands/auth-commands.js';
import { runRepl } from './repl/run-repl.js';

async function pickProvider(): Promise<Provider> {
  const id = await select({
    message: 'Select a provider:',
    choices: listProviders().map((p) => ({ name: p.name, value: p.id })),
  });
  return getProvider(id);
}

async function pickModel(provider: Provider): Promise<string> {
  const models = await provider.listModels();
  return select({
    message: 'Select a model:',
    choices: models.map((m) => ({ name: m, value: m })),
  });
}

async function ensureAuthenticated(provider: Provider): Promise<void> {
  if (!(await provider.isAuthenticated())) {
    console.log(`Not logged in to ${provider.name} yet.`);
    await provider.login();
  }
}

async function startChat(providerId?: string): Promise<void> {
  const provider = providerId ? getProvider(providerId) : await pickProvider();
  await ensureAuthenticated(provider);
  const model = await pickModel(provider);
  await runRepl({ provider, model, pickModel, pickProvider });
}

const program = new Command();
program.name('ai-term-chat').description('Chat with AI models from your terminal');

program
  .command('login <provider>')
  .description('Log in to a provider')
  .action(async (providerId: string) => {
    await runLogin(getProvider(providerId));
  });

program
  .command('logout <provider>')
  .description('Log out of a provider')
  .action(async (providerId: string) => {
    await runLogout(getProvider(providerId));
  });

program
  .command('chat [provider]')
  .description('Start a chat session')
  .action(async (providerId?: string) => {
    await startChat(providerId);
  });

program.action(async () => {
  await startChat();
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Build the project**

Run: `npm run build`
Expected: no TypeScript errors; `dist/cli.js` created.

- [ ] **Step 3: Verify the CLI runs and shows help**

Run: `node dist/cli.js --help`
Expected: usage output listing `login`, `logout`, `chat` commands.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests from Tasks 1–7 still pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: wire up CLI entry point"
```

---

### Task 9: README and manual smoke test

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: user-facing setup/usage instructions.

- [ ] **Step 1: Write `README.md`**

```markdown
# ai-term-chat

Chat with AI models from your terminal. Supports GitHub Copilot (via device-code login) and local Ollama models.

## Setup

\`\`\`bash
npm install
npm run build
npm link   # makes the `ai-term-chat` command available globally
\`\`\`

## Usage

\`\`\`bash
ai-term-chat                  # interactive provider + model picker
ai-term-chat chat copilot     # jump straight into Copilot
ai-term-chat chat ollama      # jump straight into Ollama
ai-term-chat login copilot    # log in to Copilot ahead of time
ai-term-chat logout copilot   # clear stored Copilot credentials
\`\`\`

In a chat session:

- `/help` — list commands
- `/model` — switch model within the current provider
- `/provider` — switch provider
- `/clear` — reset the conversation
- `/exit` — quit

## Requirements

- Node.js >= 18
- For Copilot: a GitHub account with Copilot access
- For Ollama: [Ollama](https://ollama.com) installed and running locally (`ollama serve`), with at least one model pulled (e.g. `ollama pull llama3`)
```

- [ ] **Step 2: Manual smoke test — Ollama**

If Ollama is installed locally: run `ollama serve` in one terminal, `ollama pull llama3` if not already pulled, then run `node dist/cli.js chat ollama`, pick a model, send a message, confirm streamed output appears, then `/exit`.

If Ollama is not installed, skip this step and note it in the PR/commit description as "Ollama smoke test skipped — not installed locally."

- [ ] **Step 3: Manual smoke test — Copilot**

Run `node dist/cli.js login copilot`, follow the printed link and code, confirm login completes and `~/.ai-term-chat/auth.json` is created with `githubToken` set. Then run `node dist/cli.js chat copilot`, pick a model, send a message, confirm streamed output appears, then `/exit`. Finally run `node dist/cli.js logout copilot` and confirm the token is removed from `auth.json`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and usage instructions"
```

---
