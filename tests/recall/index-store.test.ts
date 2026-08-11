import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { RecallIndex, toMatchExpression } from '../../src/recall/index-store';

const open: RecallIndex[] = [];

afterEach(() => {
  for (const index of open.splice(0)) index.close();
});

async function freshIndex(): Promise<{ dir: string; index: RecallIndex }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-recall-'));
  const dir = path.join(root, 'chats');
  await fs.mkdir(dir);
  const index = await RecallIndex.open(path.join(root, 'index.db'));
  if (!index) throw new Error('SQLite unavailable in this environment');
  open.push(index);
  return { dir, index };
}

async function writeTranscript(dir: string, name: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), body);
}

describe('toMatchExpression', () => {
  it('quotes each term so punctuation is not read as FTS5 syntax', () => {
    expect(toMatchExpression('foo-bar baz')).toBe('"foo-bar" "baz"');
  });

  it('survives an all-punctuation query', () => {
    expect(toMatchExpression('   ')).toBe('""');
  });
});

describe('RecallIndex', () => {
  it('finds a line it has indexed', async () => {
    const { dir, index } = await freshIndex();
    await writeTranscript(dir, 'a.md', 'nothing here\nthe capital of France is Paris\n');

    await index.sync(dir);
    const hits = index.search('capital');

    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe('a.md');
    expect(hits[0].lineNumber).toBe(2);
    expect(hits[0].context[0]).toContain('Paris');
  });

  it('returns nothing for a term that is absent', async () => {
    const { dir, index } = await freshIndex();
    await writeTranscript(dir, 'a.md', 'hello world');
    await index.sync(dir);

    expect(index.search('absent')).toEqual([]);
  });

  it('only re-reads files whose mtime changed', async () => {
    const { dir, index } = await freshIndex();
    await writeTranscript(dir, 'a.md', 'first');
    await writeTranscript(dir, 'b.md', 'second');

    expect(await index.sync(dir)).toBe(2);
    expect(await index.sync(dir)).toBe(0);
  });

  it('picks up an appended transcript without duplicating its old lines', async () => {
    const { dir, index } = await freshIndex();
    await writeTranscript(dir, 'a.md', 'original line\n');
    await index.sync(dir);

    await new Promise((r) => setTimeout(r, 10));
    await writeTranscript(dir, 'a.md', 'original line\nappended line\n');
    await index.sync(dir);

    expect(index.search('original')).toHaveLength(1);
    expect(index.search('appended')).toHaveLength(1);
  });

  it('stops returning a transcript that was deleted from disk', async () => {
    const { dir, index } = await freshIndex();
    await writeTranscript(dir, 'a.md', 'ephemeral content');
    await index.sync(dir);

    await fs.unlink(path.join(dir, 'a.md'));
    await index.sync(dir);

    expect(index.search('ephemeral')).toEqual([]);
  });

  it('ranks the better match first', async () => {
    const { dir, index } = await freshIndex();
    await writeTranscript(dir, 'weak.md', 'kubernetes mentioned once here\n');
    await writeTranscript(dir, 'strong.md', 'kubernetes kubernetes kubernetes\n');
    await index.sync(dir);

    expect(index.search('kubernetes')[0].file).toBe('strong.md');
  });

  it('treats a query FTS5 would reject as a miss, not a crash', async () => {
    const { dir, index } = await freshIndex();
    await writeTranscript(dir, 'a.md', 'some content');
    await index.sync(dir);

    expect(() => index.search('"unbalanced AND (')).not.toThrow();
  });

  it('tolerates a missing transcript directory', async () => {
    const { index } = await freshIndex();
    expect(await index.sync(path.join(os.tmpdir(), 'robin-no-such-dir'))).toBe(0);
  });

  it('open() returns undefined rather than throwing when the index cannot be created', async () => {
    // Parent is a regular file, so the directory can never be made. This is
    // the fallback contract: an unusable index must degrade /recall to grep,
    // not take the session down.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-recall-bad-'));
    const blocker = path.join(root, 'not-a-dir');
    await fs.writeFile(blocker, 'x');

    expect(await RecallIndex.open(path.join(blocker, 'index.db'))).toBeUndefined();
  });
});
