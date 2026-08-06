import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChatLog } from '../src/chat-log';

describe('ChatLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-log-test-'));
  });

  it('creates the directory and writes a markdown file on first write', async () => {
    const log = new ChatLog(dir);
    await log.write('Ollama (local)', 'llama3.1:latest', [{ role: 'user', content: 'hi' }]);

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^robin-chat-.*\.md$/);
  });

  it('renders provider, model, and message content into the markdown', async () => {
    const log = new ChatLog(dir);
    await log.write('Ollama (local)', 'llama3.1:latest', [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi, how can I help?' },
    ]);

    const files = await fs.readdir(dir);
    const content = await fs.readFile(path.join(dir, files[0]), 'utf-8');
    expect(content).toContain('Provider: Ollama (local)');
    expect(content).toContain('Model: llama3.1:latest');
    expect(content).toContain('## You');
    expect(content).toContain('hello there');
    expect(content).toContain('## Robin');
    expect(content).toContain('hi, how can I help?');
  });

  it('notes tool calls and tool results without dumping raw JSON', async () => {
    const log = new ChatLog(dir);
    await log.write('Ollama (local)', 'llama3.1:latest', [
      { role: 'user', content: 'read a.txt' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      },
      { role: 'tool', content: 'file contents here', toolCallId: 'call-1' },
    ]);

    const files = await fs.readdir(dir);
    const content = await fs.readFile(path.join(dir, files[0]), 'utf-8');
    expect(content).toContain('used tool `read_file`');
    expect(content).toContain('tool result: file contents here');
    expect(content).not.toContain('"path":"a.txt"');
  });

  it('keeps writing to the same file across multiple write() calls in a session', async () => {
    const log = new ChatLog(dir);
    await log.write('Ollama (local)', 'llama3.1:latest', [{ role: 'user', content: 'first' }]);
    await log.write('Ollama (local)', 'llama3.1:latest', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ]);

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(dir, files[0]), 'utf-8');
    expect(content).toContain('reply');
  });

  it('starts a new file after startNewSession() is called', async () => {
    const log = new ChatLog(dir);
    await log.write('Ollama (local)', 'llama3.1:latest', [{ role: 'user', content: 'first chat' }]);
    log.startNewSession(new Date(Date.now() + 60_000));
    await log.write('Ollama (local)', 'llama3.1:latest', [{ role: 'user', content: 'second chat' }]);

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(2);
  });
});
