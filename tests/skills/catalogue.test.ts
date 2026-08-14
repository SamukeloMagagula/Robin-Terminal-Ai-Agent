import { describe, it, expect, vi } from 'vitest';
import {
  CATALOGUE_SOURCES,
  listCatalogue,
  fetchSkillBody,
  localNameFor,
} from '../../src/skills/catalogue';

function treeResponse(paths: string[]): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ tree: paths.map((path) => ({ path, type: 'blob' })), truncated: false }),
  }) as unknown as typeof fetch;
}

describe('CATALOGUE_SOURCES', () => {
  it('knows the three catalogues by name', () => {
    expect(Object.keys(CATALOGUE_SOURCES).sort()).toEqual(['anthropic', 'hermes', 'openclaw']);
  });

  it('points at the real repositories', () => {
    expect(CATALOGUE_SOURCES.anthropic.repo).toBe('anthropics/skills');
    expect(CATALOGUE_SOURCES.openclaw.repo).toBe('openclaw/openclaw');
    expect(CATALOGUE_SOURCES.hermes.repo).toBe('Undermybelt/hermes-skills');
  });
});

describe('listCatalogue', () => {
  it('finds skills under the source prefix', async () => {
    const fetchImpl = treeResponse([
      'skills/algorithmic-art/SKILL.md',
      'skills/brand-guidelines/SKILL.md',
      'README.md',
    ]);

    const found = await listCatalogue('anthropic', fetchImpl);

    expect(found.map((s) => s.name)).toEqual(['algorithmic-art', 'brand-guidelines']);
    expect(found[0].path).toBe('skills/algorithmic-art/SKILL.md');
  });

  it('keeps the category in a nested name, because leaf names collide', async () => {
    const fetchImpl = treeResponse([
      'skills/aegis/brainstorming/SKILL.md',
      'skills/research/brainstorming/SKILL.md',
    ]);

    const found = await listCatalogue('hermes', fetchImpl);

    expect(found.map((s) => s.name)).toEqual(['aegis/brainstorming', 'research/brainstorming']);
  });

  it('ignores anything outside the source prefix', async () => {
    const fetchImpl = treeResponse([
      '.agents/skills/auto-qa/SKILL.md',
      'docs/examples/SKILL.md',
    ]);

    const found = await listCatalogue('openclaw', fetchImpl);

    expect(found.map((s) => s.name)).toEqual(['auto-qa']);
  });

  it('refuses a source it does not know', async () => {
    await expect(listCatalogue('nonsense', treeResponse([]))).rejects.toThrow(/nonsense/);
  });

  it('reports a failed request rather than returning nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    await expect(listCatalogue('anthropic', fetchImpl)).rejects.toThrow(/403/);
  });

  // GitHub truncates very large trees. Silently listing a subset would make
  // "not found" mean two different things.
  it('says so when the listing was truncated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tree: [{ path: 'skills/a/SKILL.md' }], truncated: true }),
    }) as unknown as typeof fetch;

    await expect(listCatalogue('anthropic', fetchImpl)).rejects.toThrow(/truncated/i);
  });
});

describe('localNameFor', () => {
  it('leaves a plain name alone', () => {
    expect(localNameFor('anthropic', 'canvas-design')).toBe('anthropic-canvas-design');
  });

  // The store keys on a directory name, so a nested catalogue name has to
  // flatten — and it carries its source so two catalogues can both offer
  // "brainstorming" without one overwriting the other.
  it('flattens a nested name and keeps the source', () => {
    expect(localNameFor('hermes', 'aegis/brainstorming')).toBe('hermes-aegis-brainstorming');
  });

  it('produces a name the store will accept', () => {
    expect(localNameFor('hermes', 'a/b/c')).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});

describe('fetchSkillBody', () => {
  it('reads the file from the raw host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '---\nname: x\ndescription: d\n---\n\nbody',
    }) as unknown as typeof fetch;

    const body = await fetchSkillBody('anthropic', 'skills/x/SKILL.md', fetchImpl);

    expect(body).toContain('body');
    const url = String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(url).toContain('raw.githubusercontent.com');
    expect(url).toContain('anthropics/skills');
    expect(url).toContain('skills/x/SKILL.md');
  });

  it('reports a missing file rather than writing an error page as a skill', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
    await expect(fetchSkillBody('anthropic', 'skills/x/SKILL.md', fetchImpl)).rejects.toThrow(/404/);
  });

  // The path comes from a listing, but a crafted one must not be able to walk
  // out of the repository into another URL.
  it('refuses a path that tries to escape', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(fetchSkillBody('anthropic', '../../etc/passwd', fetchImpl)).rejects.toThrow(
      /path/i
    );
  });
});
