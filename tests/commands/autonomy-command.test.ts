import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { AutonomyStore } from '../../src/autonomy/grant-store';
import { AuditLog } from '../../src/autonomy/audit';
import {
  parseExpiry,
  parseEscalation,
  rulesFromFlags,
  runAutonomyAdd,
  runAutonomyList,
  runAutonomyRevoke,
  runAutonomyShow,
  runAutonomyLog,
} from '../../src/commands/autonomy-command';

const NOW = new Date('2026-08-18T12:00:00Z');

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-autonomy-cmd-'));
  const lines: string[] = [];
  return {
    store: new AutonomyStore(path.join(dir, 'autonomy.json')),
    audit: new AuditLog(dir),
    lines,
    out: (line: string) => lines.push(line),
    text: () => lines.join('\n').replace(/\[[0-9;]*m/g, ''),
  };
}

describe('parseExpiry', () => {
  it('reads days and hours as an instant in the future', () => {
    expect(parseExpiry('7d', NOW)).toBe('2026-08-25T12:00:00.000Z');
    expect(parseExpiry('24h', NOW)).toBe('2026-08-19T12:00:00.000Z');
  });

  it('understands never, which is the only way to get a grant that does not lapse', () => {
    expect(parseExpiry('never', NOW)).toBeNull();
  });

  it.each(['', '7', 'd7', '7 days', '-1d', '0d', 'forever'])('rejects %j', (value) => {
    expect(() => parseExpiry(value, NOW)).toThrow();
  });
});

describe('parseEscalation', () => {
  it('reads a surface and a window in minutes', () => {
    expect(parseEscalation('telegram:30')).toEqual({ surface: 'telegram', windowMinutes: 30 });
  });

  it.each(['telegram', 'telegram:', ':30', 'telegram:0', 'telegram:abc', 'telegram:-5'])(
    'rejects %j',
    (value) => {
      expect(() => parseEscalation(value)).toThrow();
    }
  );
});

describe('rulesFromFlags', () => {
  it('maps each flag to a rule of the matching kind', () => {
    expect(
      rulesFromFlags({
        command: ['git *'],
        read: ['~/notes/**'],
        write: ['~/reports/**'],
        mcp: ['github.list_issues'],
      })
    ).toEqual([
      { kind: 'run_command', pattern: 'git *' },
      { kind: 'read_file', pattern: '~/notes/**' },
      { kind: 'write_file', pattern: '~/reports/**' },
      { kind: 'mcp_tool', pattern: 'github.list_issues' },
    ]);
  });

  it('keeps every occurrence of a repeated flag', () => {
    expect(rulesFromFlags({ command: ['git *', 'restic backup *'] })).toHaveLength(2);
  });

  it('refuses a manifest with no rules, which would grant nothing and mislead', () => {
    expect(() => rulesFromFlags({})).toThrow();
  });
});

describe('robin autonomy add', () => {
  const flags = { command: ['git *'] };

  it('writes the manifest once it is confirmed', async () => {
    const h = await harness();
    await runAutonomyAdd(h.store, 'nightly', flags, {
      confirm: async () => true,
      now: NOW,
      out: h.out,
    });
    const saved = await h.store.get('nightly');
    expect(saved?.rules).toEqual([{ kind: 'run_command', pattern: 'git *' }]);
  });

  it('writes nothing when the confirmation is declined', async () => {
    const h = await harness();
    await runAutonomyAdd(h.store, 'nightly', flags, {
      confirm: async () => false,
      now: NOW,
      out: h.out,
    });
    expect(await h.store.get('nightly')).toBeUndefined();
  });

  it('shows the rules before asking, because a pattern grants more than it looks like', async () => {
    const h = await harness();
    const confirm = vi.fn().mockResolvedValue(false);
    await runAutonomyAdd(h.store, 'nightly', flags, { confirm, now: NOW, out: h.out });
    expect(h.text()).toContain('git *');
    expect(confirm).toHaveBeenCalled();
  });

  it('expires in seven days unless told otherwise', async () => {
    const h = await harness();
    await runAutonomyAdd(h.store, 'nightly', flags, {
      confirm: async () => true,
      now: NOW,
      out: h.out,
    });
    expect((await h.store.get('nightly'))?.expires).toBe('2026-08-25T12:00:00.000Z');
  });

  it('refuses to overwrite an existing manifest, since that would widen a grant silently', async () => {
    const h = await harness();
    await runAutonomyAdd(h.store, 'nightly', flags, {
      confirm: async () => true,
      now: NOW,
      out: h.out,
    });
    await expect(
      runAutonomyAdd(h.store, 'nightly', { command: ['rm *'] }, {
        confirm: async () => true,
        now: NOW,
        out: h.out,
      })
    ).rejects.toThrow(/already exists/i);
  });

  it('stores an escalation when one is asked for', async () => {
    const h = await harness();
    await runAutonomyAdd(
      h.store,
      'nightly',
      { ...flags, escalate: 'telegram:30' },
      { confirm: async () => true, now: NOW, out: h.out }
    );
    expect((await h.store.get('nightly'))?.escalate).toEqual({
      surface: 'telegram',
      windowMinutes: 30,
    });
  });
});

describe('robin autonomy list', () => {
  it('says so plainly when there are none', async () => {
    const h = await harness();
    await runAutonomyList(h.store, h.out, NOW);
    expect(h.text()).toMatch(/no manifests/i);
  });

  it('marks a manifest whose grant has lapsed', async () => {
    const h = await harness();
    await h.store.put({
      id: 'stale',
      created: '2026-08-01T00:00:00Z',
      rules: [{ kind: 'run_command', pattern: 'git *' }],
      expires: '2026-08-02T00:00:00Z',
    });
    await runAutonomyList(h.store, h.out, NOW);
    expect(h.text()).toMatch(/expired/i);
  });
});

describe('robin autonomy show', () => {
  it('prints every rule, one per line', async () => {
    const h = await harness();
    await h.store.put({
      id: 'nightly',
      created: '2026-08-18T00:00:00Z',
      rules: [
        { kind: 'run_command', pattern: 'git *' },
        { kind: 'read_file', pattern: '~/notes/**' },
      ],
      expires: null,
    });
    await runAutonomyShow(h.store, 'nightly', h.out);
    expect(h.text()).toContain('git *');
    expect(h.text()).toContain('~/notes/**');
  });

  it('refuses an id that names no manifest', async () => {
    const h = await harness();
    await expect(runAutonomyShow(h.store, 'ghost', h.out)).rejects.toThrow(/ghost/);
  });
});

describe('robin autonomy revoke', () => {
  it('removes it and confirms', async () => {
    const h = await harness();
    await h.store.put({
      id: 'nightly',
      created: '2026-08-18T00:00:00Z',
      rules: [{ kind: 'run_command', pattern: 'git *' }],
      expires: null,
    });
    await runAutonomyRevoke(h.store, 'nightly', h.out);
    expect(await h.store.get('nightly')).toBeUndefined();
    expect(h.text()).toContain('nightly');
  });

  it('refuses an id that names no manifest, rather than reporting a success', async () => {
    const h = await harness();
    await expect(runAutonomyRevoke(h.store, 'ghost', h.out)).rejects.toThrow(/ghost/);
  });
});

describe('robin autonomy log', () => {
  it('shows what was allowed and what was refused', async () => {
    const h = await harness();
    await h.audit.append({
      ts: '2026-08-18T02:00:00Z',
      manifest: 'nightly',
      kind: 'run_command',
      detail: 'git push',
      decision: 'allowed',
      rule: 'git *',
    });
    await h.audit.append({
      ts: '2026-08-18T02:00:01Z',
      manifest: 'nightly',
      kind: 'run_command',
      detail: 'rm -rf /',
      decision: 'refused',
      rule: null,
    });
    await h.audit.flush();

    await runAutonomyLog(h.audit, 'nightly', h.out);
    expect(h.text()).toContain('git push');
    expect(h.text()).toContain('rm -rf /');
    expect(h.text()).toMatch(/refused/i);
  });

  it('says so when a manifest has done nothing yet', async () => {
    const h = await harness();
    await runAutonomyLog(h.audit, 'quiet', h.out);
    expect(h.text()).toMatch(/nothing/i);
  });
});
