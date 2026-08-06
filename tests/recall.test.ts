import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { searchChatLogs } from '../src/recall';

describe('searchChatLogs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-test-'));
  });

  it('returns an empty list when the directory does not exist', async () => {
    expect(await searchChatLogs('anything', path.join(dir, 'missing'))).toEqual([]);
  });

  it('returns an empty list for a blank query', async () => {
    await fs.writeFile(path.join(dir, 'robin-chat-1.md'), 'hello world');
    expect(await searchChatLogs('   ', dir)).toEqual([]);
  });

  it('finds a matching line, case-insensitively', async () => {
    await fs.writeFile(path.join(dir, 'robin-chat-1.md'), '## You\n\nWhat is the capital of France?\n');
    const matches = await searchChatLogs('capital of france', dir);
    expect(matches).toHaveLength(1);
    expect(matches[0].file).toBe('robin-chat-1.md');
    expect(matches[0].context.join(' ')).toContain('What is the capital of France?');
  });

  it('ignores non-markdown files', async () => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'capital of France is Paris');
    expect(await searchChatLogs('capital', dir)).toEqual([]);
  });

  it('searches across multiple files, newest first', async () => {
    await fs.writeFile(path.join(dir, 'robin-chat-2026-01-01_00-00-00.md'), 'talked about Paris trip');
    await fs.writeFile(path.join(dir, 'robin-chat-2026-06-01_00-00-00.md'), 'talked about Paris again');
    const matches = await searchChatLogs('Paris', dir);
    expect(matches).toHaveLength(2);
    expect(matches[0].file).toBe('robin-chat-2026-06-01_00-00-00.md');
    expect(matches[1].file).toBe('robin-chat-2026-01-01_00-00-00.md');
  });

  it('caps results at 10 matches', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} mentions widgets`).join('\n');
    await fs.writeFile(path.join(dir, 'robin-chat-1.md'), lines);
    const matches = await searchChatLogs('widgets', dir);
    expect(matches).toHaveLength(10);
  });

  it('returns no matches when the query is not found', async () => {
    await fs.writeFile(path.join(dir, 'robin-chat-1.md'), 'talked about the weather');
    expect(await searchChatLogs('quantum physics', dir)).toEqual([]);
  });
});
