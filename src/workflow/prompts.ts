import type { Role, WorkflowState, Verdict } from './types.js';

/**
 * Built-in instructions per role, so `/workflow new` only ever asks for four
 * provider/model pairs and works immediately.
 *
 * Each is written to be replaceable: a user overriding one should not have to
 * reconstruct scaffolding the orchestrator depends on. The only contract the
 * orchestrator relies on is the validator's VERDICT line.
 */
export const ROLE_PROMPTS: Record<Role, string> = {
  planner:
    'You are planning a piece of work. Produce a short, concrete plan: what to ' +
    'change, in what order, and how anyone will know it worked. Do not write the ' +
    'code. If the goal is ambiguous, state the reading you are planning against ' +
    'rather than asking — nobody is available to answer.',

  builder:
    'You are implementing an agreed plan. Make the change. Use your tools to read ' +
    'and edit real files rather than describing what you would do. When finished, ' +
    'summarise what you actually changed, file by file, and name anything you ' +
    'could not complete.',

  tester:
    'You are checking whether an implementation works. Run the project\'s own ' +
    'tests and any check the plan named. Report what you ran and the real output, ' +
    'including failures. Do not fix anything — reporting a failure accurately is ' +
    'the job.',

  validator:
    'You are judging whether the work meets the goal. You did not write it and ' +
    'must not assume it is correct. Check the implementation against the goal and ' +
    'the test results, then end your reply with a line reading exactly ' +
    '"VERDICT: PASS" or "VERDICT: FAIL", followed by your reasoning.',
};

/** Tools are off for the planner: deciding what to do is not doing it. */
export const ROLE_USES_TOOLS: Record<Role, boolean> = {
  planner: false,
  builder: true,
  tester: true,
  validator: true,
};

/**
 * The brief handed to one stage — the goal plus only the artifacts that stage
 * is entitled to see.
 */
export function buildBrief(role: Role, state: WorkflowState): string {
  const parts = [`GOAL\n${state.goal}`];

  if (role !== 'planner' && state.plan) parts.push(`PLAN\n${state.plan}`);
  if ((role === 'tester' || role === 'validator') && state.buildSummary) {
    parts.push(`WHAT WAS BUILT\n${state.buildSummary}`);
  }
  if (role === 'validator' && state.testReport) {
    parts.push(`TEST RESULTS\n${state.testReport}`);
  }
  // A retry after a failed verdict carries the reason; the builder is the only
  // stage that acts on it.
  if (role === 'builder' && state.verdict && !state.verdict.pass) {
    parts.push(`A PREVIOUS ATTEMPT WAS REJECTED\n${state.verdict.reasons}`);
  }
  return parts.join('\n\n');
}

const VERDICT_LINE = /^\s*VERDICT:\s*(PASS|FAIL)\s*$/im;

/**
 * Reads the validator's verdict.
 *
 * Returns undefined when the line is missing or unreadable rather than
 * guessing. A missing verdict is not a pass: treating it as one would let a
 * validator that wandered off-format silently approve the work.
 */
export function parseVerdict(reply: string): Verdict | undefined {
  const match = VERDICT_LINE.exec(reply);
  if (!match) return undefined;
  return {
    pass: match[1].toUpperCase() === 'PASS',
    reasons: reply.replace(VERDICT_LINE, '').trim(),
  };
}
