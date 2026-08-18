/**
 * Images, speech and transcription, through the Gemini key Robin already has.
 *
 * Backed by Gemini rather than a dedicated media provider for one reason: the
 * key is already in auth.json from `robin login gemini`, so nothing here asks
 * anyone to open a second account. All three capabilities are the same REST
 * call with a different model and a different response modality, which is why
 * one small client covers them.
 *
 * The model ids are settings rather than constants. Google renames these
 * models often enough that a rename should be `robin config set`, not a
 * release.
 */

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface MediaModels {
  image: string;
  speech: string;
  transcribe: string;
}

export interface Media {
  data: Buffer;
  mimeType: string;
}

export interface MediaClient {
  generateImage(prompt: string): Promise<Media>;
  speak(text: string): Promise<Media>;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiMediaOptions {
  apiKey: string;
  models: MediaModels;
  fetch?: Fetcher;
}

interface InlineData {
  mimeType?: string;
  data?: string;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; inlineData?: InlineData }[] } }[];
  error?: { message?: string };
}

const EXTENSIONS = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['audio/wav', '.wav'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
]);

/** `.bin` rather than a guess: a wrong extension is worse than an honest one. */
export function extensionFor(mimeType: string): string {
  return EXTENSIONS.get(mimeType.split(';')[0].trim().toLowerCase()) ?? '.bin';
}

/**
 * Wraps raw PCM samples in a WAV container.
 *
 * Gemini's speech models answer with headerless 16-bit PCM, which no media
 * player will open — writing those bytes straight to a .wav would produce a
 * file that looks right and plays as nothing. The 44-byte header costs almost
 * nothing and is the difference between a usable file and a confusing one.
 */
export function wavFromPcm(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM header length
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Reads `rate=24000` out of a mime type like `audio/L16;codec=pcm;rate=24000`. */
function sampleRateOf(mimeType: string): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? Number(match[1]) : 24000;
}

function isRawPcm(mimeType: string): boolean {
  return /^audio\/l16/i.test(mimeType) || /codec=pcm/i.test(mimeType);
}

export function createGeminiMedia(options: GeminiMediaOptions): MediaClient {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));

  async function call(model: string, body: unknown): Promise<GeminiResponse> {
    const response = await doFetch(`${BASE_URL}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': options.apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: GeminiResponse;
    try {
      parsed = JSON.parse(text) as GeminiResponse;
    } catch {
      throw new Error(`Gemini returned something that is not JSON (HTTP ${response.status}).`);
    }

    // The API's own message says what is wrong — a key that is not valid, a
    // model that does not exist — where a status code says only that it failed.
    if (!response.ok || parsed.error) {
      throw new Error(parsed.error?.message ?? `Gemini refused the request (HTTP ${response.status}).`);
    }
    return parsed;
  }

  function parts(response: GeminiResponse): { text?: string; inlineData?: InlineData }[] {
    return response.candidates?.[0]?.content?.parts ?? [];
  }

  function firstInline(response: GeminiResponse): Media | undefined {
    for (const part of parts(response)) {
      if (part.inlineData?.data) {
        return {
          data: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType ?? 'application/octet-stream',
        };
      }
    }
    return undefined;
  }

  return {
    async generateImage(prompt: string): Promise<Media> {
      const response = await call(options.models.image, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      });

      const image = firstInline(response);
      if (!image) {
        // The model answers with text when it declines — usually a safety
        // refusal — and that text is the useful thing to pass on.
        const said = parts(response)
          .map((part) => part.text)
          .filter(Boolean)
          .join(' ')
          .trim();
        throw new Error(`Gemini returned no image${said ? ` — it said: ${said}` : '.'}`);
      }
      return image;
    },

    async speak(text: string): Promise<Media> {
      const response = await call(options.models.speech, {
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'] },
      });

      const audio = firstInline(response);
      if (!audio) throw new Error('Gemini returned no audio.');

      if (isRawPcm(audio.mimeType)) {
        return {
          data: wavFromPcm(audio.data, sampleRateOf(audio.mimeType)),
          mimeType: 'audio/wav',
        };
      }
      return audio;
    },

    async transcribe(audio: Buffer, mimeType: string): Promise<string> {
      const response = await call(options.models.transcribe, {
        contents: [
          {
            parts: [
              { inlineData: { mimeType, data: audio.toString('base64') } },
              { text: 'Transcribe this audio verbatim. Reply with the transcript and nothing else.' },
            ],
          },
        ],
      });

      const transcript = parts(response)
        .map((part) => part.text)
        .filter(Boolean)
        .join('')
        .trim();
      if (!transcript) throw new Error('Gemini returned no transcript.');
      return transcript;
    },
  };
}
