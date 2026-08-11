import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseFrontmatter, renderFrontmatter } from '../frontmatter.js';

export interface Skill {
  name: string;
  /** One line, shown in the index — what tells the model when to reach for it. */
  description: string;
  /** The instructions themselves. Becomes the system prompt when applied. */
  body: string;
}

export type SkillMeta = Omit<Skill, 'body'>;

/** Only the index is sent every turn, so only the index is capped. */
export const MAX_SKILL_INDEX_BYTES = 4 * 1024;

export const SKILL_FILE = 'SKILL.md';

export function defaultSkillsDir(): string {
  return path.join(os.homedir(), '.robin', 'skills');
}

export function isValidSkillName(name: string): boolean {
  if (name === '.' || name === '..') return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

/**
 * Reusable instruction sets, one directory each with a SKILL.md inside.
 *
 * The directory-plus-SKILL.md layout is the agentskills.io shape, so a skill
 * written here can be shared with other tools, and one written elsewhere can
 * be dropped in — which a bespoke JSON file could never be.
 *
 * Robin's own earlier format was a flat `<name>.json` holding a system prompt.
 * Those are still read, so nothing a user saved before stops working, and
 * `/skill migrate` converts them.
 */
export class SkillStore {
  constructor(private readonly dir: string = defaultSkillsDir()) {}

  private markdownPath(name: string): string {
    return path.join(this.dir, name, SKILL_FILE);
  }

  private legacyPath(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  /** Every skill, markdown and legacy alike, by name. */
  async list(): Promise<SkillMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const out: SkillMeta[] = [];
    const seen = new Set<string>();
    for (const entry of entries.sort()) {
      const name = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : entry;
      if (seen.has(name) || !isValidSkillName(name)) continue;
      const skill = await this.read(name);
      if (skill) {
        seen.add(name);
        out.push({ name: skill.name, description: skill.description });
      }
    }
    return out;
  }

  /** Markdown wins over a legacy file of the same name — migration is one-way. */
  async read(name: string): Promise<Skill | undefined> {
    if (!isValidSkillName(name)) return undefined;

    try {
      const raw = await fs.readFile(this.markdownPath(name), 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (parsed) {
        return {
          name,
          description: parsed.fields.description ?? '',
          body: parsed.body,
        };
      }
    } catch {
      // Fall through to the legacy format.
    }

    try {
      const raw = await fs.readFile(this.legacyPath(name), 'utf-8');
      const parsed = JSON.parse(raw) as { prompt?: unknown };
      if (typeof parsed.prompt !== 'string') return undefined;
      return {
        name,
        description: '(saved before descriptions existed)',
        body: parsed.prompt,
      };
    } catch {
      return undefined;
    }
  }

  async write(skill: Skill): Promise<void> {
    if (!isValidSkillName(skill.name)) {
      throw new Error(
        `Invalid skill name "${skill.name}" — use letters, numbers, dots, dashes, underscores only.`
      );
    }
    const dir = path.join(this.dir, skill.name);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, SKILL_FILE),
      renderFrontmatter({ name: skill.name, description: skill.description }, skill.body),
      { mode: 0o600 }
    );
  }

  async forget(name: string): Promise<boolean> {
    if (!isValidSkillName(name)) return false;
    let removed = false;
    for (const target of [path.join(this.dir, name), this.legacyPath(name)]) {
      try {
        await fs.rm(target, { recursive: true, force: false });
        removed = true;
      } catch {
        // Not present in that form.
      }
    }
    return removed;
  }

  /**
   * Rewrites legacy `<name>.json` presets as `<name>/SKILL.md`.
   *
   * The originals are left in place rather than deleted: a conversion the user
   * did not ask for should not be able to lose the only copy of something they
   * wrote. `read()` prefers the markdown, so the leftover is inert.
   */
  async migrate(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }

    const migrated: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      if (!isValidSkillName(name)) continue;

      // Already converted — leave it alone rather than overwriting edits.
      try {
        await fs.access(this.markdownPath(name));
        continue;
      } catch {
        // Not yet converted.
      }

      const legacy = await this.read(name);
      if (!legacy) continue;
      await this.write({
        name,
        description: `Converted from a saved system prompt.`,
        body: legacy.body,
      });
      migrated.push(name);
    }
    return migrated;
  }

  /**
   * One line per skill for the system prompt.
   *
   * Descriptions only: the bodies are whole instruction sets, and sending them
   * all would cost more per turn than the skills are worth. The model pulls one
   * with `use_skill` when a line looks relevant.
   */
  async index(): Promise<string> {
    const all = await this.list();
    if (all.length === 0) return '';

    const lines = all.map((s) => `- ${s.name} — ${s.description}`);
    let start = 0;
    while (start < lines.length && lines.slice(start).join('\n').length > MAX_SKILL_INDEX_BYTES) {
      start++;
    }
    return lines.slice(start).join('\n');
  }
}
