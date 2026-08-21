import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTurn } from '../../src/repl/run-turn';
import { createSession } from '../../src/repl/session';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import type { ChatEvent, Provider } from '../../src/providers/types';

function throwawayStore(): UnsupportedModelStore {
  return new UnsupportedModelStore(
    path.join(os.tmpdir(), `robin-unsupported-${Date.now()}-${Math.random()}.json`)
  );
}

/** A provider that replays a scripted set of events per round. */
function provider(rounds: ChatEvent[][], id = 'copilot', name = 'GitHub Copilot'): Provider {
  let round = 0;
  return {
    id,
    name,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['m1', 'm2']),
    chat: vi.fn().mockImplementation(async function* () {
      const events = rounds[round] ?? [];
      round += 1;
      for (const event of events) yield event;
    }),
  } as unknown as Provider;
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    onText: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    unsupportedStore: throwawayStore(),
    providers: [],
    ...overrides,
  } as never;
}

const usage = (input: number, output: number): ChatEvent => ({
  type: 'usage',
  usage: { inputTokens: input, outputTokens: output },
});

import { UsageLog } from '../../src/usage/usage-log';

describe('runTurn and the usage log', () => {
  it('appends one entry per successful turn, with an estimated cost', async () => {
    const p = provider(
      [[{ type: 'text', text: 'hi' }, usage(1_000_000, 1_000_000)]],
      'anthropic',
      'Claude'
    );
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(createSession(p, 'claude-sonnet-5'), 'hello', options({ usageLog: log }));
    await log.flush();

    const entries = await log.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(entries[0].estimatedCostUsd).toBeCloseTo(18, 5); // $3 + $15 per million
  });

  it('records a null estimated cost for a provider with no pricing entry', async () => {
    const p = provider([[{ type: 'text', text: 'hi' }, usage(100, 10)]], 'ollama', 'Ollama (local)');
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(createSession(p, 'llama3'), 'hello', options({ usageLog: log }));
    await log.flush();

    expect((await log.readAll())[0].estimatedCostUsd).toBeNull();
  });

  it('records nothing when the provider reported no usage', async () => {
    const p = provider([[{ type: 'text', text: 'hi' }]]);
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(createSession(p, 'm1'), 'hello', options({ usageLog: log }));
    await log.flush();

    expect(await log.readAll()).toEqual([]);
  });

  it('records nothing for a turn that ultimately fails', async () => {
    const failing = provider([[]], 'copilot', 'GitHub Copilot');
    failing.chat = vi.fn().mockImplementation(async function* () {
      throw new Error('boom');
    }) as never;
    const log = new UsageLog(path.join(os.tmpdir(), `robin-usage-test-${Date.now()}-${Math.random()}.jsonl`));

    await runTurn(
      createSession(failing, 'm1'),
      'hello',
      options({ usageLog: log, fallback: false })
    );
    await log.flush();

    expect(await log.readAll()).toEqual([]);
  });
});

describe('runTurn and token usage', () => {
  it('reports what the provider said the turn cost', async () => {
    const p = provider([[{ type: 'text', text: 'hi' }, usage(120, 8)]]);

    const result = await runTurn(createSession(p, 'm1'), 'hello', options());

    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
  });

  it('says nothing when the provider reported nothing', async () => {
    const p = provider([[{ type: 'text', text: 'hi' }]]);

    const result = await runTurn(createSession(p, 'm1'), 'hello', options());

    // Undefined, not zero: "not told" and "cost nothing" are different, and
    // only one of them is ever true.
    expect(result.usage).toBeUndefined();
  });

  // A turn with a tool call makes two requests, and both are billed.
  it('sums the rounds of a multi-request turn', async () => {
    const p = provider([
      [
        { type: 'tool_call', toolCall: { id: 't1', name: 'run_command', arguments: '{"command":"x"}' } },
        usage(100, 10),
      ],
      [{ type: 'text', text: 'done' }, usage(150, 20)],
    ]);

    const result = await runTurn(
      createSession(p, 'm1'),
      'hello',
      options({ tools: true, confirm: vi.fn().mockResolvedValue(false) })
    );

    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 30 });
  });

  it('keeps the last word when a provider reports a running total', async () => {
    // Gemini repeats usageMetadata on every frame with a total so far.
    const p = provider([[usage(10, 1), usage(10, 5), { type: 'text', text: 'hi' }, usage(10, 9)]]);

    const result = await runTurn(createSession(p, 'm1'), 'hello', options());

    // Three reports within one request would triple the count if summed.
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 9 });
  });

  it('does not bill a failed attempt to the model that rescued it', async () => {
    const failing = provider([[usage(999, 999)]], 'copilot', 'GitHub Copilot');
    failing.chat = vi.fn().mockImplementation(async function* () {
      yield usage(999, 999);
      throw new Error('boom');
    }) as never;
    const rescue = provider([[{ type: 'text', text: 'rescued' }, usage(30, 4)]], 'ollama', 'Ollama (local)');

    const result = await runTurn(
      createSession(failing, 'm1'),
      'hello',
      options({ providers: [failing, rescue] })
    );

    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 4 });
  });
});
