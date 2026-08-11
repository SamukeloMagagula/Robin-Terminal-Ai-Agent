import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { WorkflowStore, isWorkflowConfig } from '../../src/workflow/store';
import type { WorkflowConfig } from '../../src/workflow/types';

function config(name = 'default'): WorkflowConfig {
  return {
    name,
    roles: {
      planner: { providerId: 'anthropic', model: 'claude-opus-5' },
      builder: { providerId: 'anthropic', model: 'claude-opus-5' },
      tester: { providerId: 'ollama', model: 'llama3.1' },
      validator: { providerId: 'anthropic', model: 'claude-opus-5' },
    },
  };
}

async function store(): Promise<{ dir: string; store: WorkflowStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-wf-'));
  return { dir, store: new WorkflowStore(dir) };
}

describe('isWorkflowConfig', () => {
  it('accepts a complete config', () => {
    expect(isWorkflowConfig(config())).toBe(true);
  });

  it('rejects one with a role missing', () => {
    // Partial acceptance would mean discovering the validator has no model
    // after the builder has already changed files.
    const partial = config() as unknown as { roles: Record<string, unknown> };
    delete partial.roles.validator;
    expect(isWorkflowConfig(partial)).toBe(false);
  });

  it('rejects a role missing its model', () => {
    const broken = config();
    (broken.roles.tester as unknown as Record<string, unknown>).model = undefined;
    expect(isWorkflowConfig(broken)).toBe(false);
  });

  it('rejects nonsense', () => {
    for (const bad of [null, [], 'workflow', {}, { name: 'x' }]) {
      expect(isWorkflowConfig(bad)).toBe(false);
    }
  });
});

describe('WorkflowStore', () => {
  it('round-trips a config', async () => {
    const { store: s } = await store();
    await s.write(config('release'));

    expect(await s.read('release')).toEqual(config('release'));
    expect(await s.list()).toEqual(['release']);
  });

  it('returns undefined for a missing workflow', async () => {
    const { store: s } = await store();
    expect(await s.read('nope')).toBeUndefined();
  });

  it('returns undefined for a malformed file rather than a partial config', async () => {
    const { dir, store: s } = await store();
    await fs.writeFile(path.join(dir, 'broken.json'), '{"name":"broken"}');

    expect(await s.read('broken')).toBeUndefined();
  });

  it('refuses a name that could escape the directory', async () => {
    const { store: s } = await store();
    await expect(s.write(config('../escape'))).rejects.toThrow(/Invalid workflow name/);
    expect(await s.read('../escape')).toBeUndefined();
  });

  it('forgets a workflow', async () => {
    const { store: s } = await store();
    await s.write(config('gone'));

    expect(await s.forget('gone')).toBe(true);
    expect(await s.forget('gone')).toBe(false);
  });

  it('tolerates a missing directory', async () => {
    const s = new WorkflowStore(path.join(os.tmpdir(), 'robin-wf-absent'));
    expect(await s.list()).toEqual([]);
  });

  it('returns roles in run order, not object key order', async () => {
    // Key order is not a contract; the pipeline's order is.
    expect(WorkflowStore.rolesInOrder(config()).map(([role]) => role)).toEqual([
      'planner',
      'builder',
      'tester',
      'validator',
    ]);
  });
});
