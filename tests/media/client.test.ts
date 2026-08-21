import { describe, it, expect, vi } from 'vitest';
import { createGeminiMedia, wavFromPcm, extensionFor, type MediaModels } from '../../src/media/client';

const models: MediaModels = {
  image: 'gemini-image',
  speech: 'gemini-tts',
  transcribe: 'gemini-audio',
  vision: 'gemini-vision',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function inlinePart(mimeType: string, data: Buffer) {
  return {
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] } }],
  };
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return createGeminiMedia({ apiKey: 'key-123', models, fetch: fetchImpl });
}

describe('generateImage', () => {
  it('asks the configured image model, authenticating with the api key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(inlineResponse('image/png'));
    await client(fetchImpl).generateImage('a red bicycle');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('gemini-image:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('key-123');
    expect(JSON.parse(init.body as string)).toMatchObject({
      contents: [{ parts: [{ text: 'a red bicycle' }] }],
    });
  });

  it('returns the decoded image', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(inlineResponse('image/png'));
    const result = await client(fetchImpl).generateImage('a red bicycle');
    expect(result.mimeType).toBe('image/png');
    expect(result.data.toString()).toBe('pretend-bytes');
  });

  it('explains itself when the model returned no image', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }));
    await expect(client(fetchImpl).generateImage('x')).rejects.toThrow(/no image/i);
  });

  it('surfaces the API error rather than a bare status code', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'API key not valid' } }, 400));
    await expect(client(fetchImpl).generateImage('x')).rejects.toThrow(/API key not valid/);
  });
});

function inlineResponse(mimeType: string): Response {
  return jsonResponse(inlinePart(mimeType, Buffer.from('pretend-bytes')));
}

describe('speak', () => {
  it('asks the configured speech model for audio', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(inlineResponse('audio/mpeg'));
    await client(fetchImpl).speak('hello there');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('gemini-tts:generateContent');
    expect(JSON.parse(init.body as string).generationConfig.responseModalities).toContain('AUDIO');
  });

  it('wraps raw PCM in a WAV container, so the file actually plays', async () => {
    const pcm = Buffer.from([0, 1, 2, 3]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(inlinePart('audio/L16;codec=pcm;rate=24000', pcm)));

    const result = await client(fetchImpl).speak('hello');

    expect(result.mimeType).toBe('audio/wav');
    expect(result.data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(result.data.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });

  it('leaves an already-playable format alone', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(inlineResponse('audio/mpeg'));
    const result = await client(fetchImpl).speak('hello');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.data.toString()).toBe('pretend-bytes');
  });
});

describe('transcribe', () => {
  it('sends the audio inline and returns the text', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'the words' }] } }] }));

    const text = await client(fetchImpl).transcribe(Buffer.from('audio'), 'audio/mp4');

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('audio/mp4');
    expect(text).toBe('the words');
  });

  it('joins every text part, so a long transcript is not truncated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'first half ' }, { text: 'second half' }] } }],
      })
    );
    expect(await client(fetchImpl).transcribe(Buffer.from('a'), 'audio/mp4')).toBe(
      'first half second half'
    );
  });

  it('explains itself when nothing came back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }));
    await expect(client(fetchImpl).transcribe(Buffer.from('a'), 'audio/mp4')).rejects.toThrow(
      /no transcript/i
    );
  });
});

describe('describeImage', () => {
  it('sends the image inline with the prompt, and returns the text', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'a red bicycle' }] } }] }));

    const text = await client(fetchImpl).describeImage(Buffer.from('png-bytes'), 'image/png', 'what is this?');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('gemini-vision:generateContent');
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[0].inlineData).toEqual({
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64'),
    });
    expect(body.contents[0].parts[1]).toEqual({ text: 'what is this?' });
    expect(body.generationConfig.responseModalities).toContain('TEXT');
    expect(text).toBe('a red bicycle');
  });

  it('joins every text part', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'first half ' }, { text: 'second half' }] } }],
      })
    );
    expect(await client(fetchImpl).describeImage(Buffer.from('a'), 'image/png', 'describe')).toBe(
      'first half second half'
    );
  });

  it('explains itself when nothing came back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }));
    await expect(
      client(fetchImpl).describeImage(Buffer.from('a'), 'image/png', 'describe')
    ).rejects.toThrow(/no description/i);
  });
});

describe('wavFromPcm', () => {
  it('writes a 44-byte header in front of the samples', () => {
    const wav = wavFromPcm(Buffer.alloc(100), 24000);
    expect(wav.length).toBe(144);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('records the sample rate it was given', () => {
    expect(wavFromPcm(Buffer.alloc(4), 16000).readUInt32LE(24)).toBe(16000);
  });
});

describe('extensionFor', () => {
  it.each([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['audio/wav', '.wav'],
    ['audio/mpeg', '.mp3'],
  ])('maps %j to %j', (mimeType, expected) => {
    expect(extensionFor(mimeType)).toBe(expected);
  });

  it('falls back to .bin rather than guessing', () => {
    expect(extensionFor('application/x-unknown')).toBe('.bin');
  });
});
