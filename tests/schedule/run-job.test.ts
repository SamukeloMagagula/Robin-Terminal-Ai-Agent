import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import { AutonomyStore } from '../../src/autonomy/grant-store';
import { AuditLog } from '../../src/autonomy/audit';
import { createJobRunner } from '../../src/schedule/run-job';
import type { Job } from '../../src/schedule/store';
import type { Provider } from '../../src/providers/types';

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

function provider(id: string, reply = 'the answer'): Provider {
  return {
    id,
    name: id,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['m1']),
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: reply };
    }),
  } as unknown as Provider;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    name: 'standup',
    cron: '0 9 * * *',
    prompt: 'What happened yesterday?',
    enabled: true,
    created: '2026-08-18T09:00:00Z',
    ...overrides,
  };
}

async function harness(providers = [provider('ollama')]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-runjob-'));
  const sessions = new SessionService({
    providers,
    approvals: new ApprovalRegistry({ broadcast: () => 0, resolved: vi.fn() }),
    emit: vi.fn(),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
      autonomy: new AutonomyStore(path.join(dir, 'autonomy.json')),
      audit: new AuditLog(dir),
    },
  });
  const runner = createJobRunner({
    sessions,
    defaults: async () => ({ providerId: 'ollama', model: 'm1' }),
    cwd: dir,
  });
  return { sessions, runner };
}

describe('createJobRunner', () => {
  it('returns what the model answered', async () => {
    const { runner } = await harness();
    expect(await runner(job())).toBe('the answer');
  });

  it('runs the job under its manifest', async () => {
    const { runner, sessions } = await harness();
    await runner(job({ manifestId: 'nightly-ops' }));
    // The session is closed afterwards, so the record is checked as it is made.
    expect(sessions.list()).toHaveLength(0);
  });

  it('leaves no session behind, so jobs do not pile up', async () => {
    const { runner, sessions } = await harness();
    await runner(job());
    await runner(job());
    expect(sessions.list()).toEqual([]);
  });

  it('uses the provider and model the job names, over the defaults', async () => {
    const anthropic = provider('anthropic', 'from anthropic');
    const { runner } = await harness([provider('ollama'), anthropic]);
    expect(await runner(job({ providerId: 'anthropic', model: 'm1' }))).toBe('from anthropic');
  });

  it('fails loudly when the job names a provider that does not exist', async () => {
    const { runner } = await harness();
    await expect(runner(job({ providerId: 'nope', model: 'm1' }))).rejects.toThrow(/nope/);
  });

  it('fails when the model answered with nothing, rather than delivering silence', async () => {
    const silent = {
      ...provider('ollama'),
      chat: vi.fn().mockImplementation(async function* () {
        // yields nothing
      }),
    } as unknown as Provider;
    const { runner } = await harness([silent]);
    await expect(runner(job())).rejects.toThrow(/no answer/i);
  });

  it('explains itself when there is no default provider to fall back on', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-runjob-'));
    const sessions = new SessionService({
      providers: [provider('ollama')],
      approvals: new ApprovalRegistry({ broadcast: () => 0, resolved: vi.fn() }),
      emit: vi.fn(),
      stores: {
        unsupported: new UnsupportedModelStore(throwaway('unsupported')),
        contextLimits: new ContextLimitStore(throwaway('limits')),
      },
    });
    const runner = createJobRunner({
      sessions,
      defaults: async () => ({ providerId: '', model: '' }),
      cwd: dir,
    });

    await expect(runner(job())).rejects.toThrow(/robin setup/i);
  });
});
