import { defaultChatLogDir } from '../chat-log.js';
import { searchChatLogs, type RecallMatch } from '../recall.js';
import { RecallIndex } from './index-store.js';

export interface RecallResult {
  matches: RecallMatch[];
  /** Which path answered — surfaced so a silent downgrade is visible. */
  source: 'index' | 'grep';
}

/**
 * Searches past conversations, preferring the full-text index.
 *
 * The index is an optimisation over the original linear grep, not a
 * replacement: better-sqlite3 is a native module whose install can legitimately
 * fail, and `/recall` has to keep working when it does. Everything the index
 * returns, grep would have found too — just slower.
 *
 * The index is opened once and reused; the first call also builds it, which is
 * the only slow one.
 */
export class RecallSearch {
  private index: RecallIndex | undefined;
  private tried = false;

  constructor(
    private readonly chatDir: string = defaultChatLogDir(),
    /** Reports the first-run backfill, so a multi-second pause is not silent. */
    private readonly onBackfill: (fileCount: number) => void = () => {}
  ) {}

  async search(query: string): Promise<RecallResult> {
    const index = await this.ensureIndex();
    if (!index) {
      return { matches: await searchChatLogs(query, this.chatDir), source: 'grep' };
    }

    const reindexed = await index.sync(this.chatDir);
    if (reindexed > 0) this.onBackfill(reindexed);
    return { matches: index.search(query), source: 'index' };
  }

  async close(): Promise<void> {
    this.index?.close();
    this.index = undefined;
  }

  private async ensureIndex(): Promise<RecallIndex | undefined> {
    if (!this.tried) {
      this.tried = true;
      this.index = await RecallIndex.open();
    }
    return this.index;
  }
}
