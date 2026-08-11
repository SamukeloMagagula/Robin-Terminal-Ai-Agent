import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  addToInputHistory,
  MAX_INPUT_HISTORY,
  encodeHistoryLine,
  decodeHistoryLine,
  InputHistoryStore,
} from '../../src/repl/input-history';

describe('addToInputHistory', () => {
  it('appends a line', () => {
    expect(addToInputHistory([], 'hello')).toEqual(['hello']);
    expect(addToInputHistory(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('ignores empty and whitespace-only lines', () => {
    expect(addToInputHistory(['a'], '')).toEqual(['a']);
    expect(addToInputHistory(['a'], '   ')).toEqual(['a']);
    expect(addToInputHistory(['a'], '\t\n')).toEqual(['a']);
  });

  it('collapses a consecutive duplicate', () => {
    expect(addToInputHistory(['/random'], '/random')).toEqual(['/random']);
  });

  it('keeps a repeat that is not consecutive', () => {
    expect(addToInputHistory(['/random', 'hello'], '/random')).toEqual([
      '/random',
      'hello',
      '/random',
    ]);
  });

  it('does not mutate the array it is given', () => {
    const original = ['a'];
    const result = addToInputHistory(original, 'b');
    expect(original).toEqual(['a']);
    expect(result).not.toBe(original);
  });

  it('caps at MAX_INPUT_HISTORY, dropping the oldest first', () => {
    let history: string[] = [];
    for (let i = 0; i < MAX_INPUT_HISTORY + 10; i++) {
      history = addToInputHistory(history, `line-${i}`);
    }
    expect(history).toHaveLength(MAX_INPUT_HISTORY);
    expect(history[0]).toBe('line-10');
    expect(history[history.length - 1]).toBe(`line-${MAX_INPUT_HISTORY + 9}`);
  });
});

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'robin-hist-'));
}

describe('encodeHistoryLine / decodeHistoryLine', () => {
  it('round-trips a plain line unchanged', () => {
    expect(decodeHistoryLine(encodeHistoryLine('hello world'))).toBe('hello world');
  });

  it('round-trips a multi-line prompt', () => {
    const line = 'first\nsecond\nthird';
    expect(encodeHistoryLine(line)).not.toContain('\n');
    expect(decodeHistoryLine(encodeHistoryLine(line))).toBe(line);
  });

  it('round-trips a literal backslash followed by n', () => {
    const line = 'path C:\\new\\folder';
    expect(decodeHistoryLine(encodeHistoryLine(line))).toBe(line);
  });
});

describe('InputHistoryStore', () => {
  it('returns an empty history when the file does not exist', async () => {
    const store = new InputHistoryStore(await tempDir());
    expect(await store.load()).toEqual([]);
  });

  it('round-trips appended lines, oldest first', async () => {
    const store = new InputHistoryStore(await tempDir());

    await store.append('one');
    await store.append('two');

    expect(await store.load()).toEqual(['one', 'two']);
  });

  it('round-trips a multi-line prompt through the file', async () => {
    const store = new InputHistoryStore(await tempDir());

    await store.append('line one\nline two');

    expect(await store.load()).toEqual(['line one\nline two']);
  });

  it('caps at MAX_INPUT_HISTORY on load, keeping the newest', async () => {
    const store = new InputHistoryStore(await tempDir());

    for (let i = 0; i < MAX_INPUT_HISTORY + 10; i++) {
      await store.append(`line ${i}`);
    }
    const loaded = await store.load();

    expect(loaded).toHaveLength(MAX_INPUT_HISTORY);
    expect(loaded[loaded.length - 1]).toBe(`line ${MAX_INPUT_HISTORY + 9}`);
    expect(loaded[0]).toBe('line 10');
  });

  it('persists nothing when ROBIN_NO_HISTORY_FILE is set', async () => {
    const dir = await tempDir();
    process.env.ROBIN_NO_HISTORY_FILE = '1';
    try {
      const store = new InputHistoryStore(dir);
      await store.append('secret');
      expect(await store.load()).toEqual([]);
    } finally {
      delete process.env.ROBIN_NO_HISTORY_FILE;
    }
  });

  it('swallows write failures rather than throwing at the prompt', async () => {
    const store = new InputHistoryStore('\0invalid');
    await expect(store.append('anything')).resolves.toBeUndefined();
  });

  it('clear() removes the file and tolerates it being absent', async () => {
    const store = new InputHistoryStore(await tempDir());

    await store.append('one');
    await store.clear();

    expect(await store.load()).toEqual([]);
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
