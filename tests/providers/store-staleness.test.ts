import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';

function throwawayPath(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

/**
 * The gateway holds these for its whole life, and `robin models forget` runs in
 * a different process. A cache that never revalidates means the daemon keeps
 * filtering out a model the user has just asked it to retry, until the gateway
 * is restarted — and nothing tells them that is what happened.
 */
describe('stores held by a long-lived process', () => {
  it('UnsupportedModelStore notices another process clearing the file', async () => {
    const file = throwawayPath('unsupported');
    const daemonSide = new UnsupportedModelStore(file);
    const cliSide = new UnsupportedModelStore(file);

    await cliSide.record('copilot', 'claude-sonnet-5');
    expect(await daemonSide.listFor('copilot')).toEqual(['claude-sonnet-5']);

    await cliSide.clear('copilot');

    expect(await daemonSide.listFor('copilot')).toEqual([]);
  });

  it('UnsupportedModelStore notices another process adding to the file', async () => {
    const file = throwawayPath('unsupported');
    const first = new UnsupportedModelStore(file);
    const second = new UnsupportedModelStore(file);

    await first.listFor('copilot'); // warms the cache with an empty file
    await second.record('copilot', 'gpt-9');

    expect(await first.listFor('copilot')).toEqual(['gpt-9']);
  });

  it('ContextLimitStore notices a limit another process recorded', async () => {
    const file = throwawayPath('limits');
    const daemonSide = new ContextLimitStore(file);
    const cliSide = new ContextLimitStore(file);

    await daemonSide.get('copilot', 'gpt-4o'); // warms the cache
    await cliSide.record('copilot', 'gpt-4o', 8192);

    expect(await daemonSide.get('copilot', 'gpt-4o')).toBe(8192);
  });

  it('still serves from cache when the file has not moved', async () => {
    const file = throwawayPath('unsupported');
    const store = new UnsupportedModelStore(file);
    await store.record('copilot', 'a');

    // Deleting the file behind its back without changing anything it can see
    // would be indistinguishable from a corrupt read; what matters is that the
    // common path does not re-parse on every call.
    expect(await store.listFor('copilot')).toEqual(['a']);
    expect(await store.listFor('copilot')).toEqual(['a']);
  });

  it('treats a file that appears after an empty read as new state', async () => {
    const file = throwawayPath('limits');
    const store = new ContextLimitStore(file);
    expect(await store.get('copilot', 'gpt-4o')).toBeUndefined();

    await fs.writeFile(file, JSON.stringify({ copilot: { 'gpt-4o': 4096 } }), 'utf-8');

    expect(await store.get('copilot', 'gpt-4o')).toBe(4096);
  });
});
