import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import { SessionStore } from '../../src/gateway/session-store';
import { AutonomyStore } from '../../src/autonomy/grant-store';
import { AuditLog } from '../../src/autonomy/audit';
import type { Manifest } from '../../src/autonomy/manifest';
import type { Provider } from '../../src/providers/types';

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

/** Answers with text and never asks for a tool, so no turn executes anything. */
function textProvider(): Provider {
  return {
    id: 'ollama',
    name: 'Ollama (local)',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['m1']),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'ok' };
    }),
  } as unknown as Provider;
}

const nightly: Manifest = {
  id: 'nightly-ops',
  created: '2026-08-18T09:00:00Z',
  rules: [{ kind: 'run_command', pattern: 'git *' }],
  expires: null,
};

async function service(options: { sessions?: SessionStore } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-sess-gov-'));
  const autonomy = new AutonomyStore(path.join(dir, 'autonomy.json'));
  await autonomy.put(nightly);
  const audit = new AuditLog(dir);
  const approvals = new ApprovalRegistry({ broadcast: () => 0, resolved: vi.fn() });

  const svc = new SessionService({
    providers: [textProvider()],
    approvals,
    emit: vi.fn(),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
      autonomy,
      audit,
      sessions: options.sessions,
    },
  });
  return { svc, autonomy, audit, approvals, dir };
}

describe('a session created with a manifest', () => {
  it('reports the manifest it is governed by', async () => {
    const { svc } = await service();
    const snapshot = svc.create({
      providerId: 'ollama',
      model: 'm1',
      cwd: 'C:/work',
      manifestId: 'nightly-ops',
    });
    expect(snapshot.manifestId).toBe('nightly-ops');
  });

  it('hands that manifest to the approval registry when a turn runs', async () => {
    const { svc, approvals, autonomy, audit } = await service();
    const spy = vi.spyOn(approvals, 'confirmFor');
    const { id } = svc.create({
      providerId: 'ollama',
      model: 'm1',
      cwd: 'C:/work',
      manifestId: 'nightly-ops',
    });

    svc.sendPrompt(id, 'hello', { surface: 'terminal' });
    await svc.idle();

    expect(spy).toHaveBeenCalledWith(id, expect.anything(), false, {
      manifestId: 'nightly-ops',
      store: autonomy,
      audit,
    });
  });
});

describe('a session created without a manifest', () => {
  it('reports none', async () => {
    const { svc } = await service();
    expect(svc.create({ providerId: 'ollama', model: 'm1', cwd: 'C:/work' }).manifestId).toBeUndefined();
  });

  it('is given no governance at all, so nothing can grant on its behalf', async () => {
    const { svc, approvals } = await service();
    const spy = vi.spyOn(approvals, 'confirmFor');
    const { id } = svc.create({ providerId: 'ollama', model: 'm1', cwd: 'C:/work' });

    svc.sendPrompt(id, 'hello', { surface: 'terminal' });
    await svc.idle();

    expect(spy).toHaveBeenCalledWith(id, expect.anything(), false, undefined);
  });
});

describe('a governed session that outlives the gateway', () => {
  it('is still governed by the same manifest after a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-sess-persist-'));
    const sessions = new SessionStore(dir);

    const first = await service({ sessions });
    const { id } = first.svc.create({
      providerId: 'ollama',
      model: 'm1',
      cwd: 'C:/work',
      manifestId: 'nightly-ops',
    });
    first.svc.sendPrompt(id, 'hello', { surface: 'terminal' });
    await first.svc.idle();
    await first.svc.flush();

    const second = await service({ sessions });
    await second.svc.restore();

    expect(second.svc.snapshot(id).manifestId).toBe('nightly-ops');
  });
});
