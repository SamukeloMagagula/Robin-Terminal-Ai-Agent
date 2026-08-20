import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ROLES, isRole, type Role, type RoleConfig, type WorkflowConfig } from './types.js';
import { robinHome } from '../profile.js';

export function defaultWorkflowsDir(): string {
  return path.join(robinHome(), 'workflows');
}

export function isValidWorkflowName(name: string): boolean {
  if (name === '.' || name === '..') return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function isRoleConfig(value: unknown): value is RoleConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const role = value as Record<string, unknown>;
  return typeof role.providerId === 'string' && typeof role.model === 'string';
}

/**
 * A stored config is only usable if every role is present and well-formed.
 *
 * Partial acceptance would mean discovering halfway through a run that the
 * validator has no model — after the builder has already changed files.
 */
export function isWorkflowConfig(value: unknown): value is WorkflowConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (typeof config.name !== 'string') return false;

  const roles = config.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return false;
  const entries = roles as Record<string, unknown>;

  return ROLES.every((role) => isRole(role) && isRoleConfig(entries[role]));
}

/**
 * Saved four-role workflows, one JSON file each.
 *
 * JSON rather than markdown, unlike skills and memories: this is structured
 * configuration read by code, not instructions read by a model.
 */
export class WorkflowStore {
  constructor(private readonly dir: string = defaultWorkflowsDir()) {}

  private pathFor(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .filter(isValidWorkflowName)
        .sort();
    } catch {
      return [];
    }
  }

  /** Undefined for a missing or malformed file — never a half-built config. */
  async read(name: string): Promise<WorkflowConfig | undefined> {
    if (!isValidWorkflowName(name)) return undefined;
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathFor(name), 'utf-8')) as unknown;
      return isWorkflowConfig(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async write(config: WorkflowConfig): Promise<void> {
    if (!isValidWorkflowName(config.name)) {
      throw new Error(
        `Invalid workflow name "${config.name}" — use letters, numbers, dots, dashes, underscores only.`
      );
    }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.pathFor(config.name), JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  async forget(name: string): Promise<boolean> {
    if (!isValidWorkflowName(name)) return false;
    try {
      await fs.unlink(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }

  /** The roles in run order, so callers never rely on object key ordering. */
  static rolesInOrder(config: WorkflowConfig): [Role, RoleConfig][] {
    return ROLES.map((role) => [role, config.roles[role]]);
  }
}
