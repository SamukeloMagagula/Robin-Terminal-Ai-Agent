import { describe, it, expect } from 'vitest';
import { buildBrief, parseVerdict, ROLE_USES_TOOLS } from '../../src/workflow/prompts';
import type { WorkflowState } from '../../src/workflow/types';

function state(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    goal: 'add a health endpoint',
    plan: 'THE PLAN',
    buildSummary: 'THE BUILD SUMMARY',
    testReport: 'THE TEST REPORT',
    attempt: 1,
    ...overrides,
  };
}

describe('buildBrief', () => {
  it('gives the planner only the goal', () => {
    const brief = buildBrief('planner', state());
    expect(brief).toContain('add a health endpoint');
    expect(brief).not.toContain('THE PLAN');
  });

  it('gives the builder the plan but not the test report', () => {
    const brief = buildBrief('builder', state());
    expect(brief).toContain('THE PLAN');
    expect(brief).not.toContain('THE TEST REPORT');
  });

  it('gives the tester the plan and the build summary', () => {
    const brief = buildBrief('tester', state());
    expect(brief).toContain('THE PLAN');
    expect(brief).toContain('THE BUILD SUMMARY');
    expect(brief).not.toContain('THE TEST REPORT');
  });

  it('gives the validator everything except the builder\'s reasoning', () => {
    // The validator gets the artifacts, never a transcript of the builder
    // arguing that its own work is correct — that bias is the whole reason
    // the role is separate.
    const brief = buildBrief('validator', state());
    expect(brief).toContain('THE PLAN');
    expect(brief).toContain('THE BUILD SUMMARY');
    expect(brief).toContain('THE TEST REPORT');
  });

  it('passes a rejection back to the builder, and to nobody else', () => {
    const rejected = state({ verdict: { pass: false, reasons: 'MISSING AUTH CHECK' } });
    expect(buildBrief('builder', rejected)).toContain('MISSING AUTH CHECK');
    expect(buildBrief('tester', rejected)).not.toContain('MISSING AUTH CHECK');
  });

  it('omits absent artifacts rather than printing empty sections', () => {
    const brief = buildBrief('validator', state({ plan: undefined, testReport: undefined }));
    expect(brief).not.toContain('PLAN\n');
    expect(brief).not.toContain('TEST RESULTS');
  });
});

describe('ROLE_USES_TOOLS', () => {
  it('denies the planner tools', () => {
    // A stage whose job is deciding what to do should not be editing files
    // while it decides.
    expect(ROLE_USES_TOOLS.planner).toBe(false);
    expect(ROLE_USES_TOOLS.builder).toBe(true);
  });
});

describe('parseVerdict', () => {
  it('reads a passing verdict and keeps the reasoning', () => {
    const verdict = parseVerdict('Looks correct.\nVERDICT: PASS\nAll criteria met.');
    expect(verdict?.pass).toBe(true);
    expect(verdict?.reasons).toContain('All criteria met.');
  });

  it('reads a failing verdict', () => {
    expect(parseVerdict('VERDICT: FAIL\nNo tests were run.')?.pass).toBe(false);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(parseVerdict('  verdict:   pass  ')?.pass).toBe(true);
  });

  it('returns undefined when the line is missing', () => {
    // Not a pass. Treating a missing verdict as approval would let a validator
    // that wandered off-format sign off on anything.
    expect(parseVerdict('I think it is probably fine.')).toBeUndefined();
  });

  it('does not match the word inside a sentence', () => {
    expect(parseVerdict('My verdict: pass it along to review.')).toBeUndefined();
  });
});
