import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Message } from './providers/types.js';
import { robinHome } from './profile.js';

export interface SavedConversation {
  providerId: string;
  providerName: string;
  model: string;
  savedAt: string;
  messages: Message[];
}

export function defaultConversationsDir(): string {
  return path.join(robinHome(), 'conversations');
}

/** Slot names to filesystem-safe basenames — rejects anything that could escape the conversations directory. */
export function isValidConversationName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return VALID_ROLES.has(m.role as string) && typeof m.content === 'string';
}

/**
 * Save files are plain JSON on disk and can be hand-edited or corrupted. An
 * unchecked load put arbitrary objects straight into the live history, where a
 * missing `content` string later crashed rendering, /copy and the chat log.
 */
export function isSavedConversation(value: unknown): value is SavedConversation {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (typeof c.model !== 'string' || typeof c.providerName !== 'string') return false;
  return Array.isArray(c.messages) && c.messages.every(isMessage);
}

export class ConversationStore {
  constructor(private readonly dir: string = defaultConversationsDir()) {}

  private pathFor(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  async save(name: string, conversation: SavedConversation): Promise<void> {
    if (!isValidConversationName(name)) {
      throw new Error(`Invalid conversation name "${name}" — use letters, numbers, dots, dashes, underscores only.`);
    }
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.pathFor(name), JSON.stringify(conversation, null, 2), 'utf-8');
  }

  async load(name: string): Promise<SavedConversation> {
    if (!isValidConversationName(name)) {
      throw new Error(`Invalid conversation name "${name}" — use letters, numbers, dots, dashes, underscores only.`);
    }
    const raw = await fs.readFile(this.pathFor(name), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isSavedConversation(parsed)) {
      throw new Error('the file is not a valid saved conversation');
    }
    return parsed;
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
