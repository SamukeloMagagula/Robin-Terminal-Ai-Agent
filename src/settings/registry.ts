/**
 * Every setting Robin persists, in one table.
 *
 * A registry rather than a free-form object because `robin config set` has to
 * be able to refuse a key: a typo that silently becomes a stored setting is a
 * setting that never takes effect, and nothing ever says why. It is also what
 * keeps the next feature from inventing its own config file — a scheduler adds
 * a row here, not a new JSON blob in ~/.robin.
 *
 * Credentials are deliberately not expressible. auth-store.ts owns those, and
 * a registry that cannot hold a token means there is exactly one answer to
 * where tokens live. A test pins that.
 */

import { UserFacingError } from '../startup/bootstrap.js';
import { DEFAULT_PORT } from '../gateway/discovery.js';

export type SettingValue = string | number | boolean;

export interface SettingDefinition {
  readonly key: string;
  readonly type: 'string' | 'number' | 'boolean';
  /** Shown by `robin config list`. */
  readonly description: string;
  /**
   * The variable that overrides this setting, where one already existed.
   *
   * These predate settings.json, so they keep working untouched; the file is
   * the way to make one permanent, not a replacement for it.
   */
  readonly envVar?: string;
  /**
   * True when the variable states the opposite of the key.
   *
   * ROBIN_NO_HISTORY_FILE is the only one. The key is positive because a
   * double negative in configuration is reliably misread, and the variable
   * cannot be renamed without breaking anyone who already sets it.
   */
  readonly invertEnv?: boolean;
  /** Used when neither the environment nor the file has a value. */
  readonly fallback: SettingValue;
  /** Extra validation beyond the type, throwing its own reason. */
  readonly check?: (value: SettingValue) => void;
}

function checkPort(value: SettingValue): void {
  const port = value as number;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserFacingError(`A port must be a whole number from 1 to 65535 — got ${port}.`);
  }
}

function checkUrl(value: SettingValue): void {
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    throw new UserFacingError(`Not a URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UserFacingError(`A base URL must be http or https — got ${parsed.protocol}`);
  }
}

export const SETTINGS: readonly SettingDefinition[] = [
  {
    key: 'browser',
    type: 'string',
    description: 'Browser command used to open login pages',
    envVar: 'ROBIN_BROWSER',
    fallback: '',
  },
  {
    key: 'debug',
    type: 'boolean',
    description: 'Print full stack traces on error',
    envVar: 'ROBIN_DEBUG',
    fallback: false,
  },
  {
    key: 'default.model',
    type: 'string',
    description: 'Model `robin chat` uses when none is named',
    fallback: '',
  },
  {
    key: 'default.provider',
    type: 'string',
    description: 'Provider `robin chat` uses when none is named',
    fallback: '',
  },
  {
    key: 'gateway.port',
    type: 'number',
    description: 'Port the gateway listens on',
    envVar: 'ROBIN_GATEWAY_PORT',
    // Taken from the gateway rather than restated, so `config list` cannot
    // advertise a default the gateway does not actually use.
    fallback: DEFAULT_PORT,
    check: checkPort,
  },
  {
    key: 'history.enabled',
    type: 'boolean',
    description: 'Save REPL input history between sessions',
    envVar: 'ROBIN_NO_HISTORY_FILE',
    invertEnv: true,
    fallback: true,
  },
  {
    key: 'local.baseUrl',
    type: 'string',
    description: 'OpenAI-compatible endpoint for the local provider',
    envVar: 'ROBIN_LOCAL_BASE_URL',
    fallback: '',
    check: checkUrl,
  },
  {
    key: 'media.imageModel',
    type: 'string',
    description: 'Gemini model used by the generate_image tool',
    // A setting rather than a constant because Google renames these often
    // enough that a rename should not need a release.
    fallback: 'gemini-2.5-flash-image',
  },
  {
    key: 'media.speechModel',
    type: 'string',
    description: 'Gemini model used by the speak tool',
    fallback: 'gemini-2.5-flash-preview-tts',
  },
  {
    key: 'media.transcribeModel',
    type: 'string',
    description: 'Gemini model used by the transcribe tool',
    fallback: 'gemini-2.5-flash',
  },
];

export function settingKeys(): string[] {
  return SETTINGS.map((s) => s.key);
}

export function findSetting(key: string): SettingDefinition | undefined {
  return SETTINGS.find((s) => s.key === key);
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/**
 * Turns a string from the command line into a stored value, or throws.
 *
 * Validation happens here rather than at the point of use so that
 * `config set gateway.port 99999` fails at the command, not at gateway
 * startup days later with no memory of having set it.
 */
export function parseSettingValue(setting: SettingDefinition, raw: string): SettingValue {
  const text = raw.trim();

  if (setting.type === 'boolean') {
    const word = text.toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    throw new UserFacingError(
      `${setting.key} is true or false — got ${JSON.stringify(raw)}.`
    );
  }

  if (setting.type === 'number') {
    const value = Number(text);
    if (!text || Number.isNaN(value)) {
      throw new UserFacingError(`${setting.key} is a number — got ${JSON.stringify(raw)}.`);
    }
    setting.check?.(value);
    return value;
  }

  if (!text) throw new UserFacingError(`${setting.key} cannot be empty.`);
  setting.check?.(text);
  return text;
}

/**
 * The setting's value as the environment states it, if it states it at all.
 *
 * A malformed variable is reported as absent rather than thrown: the
 * environment is not something `robin config` can fix, and refusing to start
 * because of a stale export in a shell profile helps nobody. `config list`
 * is where a bad value becomes visible.
 */
export function readEnvValue(
  setting: SettingDefinition,
  env: NodeJS.ProcessEnv
): SettingValue | undefined {
  if (!setting.envVar) return undefined;
  const raw = env[setting.envVar]?.trim();
  if (!raw) return undefined;

  // A flag variable says only whether it is set; its text is not a value.
  if (setting.type === 'boolean') return !setting.invertEnv;

  try {
    return parseSettingValue(setting, raw);
  } catch {
    return undefined;
  }
}
