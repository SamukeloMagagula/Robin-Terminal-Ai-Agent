import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  MEDIA_TOOL_DEFINITIONS,
  generateImageTool,
  speakTool,
  transcribeTool,
  MAX_AUDIO_BYTES,
} from '../../src/media/tools';
import type { MediaClient } from '../../src/media/client';

function media(overrides: Partial<MediaClient> = {}): MediaClient {
  return {
    generateImage: vi.fn().mockResolvedValue({ data: Buffer.from('png'), mimeType: 'image/png' }),
    speak: vi.fn().mockResolvedValue({ data: Buffer.from('wav'), mimeType: 'audio/wav' }),
    transcribe: vi.fn().mockResolvedValue('the words'),
    ...overrides,
  };
}

async function workspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'robin-media-'));
}

const approve = vi.fn().mockResolvedValue(true);
const decline = vi.fn().mockResolvedValue(false);

describe('the media tool definitions', () => {
  it('offers exactly the three tools', () => {
    expect(MEDIA_TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'generate_image',
      'speak',
      'transcribe',
    ]);
  });
});

describe('generate_image', () => {
  it('writes the image where it was asked to', async () => {
    const cwd = await workspace();
    const client = media();
    const result = await generateImageTool(
      { prompt: 'a red bicycle', path: 'bike.png' },
      approve,
      client,
      cwd
    );

    expect(await fs.readFile(path.join(cwd, 'bike.png'), 'utf-8')).toBe('png');
    expect(result).toContain('bike.png');
  });

  it('asks before writing, as any other write does', async () => {
    const cwd = await workspace();
    const confirm = vi.fn().mockResolvedValue(true);
    await generateImageTool({ prompt: 'x', path: 'a.png' }, confirm, media(), cwd);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'write_file', subject: expect.stringContaining('a.png') })
    );
  });

  it('spends nothing when the write is declined', async () => {
    const cwd = await workspace();
    const client = media();
    const result = await generateImageTool({ prompt: 'x', path: 'a.png' }, decline, client, cwd);

    // The order matters: asking first means a refused image costs no API call.
    expect(client.generateImage).not.toHaveBeenCalled();
    expect(result).toMatch(/declined/i);
  });

  it('refuses a path inside a credential directory, without calling the API', async () => {
    const client = media();
    const result = await generateImageTool(
      { prompt: 'x', path: path.join(os.homedir(), '.ssh', 'evil.png') },
      approve,
      client,
      await workspace()
    );

    expect(result).toMatch(/^Error:/);
    expect(client.generateImage).not.toHaveBeenCalled();
  });

  it('reports what the model said when it declines to draw', async () => {
    const client = media({
      generateImage: vi.fn().mockRejectedValue(new Error('Gemini returned no image — it said: no')),
    });
    const result = await generateImageTool({ prompt: 'x', path: 'a.png' }, approve, client, await workspace());
    expect(result).toContain('no image');
  });

  it('needs a prompt', async () => {
    const result = await generateImageTool({ path: 'a.png' }, approve, media(), await workspace());
    expect(result).toMatch(/^Error:/);
  });
});

describe('speak', () => {
  it('writes the audio where it was asked to', async () => {
    const cwd = await workspace();
    await speakTool({ text: 'hello', path: 'hi.wav' }, approve, media(), cwd);
    expect(await fs.readFile(path.join(cwd, 'hi.wav'), 'utf-8')).toBe('wav');
  });

  it('asks before writing', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    await speakTool({ text: 'hello', path: 'hi.wav' }, confirm, media(), await workspace());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'write_file' }));
  });

  it('spends nothing when declined', async () => {
    const client = media();
    await speakTool({ text: 'hello', path: 'hi.wav' }, decline, client, await workspace());
    expect(client.speak).not.toHaveBeenCalled();
  });
});

describe('transcribe', () => {
  async function withAudio(bytes = Buffer.from('audio')): Promise<{ cwd: string; file: string }> {
    const cwd = await workspace();
    const file = path.join(cwd, 'memo.mp3');
    await fs.writeFile(file, bytes);
    return { cwd, file };
  }

  it('returns the transcript', async () => {
    const { cwd } = await withAudio();
    const result = await transcribeTool({ path: 'memo.mp3' }, approve, media(), cwd);
    expect(result).toContain('the words');
  });

  it('asks as a read, not a write', async () => {
    const { cwd } = await withAudio();
    const confirm = vi.fn().mockResolvedValue(true);
    await transcribeTool({ path: 'memo.mp3' }, confirm, media(), cwd);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'read_file' }));
  });

  it('spends nothing when declined', async () => {
    const { cwd } = await withAudio();
    const client = media();
    await transcribeTool({ path: 'memo.mp3' }, decline, client, cwd);
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it('sends the mime type the extension implies', async () => {
    const { cwd } = await withAudio();
    const client = media();
    await transcribeTool({ path: 'memo.mp3' }, approve, client, cwd);
    expect(client.transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio/mpeg');
  });

  it('refuses a file that does not exist, with a readable message', async () => {
    const cwd = await workspace();
    const result = await transcribeTool({ path: 'missing.mp3' }, approve, media(), cwd);
    expect(result).toMatch(/^Error:/);
  });

  it('refuses a file too large to send, rather than loading it all', async () => {
    const { cwd } = await withAudio(Buffer.alloc(MAX_AUDIO_BYTES + 1));
    const client = media();
    const result = await transcribeTool({ path: 'memo.mp3' }, approve, client, cwd);
    expect(result).toMatch(/too large/i);
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it('refuses to read a credential file', async () => {
    const client = media();
    const result = await transcribeTool(
      { path: path.join(os.homedir(), '.ssh', 'id_rsa') },
      approve,
      client,
      await workspace()
    );
    expect(result).toMatch(/^Error:/);
    expect(client.transcribe).not.toHaveBeenCalled();
  });
});
