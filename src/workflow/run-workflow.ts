import type { Provider } from '../providers/types.js';
import { createSession } from '../repl/session.js';
import { runTurn, type TurnOptions } from '../repl/run-turn.js';
import { ROLE_PROMPTS, ROLE_USES_TOOLS, buildBrief, parseVerdict } from './prompts.js';
import { MAX_LOOP_BACKS, type Role, type WorkflowConfig, type WorkflowState } from './types.js';

export type CheckpointAnswer = 'approve' | 'retry' | 'skip' | 'quit';

export interface StageResult {
  role: Role;
  output: string;
  ok: boolean;
}

export interface WorkflowDeps {
  /** Resolves a role's configured provider; throws if it is not usable. */
  resolveProvider: (providerId: string) => Provider;
  /** Everything runTurn needs that the workflow does not own. */
  turnOptions: Omit<TurnOptions, 'onText' | 'tools'>;
  /** Announces a stage before it runs. */
  onStageStart: (role: Role, model: string, attempt: number) => void;
  /** Streams the stage's reply. */
  onText: (text: string) => void;
  /** Asks the user what to do after a stage. Feedback accompanies `retry`. */
  checkpoint: (role: Role, output: string) => Promise<{ answer: CheckpointAnswer; feedback?: string }>;
  /** Reports something the user needs to know that is not a stage output. */
  onNotice: (message: string) => void;
}

export interface WorkflowOutcome {
  completed: boolean;
  state: WorkflowState;
  /** Why the run ended, for the closing line. */
  reason: 'passed' | 'failed' | 'quit' | 'error' | 'exhausted';
}

/**
 * Runs the four stages, pausing after each.
 *
 * Every stage is a **fresh conversation** seeded with a brief, not a shared
 * thread — see buildBrief. The approval gate is untouched: three of four
 * stages run with tools on, and a workflow automates *prompting*, not consent.
 */
export async function runWorkflow(
  config: WorkflowConfig,
  goal: string,
  deps: WorkflowDeps
): Promise<WorkflowOutcome> {
  const state: WorkflowState = { goal, attempt: 1 };

  // The pipeline is a fixed sequence with one backward edge: a failed verdict
  // can send it to the builder again, bounded by MAX_LOOP_BACKS.
  let index = 0;
  const order: Role[] = ['planner', 'builder', 'tester', 'validator'];

  while (index < order.length) {
    const role = order[index];
    const roleConfig = config.roles[role];

    const result = await runStage(role, roleConfig, state, deps);
    if (!result.ok) {
      deps.onNotice(`The ${role} stage failed: ${result.output}`);
      return { completed: false, state, reason: 'error' };
    }

    // The validator's verdict is read *before* the checkpoint, so the user is
    // deciding with it in front of them rather than approving an output whose
    // meaning Robin has not yet worked out.
    const verdict = role === 'validator' ? parseVerdict(result.output) : undefined;
    if (role === 'validator') {
      if (!verdict) {
        deps.onNotice(
          'The validator did not end with a readable VERDICT line, so Robin cannot tell whether it passed. Approve to accept it anyway.'
        );
      } else {
        deps.onNotice(
          verdict.pass ? 'The validator passed the work.' : 'The validator rejected the work.'
        );
      }
    }

    const { answer, feedback } = await deps.checkpoint(role, result.output);
    if (answer === 'quit') return { completed: false, state, reason: 'quit' };
    if (answer === 'retry') {
      // Retry the same stage with the note appended, without advancing.
      state.goal = feedback ? `${goal}\n\nADDITIONAL DIRECTION\n${feedback}` : goal;
      continue;
    }
    if (answer === 'skip') {
      index++;
      continue;
    }

    record(role, result.output, state);

    if (role === 'validator') {
      // An unreadable verdict that the user approved anyway is treated as a
      // pass — they saw the notice and the output, and said go.
      if (!verdict || verdict.pass) {
        if (verdict) state.verdict = verdict;
        return { completed: true, state, reason: 'passed' };
      }
      state.verdict = verdict;

      if (state.attempt > MAX_LOOP_BACKS) {
        deps.onNotice(
          `Stopping after ${state.attempt} build attempts — the validator is still rejecting the work.`
        );
        return { completed: false, state, reason: 'exhausted' };
      }
      deps.onNotice('Sending it back to the builder with the reasons.');
      state.attempt++;
      index = order.indexOf('builder');
      continue;
    }

    index++;
  }

  return { completed: true, state, reason: 'passed' };
}

async function runStage(
  role: Role,
  roleConfig: { providerId: string; model: string; instructions?: string },
  state: WorkflowState,
  deps: WorkflowDeps
): Promise<StageResult> {
  let provider: Provider;
  try {
    provider = deps.resolveProvider(roleConfig.providerId);
  } catch (err) {
    return { role, output: (err as Error).message, ok: false };
  }

  deps.onStageStart(role, roleConfig.model, state.attempt);

  const session = createSession(provider, roleConfig.model);
  session.systemPrompt = roleConfig.instructions ?? ROLE_PROMPTS[role];
  session.toolsEnabled = ROLE_USES_TOOLS[role];

  let output = '';
  const result = await runTurn(session, buildBrief(role, state), {
    ...deps.turnOptions,
    tools: ROLE_USES_TOOLS[role],
    onText: (text) => {
      output += text;
      deps.onText(text);
    },
  });

  if (!result.ok) {
    return { role, output: result.error?.message ?? 'unknown error', ok: false };
  }
  return { role, output: output.trim(), ok: true };
}

function record(role: Role, output: string, state: WorkflowState): void {
  if (role === 'planner') state.plan = output;
  else if (role === 'builder') state.buildSummary = output;
  else if (role === 'tester') state.testReport = output;
}
