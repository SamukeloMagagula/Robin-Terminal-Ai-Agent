/**
 * `robin autonomy` — creating, inspecting and revoking capability manifests.
 *
 * A manifest is the one thing in Robin that lets a tool call run without
 * anyone being asked at the time, so the whole command is built around making
 * that decision explicit: the rules are printed in full before you are asked,
 * grants lapse after a week unless you say otherwise, an existing manifest is
 * never quietly widened, and `log` shows afterwards what the grant was
 * actually used for.
 *
 * Parsing and printing are separated from the store so both stay testable, in
 * the shape config-command.ts already uses.
 */

import chalk from 'chalk';
import { mutedColor } from '../ui/theme.js';
import { UserFacingError } from '../startup/bootstrap.js';
import type { AutonomyStore } from '../autonomy/grant-store.js';
import type { AuditLog } from '../autonomy/audit.js';
import type { Manifest, Rule, Escalation, RuleKind } from '../autonomy/manifest.js';

type Out = (line: string) => void;

/** Seven days. Long enough to be useful, short enough to be forgotten safely. */
const DEFAULT_EXPIRY = '7d';

export interface RuleFlags {
  command?: string[];
  read?: string[];
  write?: string[];
  mcp?: string[];
  expires?: string;
  escalate?: string;
}

/**
 * Turns `7d` / `24h` / `never` into the instant the grant lapses.
 *
 * Null means never, which the Manifest type already spells that way. Anything
 * unparseable throws rather than defaulting — quietly reading a typo as "never"
 * would turn a mistake into a permanent grant.
 */
export function parseExpiry(value: string, now: Date): string | null {
  const text = value.trim().toLowerCase();
  if (text === 'never') return null;

  const match = /^(\d+)([dh])$/.exec(text);
  if (!match) {
    throw new UserFacingError(
      `Cannot read "${value}" as a duration. Use 7d, 24h, or never.`
    );
  }
  const amount = Number(match[1]);
  if (amount <= 0) {
    throw new UserFacingError('A grant that has already lapsed is not worth creating.');
  }
  const hours = match[2] === 'd' ? amount * 24 : amount;
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
}

/** Reads `telegram:30` — where an approval may also be offered, and for how long. */
export function parseEscalation(value: string): Escalation {
  const [surface, minutes, ...rest] = value.split(':');
  const windowMinutes = Number(minutes);
  if (
    !surface ||
    rest.length > 0 ||
    !minutes ||
    !Number.isInteger(windowMinutes) ||
    windowMinutes <= 0
  ) {
    throw new UserFacingError(
      `Cannot read "${value}" as an escalation. Use surface:minutes, e.g. telegram:30.`
    );
  }
  return { surface, windowMinutes };
}

const FLAG_KINDS: [keyof RuleFlags, RuleKind][] = [
  ['command', 'run_command'],
  ['read', 'read_file'],
  ['write', 'write_file'],
  ['mcp', 'mcp_tool'],
];

/**
 * The four rule kinds are the four kinds a ConfirmRequest can have, so a flag
 * exists for each and nothing has to be invented or mapped by name.
 */
export function rulesFromFlags(flags: RuleFlags): Rule[] {
  const rules: Rule[] = [];
  for (const [flag, kind] of FLAG_KINDS) {
    for (const pattern of (flags[flag] as string[] | undefined) ?? []) {
      const trimmed = pattern.trim();
      if (trimmed) rules.push({ kind, pattern: trimmed });
    }
  }
  if (rules.length === 0) {
    throw new UserFacingError(
      'A manifest needs at least one rule. Add --command, --read, --write or --mcp.'
    );
  }
  return rules;
}

const KIND_LABELS: Record<RuleKind, string> = {
  run_command: 'run',
  read_file: 'read',
  write_file: 'write',
  mcp_tool: 'mcp',
};

function ruleLines(rules: Rule[]): string[] {
  return rules.map((rule) => `    ${KIND_LABELS[rule.kind].padEnd(6)} ${rule.pattern}`);
}

function hasLapsed(manifest: Manifest, now: Date): boolean {
  if (!manifest.expires) return false;
  const deadline = Date.parse(manifest.expires);
  return Number.isNaN(deadline) || deadline <= now.getTime();
}

function describeExpiry(manifest: Manifest, now: Date): string {
  if (!manifest.expires) return 'never expires';
  return hasLapsed(manifest, now) ? `EXPIRED ${manifest.expires}` : `expires ${manifest.expires}`;
}

export interface AddDeps {
  /** Asked after the rules are printed. False means write nothing. */
  confirm(): Promise<boolean>;
  now: Date;
  out: Out;
}

export async function runAutonomyAdd(
  store: AutonomyStore,
  id: string,
  flags: RuleFlags,
  deps: AddDeps
): Promise<void> {
  // Widening a grant should look like revoking and re-granting it, because
  // that is what it is. Editing in place hides the change.
  if (await store.get(id)) {
    throw new UserFacingError(
      `A manifest called "${id}" already exists. Revoke it first with \`robin autonomy revoke ${id}\`.`
    );
  }

  const rules = rulesFromFlags(flags);
  const expires = parseExpiry(flags.expires ?? DEFAULT_EXPIRY, deps.now);
  const escalate = flags.escalate ? parseEscalation(flags.escalate) : undefined;

  deps.out(`Manifest "${id}" would let Robin do this with nobody watching:`);
  deps.out('');
  for (const line of ruleLines(rules)) deps.out(line);
  deps.out('');
  deps.out(`    ${expires ? `expires ${expires}` : chalk.yellow('never expires')}`);
  if (escalate) {
    deps.out(`    approvals may also go to ${escalate.surface} for ${escalate.windowMinutes}m`);
  }
  deps.out('');

  if (!(await deps.confirm())) {
    deps.out(mutedColor('Nothing written.'));
    return;
  }

  const manifest: Manifest = {
    id,
    created: deps.now.toISOString(),
    rules,
    expires,
    ...(escalate ? { escalate } : {}),
  };
  await store.put(manifest);
  deps.out(`${chalk.green('✓')} Created "${id}".`);
  deps.out(mutedColor(`Use it with \`robin serve <channel> --manifest ${id}\`.`));
}

export async function runAutonomyList(
  store: AutonomyStore,
  out: Out = console.log,
  now: Date = new Date()
): Promise<void> {
  const manifests = await store.list();
  if (manifests.length === 0) {
    out('No manifests. Robin asks before every tool call that needs asking.');
    out(mutedColor('Create one with `robin autonomy add <id> --command "git *"`.'));
    return;
  }

  out('Manifests:');
  for (const manifest of manifests.sort((a, b) => a.id.localeCompare(b.id))) {
    const lapsed = hasLapsed(manifest, now);
    const mark = lapsed ? chalk.yellow('!') : chalk.green('•');
    const rules = `${manifest.rules.length} rule${manifest.rules.length === 1 ? '' : 's'}`;
    out(`  ${mark} ${chalk.cyan(manifest.id.padEnd(18))} ${rules.padEnd(9)} ${mutedColor(describeExpiry(manifest, now))}`);
  }
}

export async function runAutonomyShow(
  store: AutonomyStore,
  id: string,
  out: Out = console.log,
  now: Date = new Date()
): Promise<void> {
  const manifest = await requireManifest(store, id);
  out(`${chalk.cyan(manifest.id)} — created ${manifest.created}, ${describeExpiry(manifest, now)}`);
  out('');
  for (const line of ruleLines(manifest.rules)) out(line);
  if (manifest.escalate) {
    out('');
    out(
      `    approvals may also go to ${manifest.escalate.surface} for ${manifest.escalate.windowMinutes}m`
    );
  }
}

export async function runAutonomyRevoke(
  store: AutonomyStore,
  id: string,
  out: Out = console.log
): Promise<void> {
  await requireManifest(store, id);
  await store.remove(id);
  out(`${chalk.green('✓')} Revoked "${id}".`);
  out(mutedColor('Any session running under it stops being granted anything immediately.'));
}

export async function runAutonomyLog(
  audit: AuditLog,
  id: string,
  out: Out = console.log
): Promise<void> {
  const entries = await audit.read(id);
  if (entries.length === 0) {
    out(`"${id}" has done nothing yet — nothing has been allowed or refused under it.`);
    return;
  }

  out(`What "${id}" has been used for:`);
  for (const entry of entries) {
    const mark =
      entry.decision === 'allowed' ? chalk.green('allowed ') : chalk.yellow(`${entry.decision}`.padEnd(8));
    const rule = entry.rule ? mutedColor(` (${entry.rule})`) : '';
    out(`  ${mutedColor(entry.ts)} ${mark} ${entry.detail}${rule}`);
  }
}

/** Shared by show and revoke: naming a manifest that is not there is an error. */
async function requireManifest(store: AutonomyStore, id: string): Promise<Manifest> {
  const manifest = await store.get(id);
  if (!manifest) {
    throw new UserFacingError(
      `No manifest called "${id}". Run \`robin autonomy list\` to see what there is.`
    );
  }
  return manifest;
}
