/**
 * Preferences, in ~/.robin/settings.json.
 *
 * Unlike channels.json this fails *open*: a missing or damaged file warns and
 * falls back to defaults rather than throwing. The difference is what the two
 * files are for. `robin serve telegram` was asked to bring one specific thing
 * online, so refusing to start is the honest answer. Settings are ambient —
 * every key here has a working default, and making `robin chat` unusable
 * because of a stray comma in a preferences file would be absurd.
 *
 * Precedence is environment > file > built-in default, matching the habit
 * channels.json already set. Which layer answered is carried on every result,
 * because the confusing case is real: you set a port, an old export in your
 * shell profile outranks it, and nothing ever says why it had no effect.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { UserFacingError } from '../startup/bootstrap.js';
import { pristineEnv } from './env.js';
import { robinHome } from '../profile.js';
import {
  SETTINGS,
  findSetting,
  parseSettingValue,
  readEnvValue,
  settingKeys,
  type SettingDefinition,
  type SettingValue,
} from './registry.js';

export function defaultSettingsPath(): string {
  return path.join(robinHome(), 'settings.json');
}

export interface ResolvedSetting {
  readonly setting: SettingDefinition;
  readonly value: SettingValue;
  readonly source: 'env' | 'file' | 'default';
  /**
   * The file's value, when the environment is overriding it.
   *
   * This is the whole reason `config list` is worth reading: it turns "my
   * setting does nothing" into a line that names the variable responsible.
   */
  readonly shadowed?: SettingValue;
}

type StoredSettings = Record<string, unknown>;

export class SettingsStore {
  private warned = false;

  constructor(
    private readonly filePath: string = defaultSettingsPath(),
    private readonly env: NodeJS.ProcessEnv = pristineEnv(),
    private readonly warn: (line: string) => void = (line) => console.error(line)
  ) {}

  /**
   * The file's contents, or an empty set if it is absent or unreadable.
   *
   * Damage is reported once per store rather than on every lookup: resolving
   * seven settings for `config list` would otherwise print the same warning
   * seven times.
   */
  private async read(): Promise<StoredSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      return {};
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as StoredSettings;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.warn(
          `Ignoring ${this.filePath} — ${err instanceof Error ? err.message : String(err)}. ` +
            'Using defaults. Fix the file, or delete it and set the keys again.'
        );
      }
      return {};
    }
  }

  private async write(stored: StoredSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf-8');
  }

  /**
   * A stored value, if it is one this key can actually hold.
   *
   * settings.json is a plain file someone may hand-edit, so a value of the
   * wrong type is treated as absent. Refusing to run over it would punish the
   * whole session for one bad line.
   */
  private storedValue(setting: SettingDefinition, stored: StoredSettings): SettingValue | undefined {
    const value = stored[setting.key];
    if (typeof value !== setting.type) return undefined;
    if (setting.check) {
      try {
        setting.check(value as SettingValue);
      } catch {
        return undefined;
      }
    }
    return value as SettingValue;
  }

  private resolveFrom(setting: SettingDefinition, stored: StoredSettings): ResolvedSetting {
    const fromFile = this.storedValue(setting, stored);
    const fromEnv = readEnvValue(setting, this.env);

    if (fromEnv !== undefined) {
      return { setting, value: fromEnv, source: 'env', shadowed: fromFile };
    }
    if (fromFile !== undefined) {
      return { setting, value: fromFile, source: 'file' };
    }
    return { setting, value: setting.fallback, source: 'default' };
  }

  private require(key: string): SettingDefinition {
    const setting = findSetting(key);
    if (!setting) {
      throw new UserFacingError(
        `No setting called "${key}". Robin knows:\n  ${settingKeys().join('\n  ')}`
      );
    }
    return setting;
  }

  async resolve(key: string): Promise<ResolvedSetting> {
    return this.resolveFrom(this.require(key), await this.read());
  }

  /** Every setting, in registry order — the backing for `robin config list`. */
  async resolveAll(): Promise<ResolvedSetting[]> {
    const stored = await this.read();
    return SETTINGS.map((setting) => this.resolveFrom(setting, stored));
  }

  /** The effective value, for callers that do not care where it came from. */
  async get(key: string): Promise<SettingValue> {
    return (await this.resolve(key)).value;
  }

  /**
   * Validates, then stores. Returns the parsed value for the caller to echo.
   *
   * Nothing is written if parsing throws, so a rejected value cannot leave a
   * half-updated file behind.
   */
  async set(key: string, raw: string): Promise<SettingValue> {
    const setting = this.require(key);
    const value = parseSettingValue(setting, raw);
    const stored = await this.read();
    stored[setting.key] = value;
    await this.write(stored);
    return value;
  }

  async unset(key: string): Promise<void> {
    const setting = this.require(key);
    const stored = await this.read();
    if (!(setting.key in stored)) return;
    delete stored[setting.key];
    await this.write(stored);
  }
}
