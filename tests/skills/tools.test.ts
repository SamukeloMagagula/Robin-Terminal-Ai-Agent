import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeTool } from '../../src/tools/execute';
import { SkillStore } from '../../src/skills/store';
import { SKILL_TOOL_DEFINITIONS } from '../../src/skills/tools';
import { composeSkillContext } from '../../src/skills/tools';
import { createSession, buildSystemPrompt } from '../../src/repl/session';
import type { Provider } from '../../src/providers/types';

async function skills(): Promise<SkillStore> {
  return new SkillStore(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-skilltool-')));
}

const call = (name: string, args: unknown) => ({ id: '1', name, arguments: JSON.stringify(args) });

describe('composeSkillContext', () => {
  it('returns nothing when there are no skills', () => {
    expect(composeSkillContext('')).toBeUndefined();
  });

  it('wraps the index with instructions for loading one', () => {
    const block = composeSkillContext('- reviewer — reviews code');
    expect(block).toContain('use_skill');
    expect(block).toContain('- reviewer — reviews code');
  });
});

describe('buildSystemPrompt with skills', () => {
  it('places skills after memory and before the user system prompt', () => {
    const s = createSession({ id: 'x', name: 'X' } as unknown as Provider, 'm');
    s.memory = 'MEMORY';
    s.skills = 'SKILLS';
    s.systemPrompt = 'SYSTEM';

    const prompt = buildSystemPrompt(s);

    expect(prompt.indexOf('MEMORY')).toBeLessThan(prompt.indexOf('SKILLS'));
    expect(prompt.indexOf('SKILLS')).toBeLessThan(prompt.indexOf('SYSTEM'));
  });
});

describe('use_skill', () => {
  it('returns the full instructions', async () => {
    const store = await skills();
    await store.write({ name: 'reviewer', description: 'd', body: 'THE INSTRUCTIONS' });

    const result = await executeTool(call('use_skill', { name: 'reviewer' }), async () => true, {
      skills: store,
    });

    expect(result).toContain('THE INSTRUCTIONS');
  });

  it('reports a missing skill rather than failing the turn', async () => {
    const result = await executeTool(call('use_skill', { name: 'nope' }), async () => true, {
      skills: await skills(),
    });

    expect(result).toMatch(/No skill named/);
  });
});

describe('create_skill, which no longer exists', () => {
  // Skills come from a catalogue now — Anthropic's, OpenClaw's or Hermes's —
  // installed with `robin skill add`. A model authoring its own was how a
  // question about an exam produced a skill for measuring the hardness of
  // metals, and how one reply put five proposals in front of the user.
  it('is not offered to the model', () => {
    expect(SKILL_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(['use_skill']);
  });

  it('is refused if a model asks for it anyway', async () => {
    const store = await skills();
    const confirm = vi.fn();

    const result = await executeTool(
      call('create_skill', { name: 'x', description: 'd', body: 'b' }),
      confirm,
      { skills: store }
    );

    expect(result).toMatch(/unknown tool/i);
    expect(confirm).not.toHaveBeenCalled();
    expect(await store.read('x')).toBeUndefined();
  });
});

describe('the rest of the skill tools', () => {
  it('the skill tools are unavailable when no store is configured', async () => {
    const result = await executeTool(call('use_skill', { name: 'x' }), async () => true, {});
    expect(result).toMatch(/not available/);
  });
});
