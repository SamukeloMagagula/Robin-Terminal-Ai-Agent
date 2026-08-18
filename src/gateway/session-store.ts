import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message } from '../providers/types.js';

/**
 * How long an untouched session is kept.
 *
 * Without a limit, every directory Robin was ever run in leaves a session
 * nobody will open again, and `/session` becomes a list you have to read past
 * rather than one you can use.
 */
const KEEP_FOR_MS = 14 * 24 * 60 * 60 * 1000;

const FILE_PATTERN = /^session-(\d+)\.json$/;

export interface PersistedSession {
  id: number;
  label?: string;
  providerId: string;
  model: string;
  cwd: string;
  /** Absent in files written before origins existed; treated as a terminal. */
  origin?: 'terminal' | 'channel' | 'http' | 'schedule';
  /** Absent in files written before tokens were counted. */
  tokens?: { input: number; output: number };
  toolsEnabled: boolean;
  autoApprove: boolean;
  /** The manifest governing it, so a restart does not silently ungovern it. */
  manifestId?: string;
  turnCount: number;
  systemPrompt?: string;
  history: Message[];
  /** Where this conversation's markdown transcript is, so it stays one file. */
  transcript?: { path: string; startedAt: string };
  updatedAt: string;
}

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), '.robin', 'sessions');
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return ROLES.has(message.role as string) && typeof message.content === 'string';
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.id === 'number' &&
    typeof session.providerId === 'string' &&
    typeof session.model === 'string' &&
    typeof session.cwd === 'string' &&
    typeof session.toolsEnabled === 'boolean' &&
    typeof session.autoApprove === 'boolean' &&
    typeof session.turnCount === 'number' &&
    typeof session.updatedAt === 'string' &&
    Array.isArray(session.history) &&
    session.history.every(isMessage)
  );
}

/**
 * Open conversations, on disk, so they outlive the gateway.
 *
 * Written after every turn rather than on shutdown, and that is not
 * belt-and-braces: on Windows `robin gateway stop` terminates the daemon
 * outright and no exit handler runs, so a save-on-exit design would lose every
 * conversation on the platform it most needs to work on. Writing as we go also
 * survives a crash and a reboot, which save-on-exit never would.
 *
 * One file per session: a turn rewrites only the conversation it belongs to,
 * and a file that goes bad costs one conversation rather than all of them.
 *
 * Histories contain the contents of every file the model read, so these live in
 * the private ~/.robin tree with the same permissions transcripts get.
 */
export class SessionStore {
  constructor(private readonly dir: string = defaultSessionsDir()) {}

  private fileFor(id: number): string {
    return path.join(this.dir, `session-${id}.json`);
  }

  async save(session: PersistedSession): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(this.fileFor(session.id), JSON.stringify(session, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } catch {
      // Best-effort: failing to persist costs the conversation on restart, not
      // the turn the user is in the middle of.
    }
  }

  async remove(id: number): Promise<void> {
    await fs.rm(this.fileFor(id), { force: true }).catch(() => {});
  }

  /** Everything still worth restoring, oldest id first. Prunes as it goes. */
  async load(): Promise<PersistedSession[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const sessions: PersistedSession[] = [];
    const cutoff = Date.now() - KEEP_FOR_MS;

    for (const entry of entries) {
      if (!FILE_PATTERN.test(entry)) continue;
      const file = path.join(this.dir, entry);

      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
      } catch {
        // One unreadable file must not cost every other conversation.
        continue;
      }
      if (!isPersistedSession(parsed)) continue;

      const updatedAt = Date.parse(parsed.updatedAt);
      if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
        // Deleted rather than merely skipped, or it would be re-read on every
        // start for as long as the directory exists.
        await fs.rm(file, { force: true }).catch(() => {});
        continue;
      }
      sessions.push(parsed);
    }

    return sessions.sort((a, b) => a.id - b.id);
  }
}
