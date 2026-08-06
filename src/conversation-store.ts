import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message } from './providers/types.js';

export interface SavedConversation {
  providerId: string;
  providerName: string;
  model: string;
  savedAt: string;
  messages: Message[];
}

export function defaultConversationsDir(): string {
  return path.join(os.homedir(), '.robin', 'conversations');
}

/** Slot names to filesystem-safe basenames — rejects anything that could escape the conversations directory. */
export function isValidConversationName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
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
    return JSON.parse(raw) as SavedConversation;
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
