import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { runTurn } from '../../src/repl/run-turn';
import { createSession, buildSystemPrompt } from '../../src/repl/session';
import { handleClear } from '../../src/repl/commands/conversation';
import { MemoryStore } from '../../src/memory/store';
import { composeMemoryContext, MEMORY_NUDGE, NUDGE_EVERY } from '../../src/memory/tools';
import { executeTool } from '../../src/tools/execute';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import type { Provider } from '../../src/providers/types';
import type { ReplContext } from '../../src/repl/repl-context';

async function memoryStore(): Promise<MemoryStore> {
  return new MemoryStore(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-memint-')));
}

function fakeProvider(): Provider {
  return {
    id: 'p',
    name: 'P',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'ok' };
    }),
  } as unknown as Provider;
}

function turnOptions(memory: MemoryStore) {
  return {
    onText: () => {},
    confirm: async () => false,
    unsupportedStore: new UnsupportedModelStore(
      path.join(os.tmpdir(), `robin-unsup-${Math.random()}.json`)
    ),
    providers: [],
    memory,
  } as never;
}

/** The system prompt actually sent on the Nth turn. */
function systemSent(provider: Provider, call: number): string {
  const messages = (provider.chat as unknown as { mock: { calls: unknown[][] } }).mock.calls[call][1];
  return (messages as { role: string; content: string }[])[0].content;
}

describe('composeMemoryContext', () => {
  it('returns nothing when there is neither profile nor index', () => {
    expect(composeMemoryContext(undefined, '')).toBeUndefined();
  });

  it('includes the profile and the index', () => {
    const block = composeMemoryContext('Likes brevity.', '- a (user) — thing');
    expect(block).toContain('Likes brevity.');
    expect(block).toContain('- a (user) — thing');
  });
});

describe('buildSystemPrompt with memory', () => {
  it('places memory after personality and before the user system prompt', () => {
    const s = createSession(fakeProvider(), 'm');
    s.personality = 'PERSONA';
    s.memory = 'MEMORY';
    s.systemPrompt = 'SYSTEM';

    const prompt = buildSystemPrompt(s);

    expect(prompt.indexOf('PERSONA')).toBeLessThan(prompt.indexOf('MEMORY'));
    expect(prompt.indexOf('MEMORY')).toBeLessThan(prompt.indexOf('SYSTEM'));
  });

  it('appends the nudge only when asked', () => {
    const s = createSession(fakeProvider(), 'm');
    expect(buildSystemPrompt(s)).not.toContain(MEMORY_NUDGE);
    expect(buildSystemPrompt(s, { nudge: true })).toContain(MEMORY_NUDGE);
  });
});

describe('memory during a turn', () => {
  it('offers the memory tools to the model', async () => {
    const provider = fakeProvider();
    const session = createSession(provider, 'm');

    await runTurn(session, 'hi', turnOptions(await memoryStore()));

    const tools = (provider.chat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2];
    const names = (tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('remember');
    expect(names).toContain('recall_memory');
  });

  it('sends the index but never the bodies', async () => {
    const store = await memoryStore();
    await store.write({
      name: 'tabs',
      description: 'Indents with tabs',
      type: 'user',
      body: 'BODY-MUST-NOT-BE-SENT',
    });
    const provider = fakeProvider();

    await runTurn(createSession(provider, 'm'), 'hi', turnOptions(store));

    const system = systemSent(provider, 0);
    expect(system).toContain('Indents with tabs');
    expect(system).not.toContain('BODY-MUST-NOT-BE-SENT');
  });

  it('picks up a memory written earlier in the same session', async () => {
    const store = await memoryStore();
    const provider = fakeProvider();
    const session = createSession(provider, 'm');

    await runTurn(session, 'first', turnOptions(store));
    await store.write({ name: 'later', description: 'written mid-session', type: 'user', body: 'x' });
    await runTurn(session, 'second', turnOptions(store));

    expect(systemSent(provider, 0)).not.toContain('written mid-session');
    expect(systemSent(provider, 1)).toContain('written mid-session');
  });

  it('nudges on the Nth turn and not before', async () => {
    const store = await memoryStore();
    const provider = fakeProvider();
    const session = createSession(provider, 'm');

    for (let i = 0; i < NUDGE_EVERY; i++) {
      await runTurn(session, `turn ${i}`, turnOptions(store));
    }

    expect(systemSent(provider, NUDGE_EVERY - 2)).not.toContain(MEMORY_NUDGE);
    expect(systemSent(provider, NUDGE_EVERY - 1)).toContain(MEMORY_NUDGE);
  });

  it('/clear resets the nudge counter with the conversation', async () => {
    const session = createSession(fakeProvider(), 'm');
    session.turnCount = 7;

    await handleClear({ session } as unknown as ReplContext);

    expect(session.turnCount).toBe(0);
  });
});

describe('the memory tools', () => {
  const call = (name: string, args: unknown) => ({
    id: '1',
    name,
    arguments: JSON.stringify(args),
  });

  it('remember writes, and says so', async () => {
    const store = await memoryStore();

    const result = await executeTool(
      call('remember', { name: 'tabs', description: 'd', type: 'user', body: 'b' }),
      async () => true,
      { memory: store }
    );

    expect(result).toMatch(/Saved memory/);
    expect((await store.read('tabs'))?.body).toBe('b');
  });

  it('remember updates an existing memory rather than duplicating it', async () => {
    const store = await memoryStore();
    await store.write({ name: 'tabs', description: 'old', type: 'user', body: 'old' });

    const result = await executeTool(
      call('remember', { name: 'tabs', description: 'new', type: 'user', body: 'new' }),
      async () => true,
      { memory: store }
    );

    expect(result).toMatch(/Updated memory/);
    expect(await store.list()).toHaveLength(1);
  });

  it('recall_memory returns the body', async () => {
    const store = await memoryStore();
    await store.write({ name: 'tabs', description: 'd', type: 'user', body: 'the full body' });

    const result = await executeTool(call('recall_memory', { name: 'tabs' }), async () => true, {
      memory: store,
    });

    expect(result).toContain('the full body');
  });

  it('recall_memory reports a missing memory rather than failing the turn', async () => {
    const result = await executeTool(call('recall_memory', { name: 'nope' }), async () => true, {
      memory: await memoryStore(),
    });

    expect(result).toMatch(/No memory named/);
  });

  it('the memory tools are unavailable when no store is configured', async () => {
    const result = await executeTool(
      call('remember', { name: 'x', description: 'd', type: 'user', body: 'b' }),
      async () => true,
      {}
    );

    expect(result).toMatch(/not available/);
  });
});
