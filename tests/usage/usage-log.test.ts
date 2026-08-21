import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { UsageLog, type UsageEntry } from '../../src/usage/usage-log';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-usage-'));
  return path.join(dir, 'usage.jsonl');
}

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  ts: '2026-08-21T09:00:00.000Z',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 100,
  outputTokens: 20,
  estimatedCostUsd: 0.0006,
  ...overrides,
});

describe('UsageLog', () => {
  it('appends and reads back entries in order', async () => {
    const log = new UsageLog(await tempFile());
    await log.append(entry({ model: 'a' }));
    await log.append(entry({ model: 'b' }));

    const read = await log.readAll();
    expect(read.map((e) => e.model)).toEqual(['a', 'b']);
  });

  it('creates the parent directory on first append', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-usage-'));
    const file = path.join(dir, 'nested', 'usage.jsonl');
    const log = new UsageLog(file);

    await log.append(entry());

    expect(await fs.readFile(file, 'utf-8')).toContain('claude-sonnet-5');
  });

  it('returns an empty array when nothing has been recorded yet', async () => {
    expect(await new UsageLog(await tempFile()).readAll()).toEqual([]);
  });

  it('skips an unparseable trailing line rather than losing prior entries', async () => {
    const file = await tempFile();
    const log = new UsageLog(file);
    await log.append(entry({ model: 'a' }));
    await fs.appendFile(file, 'not json\n');

    expect(await log.readAll()).toHaveLength(1);
  });

  it('returns the error rather than throwing when the directory is a file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-usage-'));
    const blocked = path.join(dir, 'blocked');
    await fs.writeFile(blocked, '');

    const result = await new UsageLog(path.join(blocked, 'usage.jsonl')).append(entry());

    expect(result).toBeInstanceOf(Error);
  });

  it('keeps concurrent appends in the order they were issued, without awaiting each', async () => {
    const log = new UsageLog(await tempFile());

    void log.append(entry({ model: 'first' }));
    void log.append(entry({ model: 'second' }));
    void log.append(entry({ model: 'third' }));
    await log.flush();

    expect((await log.readAll()).map((e) => e.model)).toEqual(['first', 'second', 'third']);
  });

  it('preserves a null estimatedCostUsd through a round trip', async () => {
    const log = new UsageLog(await tempFile());
    await log.append(entry({ provider: 'ollama', estimatedCostUsd: null }));

    expect((await log.readAll())[0].estimatedCostUsd).toBeNull();
  });
});
