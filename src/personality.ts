import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const PERSONALITY_FILENAME = 'PERSONALITY.md';

/**
 * 32 KB. Large enough for any hand-written instruction set, small enough that
 * a runaway or generated file cannot quietly consume the context window.
 */
export const MAX_PERSONALITY_BYTES = 32 * 1024;

export interface Personality {
  /** Absolute path, shown by /personality and used as the trust key. */
  source: string;
  /** 'global' is never prompted for; 'project' goes through the trust gate. */
  scope: 'global' | 'project';
  content: string;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_PERSONALITY_BYTES) return undefined;
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Personality files that apply here, least specific first.
 *
 * The working directory only — no walk up to the git root. Directory-walking
 * means the file shaping the model's behaviour can live somewhere the user is
 * not looking, which is the wrong property for this.
 */
export async function discoverPersonality(
  cwd: string = process.cwd(),
  homeDir: string = os.homedir()
): Promise<Personality[]> {
  const found: Personality[] = [];

  const globalPath = path.join(homeDir, '.robin', PERSONALITY_FILENAME);
  const globalContent = await readIfPresent(globalPath);
  if (globalContent !== undefined) {
    found.push({ source: globalPath, scope: 'global', content: globalContent });
  }

  const projectPath = path.join(cwd, PERSONALITY_FILENAME);
  const projectContent = await readIfPresent(projectPath);
  if (projectContent !== undefined) {
    found.push({ source: projectPath, scope: 'project', content: projectContent });
  }

  return found;
}
