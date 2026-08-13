import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextLimitStore } from '../../src/providers/context-limits';

function throwawayPath(): string {
  return path.join(os.tmpdir(), `robin-context-limits-${Date.now()}-${Math.random()}.json`);
}

describe('ContextLimitStore', () => {
  it('returns undefined for a model it has never seen', async () => {
    const store = new ContextLimitStore(throwawayPath());
    expect(await store.get('copilot', 'gpt-4o')).toBeUndefined();
  });

  it('remembers a recorded limit across instances', async () => {
    const file = throwawayPath();
    await new ContextLimitStore(file).record('copilot', 'gpt-4o', 12288);
    expect(await new ContextLimitStore(file).get('copilot', 'gpt-4o')).toBe(12288);
  });

  it('keeps the smaller limit when a second one arrives', async () => {
    const store = new ContextLimitStore(throwawayPath());
    await store.record('copilot', 'gpt-4o', 12288);
    await store.record('copilot', 'gpt-4o', 8192);
    await store.record('copilot', 'gpt-4o', 100000);
    expect(await store.get('copilot', 'gpt-4o')).toBe(8192);
  });

  it('keeps models and providers apart', async () => {
    const store = new ContextLimitStore(throwawayPath());
    await store.record('copilot', 'gpt-4o', 8192);
    expect(await store.get('copilot', 'gpt-5')).toBeUndefined();
    expect(await store.get('gemini', 'gpt-4o')).toBeUndefined();
  });

  it('ignores a limit too small to be real', async () => {
    const store = new ContextLimitStore(throwawayPath());
    await store.record('copilot', 'gpt-4o', 8);
    expect(await store.get('copilot', 'gpt-4o')).toBeUndefined();
  });

  it('treats a corrupt file as empty rather than failing', async () => {
    const file = throwawayPath();
    await fs.writeFile(file, 'not json at all', 'utf-8');
    expect(await new ContextLimitStore(file).get('copilot', 'gpt-4o')).toBeUndefined();
  });
});
