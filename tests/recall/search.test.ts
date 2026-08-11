import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { RecallSearch } from '../../src/recall/search';

async function chatsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-search-'));
  await fs.writeFile(path.join(dir, 'one.md'), '# Robin conversation\n\nthe capital of France is Paris\n');
  await fs.writeFile(path.join(dir, 'two.md'), '# Robin conversation\n\nkubernetes ingress notes\n');
  return dir;
}

describe('RecallSearch', () => {
  it('finds a match and reports which path answered', async () => {
    const search = new RecallSearch(await chatsDir());

    const { matches, source } = await search.search('capital');

    expect(matches).toHaveLength(1);
    expect(matches[0].context.join(' ')).toContain('Paris');
    // On this machine SQLite is available, so the index should answer.
    expect(source).toBe('index');
    await search.close();
  });

  it('reports the backfill on first use and not on the second', async () => {
    const counts: number[] = [];
    const search = new RecallSearch(await chatsDir(), (n) => counts.push(n));

    await search.search('capital');
    await search.search('kubernetes');

    expect(counts).toEqual([2]);
    await search.close();
  });

  it('returns nothing for a term that is absent', async () => {
    const search = new RecallSearch(await chatsDir());
    expect((await search.search('absent-term')).matches).toEqual([]);
    await search.close();
  });

  it('finds nothing, without failing, when there are no transcripts', async () => {
    const search = new RecallSearch(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-empty-')));
    expect((await search.search('anything')).matches).toEqual([]);
    await search.close();
  });
});
