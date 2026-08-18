import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const escalating: Manifest = {
  id: 'nightly-backup',
  created: '2026-08-17T09:12:00Z',
  rules: [{ kind: 'run_command', pattern: 'git *' }],
  expires: null,
  escalate: { surface: 'telegram', windowMinutes: 240 },
};

async function governance(manifest: Manifest) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-esc-'));
  const store = new AutonomyStore(path.join(dir, 'autonomy.json'));
  await store.put(manifest);
  return { manifestId: manifest.id, audit: new AuditLog(dir), store };
}

function registry(approverCount: number, timeoutMs?: number) {
  const seen: PendingApproval[] = [];
  const reg = new ApprovalRegistry({
    broadcast: (pending) => {
      seen.push(pending);
      return approverCount;
    },
    resolved: vi.fn(),
    timeoutMs,
  });
  return { reg, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('escalation', () => {
  it('offers the escalation target to clients on the pending approval', async () => {
    const { reg, seen } = registry(1);
    const gov = await governance(escalating);

    void reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].escalate).toEqual({ surface: 'telegram', windowMinutes: 240 });
  });

  it('carries no escalation target when the manifest sets none', async () => {
    const { reg, seen } = registry(1);
    const gov = await governance({ ...escalating, escalate: undefined });

    void reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].escalate).toBeUndefined();
  });

  it('waits the escalation window rather than the default timeout', async () => {
    // Default is one minute here; the window is 240, so at 90 minutes the
    // approval must still be answerable.
    const { reg, seen } = registry(1, 60_000);
    const gov = await governance(escalating);

    const answer = reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(90 * 60_000);

    expect(reg.answer(seen[0].id, true, 'telegram')).toBe(true);
    expect(await answer).toBe(true);
  });

  it('refuses once the window expires, and records it as expired', async () => {
    const { reg, seen } = registry(1, 60_000);
    const gov = await governance(escalating);

    const answer = reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(241 * 60_000);

    expect(await answer).toBe(false);
    await gov.audit.flush();
    expect((await gov.audit.read('nightly-backup')).at(-1)?.decision).toBe('expired');
  });

  it('leaves a session without governance on the default timeout', async () => {
    const { reg, seen } = registry(1, 60_000);

    const answer = reg.confirmFor(1, terminal, false)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(61_000);

    expect(await answer).toBe(false);
  });

  it('does not widen the window for a governed session without escalate', async () => {
    const { reg, seen } = registry(1, 60_000);
    const gov = await governance({ ...escalating, escalate: undefined });

    const answer = reg.confirmFor(1, terminal, false, gov)(command('restic snapshot'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(61_000);

    expect(await answer).toBe(false);
  });
});
