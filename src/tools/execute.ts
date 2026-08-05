import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolCall } from '../providers/types.js';
import { defaultAuthPath } from '../auth-store.js';

const execAsync = promisify(exec);
const MAX_OUTPUT_LENGTH = 4000;
const MAX_PREVIEW_LENGTH = 500;

export type ConfirmFn = (message: string) => Promise<boolean>;

export async function executeTool(toolCall: ToolCall, confirm: ConfirmFn): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
  } catch (err) {
    return `Error: invalid tool arguments — ${(err as Error).message}`;
  }

  switch (toolCall.name) {
    case 'read_file':
      return readFileTool(args.path as string);
    case 'write_file':
      return writeFileTool(args.path as string, args.content as string, confirm);
    case 'run_command':
      return runCommandTool(args.command as string, confirm);
    default:
      return `Error: unknown tool "${toolCall.name}".`;
  }
}

/**
 * True when `filePath` resolves to something inside `directory` (or is the directory itself).
 * Exported for testing so the guard can be exercised without touching the real ~/.ai-term-chat.
 */
export function isInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedDir = path.resolve(directory);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile === resolvedDir) return true;
  const relative = path.relative(resolvedDir, resolvedFile);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readFileTool(filePath: string, authDir = path.dirname(defaultAuthPath())): Promise<string> {
  if (isInsideDirectory(filePath, authDir)) {
    return 'Error: refused to read credential file';
  }
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

async function writeFileTool(filePath: string, content: string, confirm: ConfirmFn): Promise<string> {
  const preview = content.length > MAX_PREVIEW_LENGTH ? `${content.slice(0, MAX_PREVIEW_LENGTH)}...` : content;
  const approved = await confirm(`Write to ${filePath}?\n---\n${preview}\n---`);
  if (!approved) {
    return `Write to ${filePath} was declined by the user.`;
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${filePath}.`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

async function runCommandTool(command: string, confirm: ConfirmFn): Promise<string> {
  const approved = await confirm(`Run "${command}"?`);
  if (!approved) {
    return `Command "${command}" was declined by the user.`;
  }
  try {
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 });
    const output = `${stdout}${stderr}`.slice(0, MAX_OUTPUT_LENGTH);
    return `Exit code: 0\n${output}`;
  } catch (err) {
    const execErr = err as { code?: number; stdout?: string; stderr?: string; message: string };
    const output = (`${execErr.stdout ?? ''}${execErr.stderr ?? ''}`.slice(0, MAX_OUTPUT_LENGTH)) || execErr.message;
    return `Exit code: ${execErr.code ?? 1}\n${output}`;
  }
}
