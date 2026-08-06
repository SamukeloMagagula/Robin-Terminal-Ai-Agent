import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SavedSkill {
  prompt: string;
  savedAt: string;
}

export function defaultSkillsDir(): string {
  return path.join(os.homedir(), '.robin', 'skills');
}

/** Slot names to filesystem-safe basenames — rejects anything that could escape the skills directory. */
export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

export class SkillStore {
  constructor(private readonly dir: string = defaultSkillsDir()) {}

  private pathFor(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  async save(name: string, skill: SavedSkill): Promise<void> {
    if (!isValidSkillName(name)) {
      throw new Error(`Invalid skill name "${name}" — use letters, numbers, dots, dashes, underscores only.`);
    }
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.pathFor(name), JSON.stringify(skill, null, 2), 'utf-8');
  }

  async load(name: string): Promise<SavedSkill> {
    if (!isValidSkillName(name)) {
      throw new Error(`Invalid skill name "${name}" — use letters, numbers, dots, dashes, underscores only.`);
    }
    const raw = await fs.readFile(this.pathFor(name), 'utf-8');
    return JSON.parse(raw) as SavedSkill;
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
