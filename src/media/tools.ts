/**
 * The three media tools, gated by the machinery that already exists.
 *
 * Generating an image writes a file, and speaking writes a file, so both go
 * through checkPath and ask with kind 'write_file'. Transcribing reads one, so
 * it asks with kind 'read_file'. That is the whole design: no new approval
 * kind, no new manifest rule type, and no path handling of their own — which
 * is what makes it impossible for a media tool to write into ~/.ssh, and what
 * lets an existing manifest rule govern generated files without knowing
 * anything about media.
 *
 * The confirm comes *before* the API call in every case. A refused image that
 * had already been generated would have cost money for nothing.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ToolDefinition } from '../providers/types.js';
import type { ConfirmFn } from '../tools/execute.js';
import { checkPath, defaultSensitiveDirs } from '../tools/sensitive-paths.js';
import { extensionFor, type MediaClient } from './client.js';
import { captureScreen } from './screen-capture.js';

/**
 * Audio is base64'd into a request body, so the whole file is held in memory
 * twice over. A cap with a clear message beats an unexplained failure on a
 * podcast someone pointed at it by mistake.
 */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export const MEDIA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt and save it to a file. The user is asked ' +
      'before anything is written. Prefer a .png path.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image should show.' },
        path: { type: 'string', description: 'Where to save it, e.g. "diagram.png".' },
      },
      required: ['prompt', 'path'],
    },
  },
  {
    name: 'speak',
    description:
      'Turn text into spoken audio and save it to a file. The user is asked before ' +
      'anything is written. Prefer a .wav path.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The words to speak.' },
        path: { type: 'string', description: 'Where to save the audio, e.g. "reply.wav".' },
      },
      required: ['text', 'path'],
    },
  },
  {
    name: 'transcribe',
    description:
      'Read an audio file and return what is said in it. The user is asked before the ' +
      'file is read.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the audio file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'describe_screen',
    description:
      'Capture the current screen and describe what is on it. The user is asked ' +
      'before anything is captured. Optionally focus the description with a prompt, ' +
      'e.g. "what error is shown?".',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to look for or ask about the screenshot. Defaults to a general description.',
        },
      },
    },
  },
];

const AUDIO_MIME_TYPES = new Map<string, string>([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.webm', 'audio/webm'],
]);

function audioMimeType(filePath: string): string | undefined {
  return AUDIO_MIME_TYPES.get(path.extname(filePath).toLowerCase());
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required and must be a non-empty string.`);
  }
  return value;
}

/** Asks, then generates, then writes. Shared by the two tools that produce files. */
async function produceFile(
  filePath: string,
  cwd: string,
  confirm: ConfirmFn,
  describe: (resolved: string) => string,
  produce: () => Promise<{ data: Buffer; mimeType: string }>,
  declineNoun: string
): Promise<string> {
  const verdict = await checkPath(path.resolve(cwd, filePath), 'write', defaultSensitiveDirs());
  if (verdict.blocked) return `Error: ${verdict.refusal}`;

  const approved = await confirm({
    kind: 'write_file',
    message: describe(verdict.realPath),
    subject: verdict.realPath,
  });
  if (!approved) return `${declineNoun} was declined by the user.`;

  let produced: { data: Buffer; mimeType: string };
  try {
    produced = await produce();
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  try {
    await fs.mkdir(path.dirname(verdict.realPath), { recursive: true });
    await fs.writeFile(verdict.realPath, produced.data);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  const suggested = extensionFor(produced.mimeType);
  const mismatch =
    path.extname(verdict.realPath).toLowerCase() !== suggested && suggested !== '.bin'
      ? ` The data is ${produced.mimeType}; ${suggested} would be the matching extension.`
      : '';
  return `Saved ${produced.data.length} bytes to ${verdict.realPath}.${mismatch}`;
}

export async function generateImageTool(
  args: Record<string, unknown>,
  confirm: ConfirmFn,
  media: MediaClient,
  cwd: string = process.cwd()
): Promise<string> {
  let prompt: string;
  let filePath: string;
  try {
    prompt = requireText(args.prompt, 'prompt');
    filePath = requireText(args.path, 'path');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  return produceFile(
    filePath,
    cwd,
    confirm,
    (resolved) => `Generate an image and write it to ${resolved}?\n---\n${prompt}\n---`,
    () => media.generateImage(prompt),
    'Generating the image'
  );
}

export async function speakTool(
  args: Record<string, unknown>,
  confirm: ConfirmFn,
  media: MediaClient,
  cwd: string = process.cwd()
): Promise<string> {
  let text: string;
  let filePath: string;
  try {
    text = requireText(args.text, 'text');
    filePath = requireText(args.path, 'path');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  return produceFile(
    filePath,
    cwd,
    confirm,
    (resolved) => `Generate speech and write it to ${resolved}?\n---\n${text}\n---`,
    () => media.speak(text),
    'Generating the audio'
  );
}

export async function transcribeTool(
  args: Record<string, unknown>,
  confirm: ConfirmFn,
  media: MediaClient,
  cwd: string = process.cwd()
): Promise<string> {
  let filePath: string;
  try {
    filePath = requireText(args.path, 'path');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  const verdict = await checkPath(path.resolve(cwd, filePath), 'read', defaultSensitiveDirs());
  if (verdict.blocked) return `Error: ${verdict.refusal}`;

  const mimeType = audioMimeType(verdict.realPath);
  if (!mimeType) {
    return (
      `Error: ${path.extname(filePath) || 'that file'} is not an audio format Robin recognises. ` +
      `Known: ${[...AUDIO_MIME_TYPES.keys()].join(', ')}.`
    );
  }

  // Checked before asking: there is no point approving a read that cannot work.
  let size: number;
  try {
    size = (await fs.stat(verdict.realPath)).size;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  if (size > MAX_AUDIO_BYTES) {
    return `Error: ${verdict.realPath} is too large to transcribe (${size} bytes; the limit is ${MAX_AUDIO_BYTES}).`;
  }

  const approved = await confirm({
    kind: 'read_file',
    message: `Read ${verdict.realPath} and transcribe it?`,
    subject: verdict.realPath,
  });
  if (!approved) return 'Transcribing was declined by the user.';

  try {
    const audio = await fs.readFile(verdict.realPath);
    return await media.transcribe(audio, mimeType);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export async function describeScreenTool(
  args: Record<string, unknown>,
  confirm: ConfirmFn,
  media: MediaClient,
  capture: () => Promise<{ data: Buffer; mimeType: string }> = captureScreen
): Promise<string> {
  const prompt =
    typeof args.prompt === 'string' && args.prompt.trim()
      ? args.prompt
      : 'Describe what is on the screen.';

  const approved = await confirm({
    kind: 'capture_screen',
    message: `Capture the screen and describe it?\n---\n${prompt}\n---`,
    subject: 'screen',
  });
  if (!approved) return 'Screen capture was declined by the user.';

  let captured: { data: Buffer; mimeType: string };
  try {
    captured = await capture();
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  try {
    return await media.describeImage(captured.data, captured.mimeType, prompt);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
