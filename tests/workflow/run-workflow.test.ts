import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { runWorkflow, type CheckpointAnswer } from '../../src/workflow/run-workflow';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';
import type { WorkflowConfig, Role } from '../../src/workflow/types';
import type { Provider } from '../../src/providers/types';

function config(): WorkflowConfig {
  const role = { providerId: 'stub', model: 'stub-model' };
  return { name: 'w', roles: { planner: role, builder: role, tester: role, validator: role } };
}

/** A provider whose reply depends on which role's brief it is handed. */
function scriptedProvider(replyFor: (brief: string) => string): Provider {
  return {
    id: 'stub',
    name: 'Stub',
    isAuthenticated: async () => true,
    login: async () => {},
    logout: async () => {},
    listModels: async () => [],
    chat: async function* (_model: string, messages: { role: string; content: string }[]) {
      const brief = messages[messages.length - 1]?.content ?? '';
      yield { type: 'text', text: replyFor(brief) };
    },
  } as unknown as Provider;
}

function deps(
  provider: Provider,
  checkpoint: (role: Role, output: string) => Promise<{ answer: CheckpointAnswer; feedback?: string }>
) {
  const notices: string[] = [];
  const stages: Role[] = [];
  return {
    notices,
    stages,
    deps: {
      resolveProvider: () => provider,
      turnOptions: {
        confirm: async () => false,
        unsupportedStore: new UnsupportedModelStore(
          path.join(os.tmpdir(), `wf-${Math.random()}.json`)
        ),
        providers: [],
      },
      onStageStart: (role: Role) => stages.push(role),
      onText: () => {},
      checkpoint,
      onNotice: (m: string) => notices.push(m),
    },
  };
}

const approve = async () => ({ answer: 'approve' as const });

describe('runWorkflow', () => {
  it('runs the four stages in order and passes', async () => {
    const provider = scriptedProvider((brief) =>
      brief.includes('TEST RESULTS') ? 'Looks right.\nVERDICT: PASS' : 'stage output'
    );
    const { deps: d, stages } = deps(provider, approve);

    const outcome = await runWorkflow(config(), 'add a health endpoint', d);

    expect(stages).toEqual(['planner', 'builder', 'tester', 'validator']);
    expect(outcome.reason).toBe('passed');
    expect(outcome.completed).toBe(true);
  });

  it('carries each stage\'s output forward as an artifact', async () => {
    const seen: string[] = [];
    const provider = scriptedProvider((brief) => {
      seen.push(brief);
      return brief.includes('TEST RESULTS') ? 'VERDICT: PASS' : `output for ${seen.length}`;
    });
    const { deps: d } = deps(provider, approve);

    await runWorkflow(config(), 'the goal', d);

    // The builder saw the plan; the validator saw everything before it.
    expect(seen[1]).toContain('output for 1');
    expect(seen[3]).toContain('TEST RESULTS');
  });

  it('loops back to the builder on a failing verdict', async () => {
    let validatorCalls = 0;
    const provider = scriptedProvider((brief) => {
      if (!brief.includes('TEST RESULTS')) return 'stage output';
      validatorCalls++;
      return validatorCalls === 1 ? 'VERDICT: FAIL\nmissing the auth check' : 'VERDICT: PASS';
    });
    const { deps: d, stages } = deps(provider, approve);

    const outcome = await runWorkflow(config(), 'the goal', d);

    // planner, builder, tester, validator, then builder again through validator.
    expect(stages).toEqual([
      'planner', 'builder', 'tester', 'validator',
      'builder', 'tester', 'validator',
    ]);
    expect(outcome.reason).toBe('passed');
  });

  it('stops after the loop-back cap rather than cycling', async () => {
    const provider = scriptedProvider((brief) =>
      brief.includes('TEST RESULTS') ? 'VERDICT: FAIL\nstill wrong' : 'stage output'
    );
    const { deps: d, stages, notices } = deps(provider, approve);

    const outcome = await runWorkflow(config(), 'the goal', d);

    expect(outcome.reason).toBe('exhausted');
    // Three build attempts total, not an unbounded loop.
    expect(stages.filter((r) => r === 'builder')).toHaveLength(3);
    expect(notices.join(' ')).toMatch(/still rejecting/);
  });

  it('passes the rejection reasons back to the builder', async () => {
    const briefs: string[] = [];
    let validatorCalls = 0;
    const provider = scriptedProvider((brief) => {
      briefs.push(brief);
      if (!brief.includes('TEST RESULTS')) return 'stage output';
      validatorCalls++;
      return validatorCalls === 1 ? 'VERDICT: FAIL\nMISSING AUTH CHECK' : 'VERDICT: PASS';
    });
    const { deps: d } = deps(provider, approve);

    await runWorkflow(config(), 'the goal', d);

    expect(briefs.some((b) => b.includes('MISSING AUTH CHECK'))).toBe(true);
  });

  it('asks the user when the verdict is unreadable, rather than assuming a pass', async () => {
    const provider = scriptedProvider(() => 'I think it is probably fine.');
    const checkpoint = vi.fn(async (role: Role) =>
      role === 'validator' ? { answer: 'quit' as const } : { answer: 'approve' as const }
    );
    const { deps: d, notices } = deps(provider, checkpoint);

    const outcome = await runWorkflow(config(), 'the goal', d);

    expect(notices.join(' ')).toMatch(/readable VERDICT/);
    expect(outcome.reason).toBe('quit');
  });

  it('quitting at any checkpoint ends the run', async () => {
    const provider = scriptedProvider(() => 'stage output');
    const { deps: d, stages } = deps(provider, async () => ({ answer: 'quit' as const }));

    const outcome = await runWorkflow(config(), 'the goal', d);

    expect(outcome.reason).toBe('quit');
    expect(stages).toEqual(['planner']);
  });

  it('skipping a stage moves on without recording its output', async () => {
    const provider = scriptedProvider((brief) =>
      brief.includes('TEST RESULTS') ? 'VERDICT: PASS' : 'stage output'
    );
    const checkpoint = vi.fn(async (role: Role) =>
      role === 'planner' ? { answer: 'skip' as const } : { answer: 'approve' as const }
    );
    const { deps: d } = deps(provider, checkpoint);

    const outcome = await runWorkflow(config(), 'the goal', d);

    expect(outcome.state.plan).toBeUndefined();
    expect(outcome.reason).toBe('passed');
  });

  it('retrying re-runs the same stage with the feedback attached', async () => {
    const briefs: string[] = [];
    let plannerRuns = 0;
    const provider = scriptedProvider((brief) => {
      briefs.push(brief);
      if (!brief.includes('PLAN')) plannerRuns++;
      return brief.includes('TEST RESULTS') ? 'VERDICT: PASS' : 'stage output';
    });
    let retried = false;
    const checkpoint = vi.fn(async (role: Role) => {
      if (role === 'planner' && !retried) {
        retried = true;
        return { answer: 'retry' as const, feedback: 'BE MORE SPECIFIC' };
      }
      return { answer: 'approve' as const };
    });
    const { deps: d } = deps(provider, checkpoint);

    await runWorkflow(config(), 'the goal', d);

    expect(plannerRuns).toBe(2);
    expect(briefs.some((b) => b.includes('BE MORE SPECIFIC'))).toBe(true);
  });

  it('ends the run when a stage cannot resolve its provider', async () => {
    const { deps: d, notices } = deps(scriptedProvider(() => 'x'), approve);
    d.resolveProvider = () => {
      throw new Error('Not logged in to anthropic.');
    };

    const outcome = await runWorkflow(config(), 'the goal', d);

    expect(outcome.reason).toBe('error');
    expect(notices.join(' ')).toMatch(/Not logged in/);
  });
});
