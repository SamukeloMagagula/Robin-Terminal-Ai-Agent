import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RecallMatch } from '../recall.js';
import { robinHome } from '../profile.js';

export function defaultIndexPath(): string {
  return path.join(robinHome(), 'index.db');
}

/** Rows returned per query, matching the grep path's cap. */
const MAX_MATCHES = 10;

interface Row {
  file: string;
  line_number: number;
  body: string;
}

/**
 * Minimal surface of better-sqlite3, declared locally.
 *
 * The module is loaded dynamically so a machine where the native binary will
 * not build still runs Robin — `open()` returns undefined there and the caller
 * falls back to grep. Importing it statically would make a broken install a
 * startup crash.
 */
interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): unknown;
}

/**
 * A full-text index over the markdown transcripts in ~/.robin/chats/.
 *
 * Exists because the grep path re-reads every transcript on every search,
 * which is fine at ten conversations and not at a thousand. It is strictly an
 * optimisation: everything it returns, grep would also have found.
 */
export class RecallIndex {
  private db: SqliteDatabase | undefined;

  private constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Opens the index, or returns undefined when SQLite is unavailable.
   *
   * Undefined is a normal outcome, not an error: better-sqlite3 is a native
   * module and its install can legitimately fail. Robin must not become
   * unusable because a prebuild was missing.
   */
  static async open(filePath: string = defaultIndexPath()): Promise<RecallIndex | undefined> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      // Loaded via a variable specifier so the local SqliteDatabase interface
      // above stays the contract — no @types dependency for a surface this
      // small, and no static import that would crash startup on a machine
      // where the native binary will not build.
      const specifier = 'better-sqlite3';
      const module = (await import(specifier)) as unknown as {
        default: new (path: string) => SqliteDatabase;
      };
      const db = new module.default(filePath);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS transcripts
          USING fts5(file UNINDEXED, line_number UNINDEXED, body);
        CREATE TABLE IF NOT EXISTS indexed_files (
          file TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL
        );
      `);
      return new RecallIndex(db);
    } catch {
      return undefined;
    }
  }

  /**
   * Brings the index up to date with the transcript directory.
   *
   * Incremental by mtime: a transcript Robin appended to this turn is
   * re-indexed, and the hundreds that did not change are skipped. Returns how
   * many files were re-read, which is what the first-run progress line shows.
   */
  async sync(dir: string): Promise<number> {
    const db = this.require();
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      return 0;
    }

    const known = new Map<string, number>();
    for (const row of db.prepare('SELECT file, mtime_ms FROM indexed_files').all() as {
      file: string;
      mtime_ms: number;
    }[]) {
      known.set(row.file, row.mtime_ms);
    }

    const insertRow = db.prepare(
      'INSERT INTO transcripts (file, line_number, body) VALUES (?, ?, ?)'
    );
    const deleteRows = db.prepare('DELETE FROM transcripts WHERE file = ?');
    const upsertFile = db.prepare(
      'INSERT INTO indexed_files (file, mtime_ms) VALUES (?, ?) ' +
        'ON CONFLICT(file) DO UPDATE SET mtime_ms = excluded.mtime_ms'
    );

    // One transaction for the whole sync. Without it every INSERT is its own
    // implicit transaction and SQLite fsyncs per row: a first-run backfill of
    // 13 transcripts measured 14.7 seconds, which is a visible hang on the
    // user's first /recall. Batched, the same work is well under a second.
    db.exec('BEGIN');
    let committed = false;
    try {
      const count = await this.syncFiles(dir, files, known, {
        insertRow,
        deleteRows,
        upsertFile,
        deleteFile: db.prepare('DELETE FROM indexed_files WHERE file = ?'),
      });
      db.exec('COMMIT');
      committed = true;
      return count;
    } finally {
      // A half-written index is worse than none: it would report stale mtimes
      // for files whose rows never landed, and never re-read them.
      if (!committed) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Nothing useful to do if the rollback itself fails.
        }
      }
    }
  }

  private async syncFiles(
    dir: string,
    files: string[],
    known: Map<string, number>,
    statements: {
      insertRow: { run(...p: unknown[]): unknown };
      deleteRows: { run(...p: unknown[]): unknown };
      upsertFile: { run(...p: unknown[]): unknown };
      deleteFile: { run(...p: unknown[]): unknown };
    }
  ): Promise<number> {
    const { insertRow, deleteRows, upsertFile, deleteFile } = statements;
    let reindexed = 0;
    for (const file of files) {
      const full = path.join(dir, file);
      let mtime: number;
      try {
        mtime = Math.floor((await fs.stat(full)).mtimeMs);
      } catch {
        continue;
      }
      if (known.get(file) === mtime) continue;

      let content: string;
      try {
        content = await fs.readFile(full, 'utf-8');
      } catch {
        continue;
      }

      deleteRows.run(file);
      content.split('\n').forEach((line, i) => {
        if (line.trim()) insertRow.run(file, i + 1, line);
      });
      upsertFile.run(file, mtime);
      reindexed++;
    }

    // A transcript deleted from disk must stop appearing in results.
    const present = new Set(files);
    for (const file of known.keys()) {
      if (!present.has(file)) {
        deleteRows.run(file);
        deleteFile.run(file);
      }
    }
    return reindexed;
  }

  /** Ranked matches, best first, in the same shape the grep path returns. */
  search(query: string, limit: number = MAX_MATCHES): RecallMatch[] {
    const db = this.require();
    const trimmed = query.trim();
    if (!trimmed) return [];

    try {
      const rows = db
        .prepare(
          'SELECT file, line_number, body FROM transcripts ' +
            'WHERE transcripts MATCH ? ORDER BY rank LIMIT ?'
        )
        .all(toMatchExpression(trimmed), limit) as Row[];
      return rows.map((row) => ({
        file: row.file,
        lineNumber: row.line_number,
        context: [row.body],
      }));
    } catch {
      // FTS5 rejects some punctuation as malformed query syntax. A bad query
      // is a miss, not a crash.
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // Nothing useful to do if it was already gone.
    }
    this.db = undefined;
  }

  private require(): SqliteDatabase {
    if (!this.db) throw new Error('Recall index is closed.');
    return this.db;
  }
}

/**
 * Turns a user's words into an FTS5 expression.
 *
 * Each term is quoted, because FTS5 treats bare punctuation as operators and
 * `/recall foo-bar` would otherwise be a syntax error rather than a search.
 */
export function toMatchExpression(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((term) => `"${term}"`).join(' ');
}
