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

  /**
   * Points this log back at a transcript it was already writing.
   *
   * Without it, a session restored after the gateway restarts would start a
   * second file for a conversation that never ended, and one conversation would
   * arrive on disk as two.
   */
  resume(filePath: string, startedAt: Date): void {
    this.filePath = filePath;
    this.startedAt = startedAt;
  }

  /** Where this log is writing, so a restored session can carry on with it. */
  location(): { filePath: string; startedAt: Date } | undefined {
    if (!this.filePath || !this.startedAt) return undefined;
    return { filePath: this.filePath, startedAt: this.startedAt };
  }

  async write(providerName: string, model: string, messages: Message[]): Promise<void> {
    if (!this.filePath || !this.startedAt) this.startNewSession();
    const content = renderMarkdown(providerName, model, this.startedAt!, messages);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath!, content, { encoding: 'utf-8', mode: 0o600 });
  }
}
