import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message } from './providers/types.js';

/**
 * Transcripts contain everything discussed plus the contents of any file the
 * model read, so they live in the private ~/.robin tree rather than in
 * ~/Downloads, which is world-readable, backed up and scanned by other tools.
 */
export function defaultChatLogDir(): string {
  return path.join(os.homedir(), '.robin', 'chats');
}

function timestampForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function renderMarkdown(providerName: string, model: string, startedAt: Date, messages: Message[]): string {
  const lines = [
    '# Robin conversation',
    '',
    `- Provider: ${providerName}`,
    `- Model: ${model}`,
    `- Started: ${startedAt.toISOString()}`,
    `- Updated: ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ];

  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## You', '', message.content, '');
    } else if (message.role === 'assistant') {
      if (message.content) lines.push('## Robin', '', message.content, '');
      for (const call of message.toolCalls ?? []) {
        lines.push(`> used tool \`${call.name}\``, '');
      }
    } else if (message.role === 'tool') {
      const preview = message.content.length > 200 ? `${message.content.slice(0, 200)}...` : message.content;
      lines.push(`> tool result: ${preview.replace(/\n/g, ' ')}`, '');
    }
  }

  return lines.join('\n');
}

/** Writes a human-readable markdown transcript of the current conversation to ~/.robin/chats/. */
export class ChatLog {
  private filePath: string | undefined;
  private startedAt: Date | undefined;

  constructor(private readonly dir: string = defaultChatLogDir()) {}

  startNewSession(now: Date = new Date()): void {
    this.startedAt = now;
    this.filePath = path.join(this.dir, `robin-chat-${timestampForFilename(now)}.md`);
  }

  async write(providerName: string, model: string, messages: Message[]): Promise<void> {
    if (!this.filePath || !this.startedAt) this.startNewSession();
    const content = renderMarkdown(providerName, model, this.startedAt!, messages);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath!, content, { encoding: 'utf-8', mode: 0o600 });
  }
}
