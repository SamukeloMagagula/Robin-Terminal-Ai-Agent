import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { defaultChatLogDir } from './chat-log.js';

export interface RecallMatch {
  file: string;
  lineNumber: number;
  context: string[];
}

const MAX_MATCHES = 10;

/** Searches saved chat-log markdown files (~/.robin/chats/) for lines containing `query`, newest files first. */
export async function searchChatLogs(query: string, dir: string = defaultChatLogDir()): Promise<RecallMatch[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const lowerQuery = trimmedQuery.toLowerCase();
  const matches: RecallMatch[] = [];

  for (const file of files) {
    const content = await fs.readFile(path.join(dir, file), 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(lowerQuery)) continue;
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      matches.push({ file, lineNumber: i + 1, context: lines.slice(start, end).filter((l) => l.trim()) });
      if (matches.length >= MAX_MATCHES) return matches;
    }
  }

  return matches;
}
