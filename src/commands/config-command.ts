/**
 * `robin config` — the one place that answers "what is Robin set to do?".
 *
 * Printing is separated from the store so both halves stay testable: the
 * store knows precedence, this knows how to say it. Every function takes its
 * output sink, which is what lets the tests assert on lines rather than on a
 * captured console.
 */

import chalk from 'chalk';
import { mutedColor } from '../ui/theme.js';
import type { SettingsStore, ResolvedSetting } from '../settings/store.js';
import { SETTINGS, type SettingDefinition, type SettingValue } from '../settings/registry.js';

type Out = (line: string) => void;

/**
 * Column widths, computed from the registry rather than fixed.
 *
 * A hard-coded width silently breaks the moment a longer key is added, and
 * the misalignment is the kind of thing nobody notices in review.
 */
const KEY_WIDTH = Math.max(...SETTINGS.map((s) => s.key.length));
const VALUE_WIDTH = Math.max(
  ...SETTINGS.map((s) => String(s.fallback).length),
  'unset'.length + 2
);

/**
 * An empty free-text setting reads as "(unset)" rather than as nothing at all,
 * so a blank column cannot be mistaken for a rendering fault.
 */
export function describeValue(setting: SettingDefinition, value: SettingValue): string {
  if (setting.type === 'string' && !String(value)) return '(unset)';
  return String(value);
}

/** Where a value came from, and — when it matters — what it is hiding. */
function describeSource(resolved: ResolvedSetting): string {
  const { setting, source, shadowed } = resolved;
  if (source === 'default') return 'default';
  if (source === 'file') return 'settings.json';
  if (shadowed === undefined) return `from ${setting.envVar}`;
  return `from ${setting.envVar}, overriding ${shadowed} in settings.json`;
}

export function formatResolved(resolved: ResolvedSetting): string {
  const key = resolved.setting.key.padEnd(KEY_WIDTH);
  const value = describeValue(resolved.setting, resolved.value).padEnd(VALUE_WIDTH);
  return `  ${chalk.cyan(key)} ${value} ${mutedColor(describeSource(resolved))}`;
}

export async function runConfigList(store: SettingsStore, out: Out = console.log): Promise<void> {
  const all = await store.resolveAll();
  out('Settings:');
  for (const resolved of all) {
    out(formatResolved(resolved));
    out(`  ${' '.repeat(KEY_WIDTH)} ${mutedColor(resolved.setting.description)}`);
  }
  out('');
  out(mutedColor('Change one with `robin config set <key> <value>`.'));
}

export async function runConfigGet(
  store: SettingsStore,
  key: string,
  out: Out = console.log
): Promise<void> {
  out(formatResolved(await store.resolve(key)));
}

export async function runConfigSet(
  store: SettingsStore,
  key: string,
  value: string,
  out: Out = console.log
): Promise<void> {
  const stored = await store.set(key, value);
  out(`${chalk.green('✓')} ${key} = ${stored}`);

  // Saying this now is the whole point of tracking sources: without it the
  // setting looks accepted and then quietly does nothing.
  const resolved = await store.resolve(key);
  if (resolved.source === 'env') {
    out(
      mutedColor(
        `  Not in effect yet — ${resolved.setting.envVar} is set to ${resolved.value} and outranks the file.`
      )
    );
  }
}

export async function runConfigUnset(
  store: SettingsStore,
  key: string,
  out: Out = console.log
): Promise<void> {
  await store.unset(key);
  const resolved = await store.resolve(key);
  out(
    `${chalk.green('✓')} ${key} unset — now ${describeValue(resolved.setting, resolved.value)} (${describeSource(resolved)})`
  );
}
