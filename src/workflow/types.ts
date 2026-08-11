export const ROLES = ['planner', 'builder', 'tester', 'validator'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleConfig {
  providerId: string;
  model: string;
  /** Overrides the built-in prompt for this role. */
  instructions?: string;
}

export interface WorkflowConfig {
  name: string;
  roles: Record<Role, RoleConfig>;
}

/**
 * What each stage has produced so far.
 *
 * Stages receive this rather than a shared conversation. The validator must
 * not inherit the builder's reasoning about why its own work is correct —
 * that is precisely the bias a separate validator exists to remove — and
 * explicit artifacts also let one stage be retried without replaying the rest.
 */
export interface WorkflowState {
  goal: string;
  plan?: string;
  buildSummary?: string;
  testReport?: string;
  verdict?: Verdict;
  /** Build attempts so far, including the current one. */
  attempt: number;
}

export interface Verdict {
  pass: boolean;
  reasons: string;
}

/**
 * Three build attempts total. Past that the loop is not converging, and
 * burning tokens on a fourth is worse than reporting what happened.
 */
export const MAX_LOOP_BACKS = 2;

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
