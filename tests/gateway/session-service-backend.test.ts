import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService } from '../../src/gateway/session-service';
import { ApprovalRegistry } from '../../src/gateway/approvals';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import { ContextLimitStore } from '../../src/providers/context-limits';
import type { Provider, Message, ChatEvent } from '../../src/providers/types';
import type { ExecutionBackend, RunOptions, RunResult } from '../../src/backends/types';

function throwaway(name: string): string {
  return path.join(os.tmpdir(), `robin-${name}-${Date.now()}-${Math.random()}.json`);
}

/** A provider whose first round issues a run_command tool call, then finishes. */
function providerRunningACommand(): Provider {
  let round = 0;
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['m1']),
    chat: vi.fn().mockImplementation(async function* (): AsyncIterable<ChatEvent> {
      if (round++ === 0) {
        yield {
          type: 'tool_call',
          toolCall: { id: 't1', name: 'run_command', arguments: JSON.stringify({ command: 'node --version' }) },
        };
      } else {
        yield { type: 'text', text: 'done' };
      }
    }),
  } as unknown as Provider;
}

function fakeBackend(): { backend: ExecutionBackend; run: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_command: string, _options: RunOptions): Promise<RunResult> => ({
    exitCode: 0,
    output: 'v20.0.0',
    timedOut: false,
  }));
  const dispose = vi.fn(async () => {});
  return { backend: { run, dispose }, run, dispose };
}

function service(createExecutionBackend: ReturnType<typeof vi.fn>) {
  const providers = [providerRunningACommand()];
  const svc = new SessionService({
    providers,
    approvals: new ApprovalRegistry({ broadcast: () => 1, resolved: vi.fn() }),
    emit: vi.fn(),
    stores: {
      unsupported: new UnsupportedModelStore(throwaway('unsupported')),
      contextLimits: new ContextLimitStore(throwaway('limits')),
    },
    createExecutionBackend,
  });
  return { svc, providers };
}

describe('SessionService — execution backend', () => {
  it('creates a backend lazily and routes run_command through it', async () => {
    const { backend, run } = fakeBackend();
    const createExecutionBackend = vi.fn(() => backend);
    const { svc } = service(createExecutionBackend);

    const snapshot = svc.create({
      providerId: 'copilot',
      model: 'm1',
      cwd: '/project',
      backend: { kind: 'docker', image: 'node:20' },
    });
    expect(createExecutionBackend).not.toHaveBeenCalled(); // lazy — not until first use

    svc.sendPrompt(snapshot.id, 'run node --version', { surface: 'terminal' });
    await svc.idle();

    expect(createExecutionBackend).toHaveBeenCalledTimes(1);
    expect(createExecutionBackend).toHaveBeenCalledWith({ kind: 'docker', image: 'node:20' }, '/project');
    expect(run).toHaveBeenCalledWith('node --version', expect.anything());
  });

  it('reuses the same backend instance across multiple turns in one session', async () => {
    const { backend } = fakeBackend();
    const createExecutionBackend = vi.fn(() => backend);
    const { svc } = service(createExecutionBackend);

    const snapshot = svc.create({
      providerId: 'copilot',
      model: 'm1',
      cwd: '/project',
      backend: { kind: 'docker', image: 'node:20' },
    });

    svc.sendPrompt(snapshot.id, 'first', { surface: 'terminal' });
    await svc.idle();
    svc.sendPrompt(snapshot.id, 'second', { surface: 'terminal' });
    await svc.idle();

    expect(createExecutionBackend).toHaveBeenCalledTimes(1);
  });

  it('disposes the backend when the session closes', async () => {
    const { backend, dispose } = fakeBackend();
    const createExecutionBackend = vi.fn(() => backend);
    const { svc } = service(createExecutionBackend);

    const snapshot = svc.create({
      providerId: 'copilot',
      model: 'm1',
      cwd: '/project',
      backend: { kind: 'docker', image: 'node:20' },
    });
    svc.sendPrompt(snapshot.id, 'go', { surface: 'terminal' });
    await svc.idle();

    svc.close(snapshot.id);
    await new Promise((r) => setTimeout(r, 20)); // dispose is fire-and-forget

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('a session with no backend config never creates one, using direct local execution', async () => {
    const createExecutionBackend = vi.fn();
    const { svc } = service(createExecutionBackend);

    const snapshot = svc.create({ providerId: 'copilot', model: 'm1', cwd: '/project' });
    svc.sendPrompt(snapshot.id, 'go', { surface: 'terminal' });
    await svc.idle();

    expect(createExecutionBackend).not.toHaveBeenCalled();
  });
});
