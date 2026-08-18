import { describe, it, expect } from 'vitest';
import {
  SETTINGS,
  findSetting,
  settingKeys,
  parseSettingValue,
  readEnvValue,
} from '../../src/settings/registry';

describe('the settings registry', () => {
  it('knows every key the design specifies', () => {
    expect(settingKeys()).toEqual([
      'browser',
      'debug',
      'default.model',
      'default.provider',
      'gateway.port',
      'history.enabled',
      'local.baseUrl',
      'media.imageModel',
      'media.speechModel',
      'media.transcribeModel',
    ]);
  });

  it('finds a known key and returns undefined for an unknown one', () => {
    expect(findSetting('gateway.port')?.type).toBe('number');
    expect(findSetting('gateway.prot')).toBeUndefined();
  });

  it('holds no key that would store a credential', () => {
    const secretish = /token|secret|password|apikey|api_key|credential/i;
    expect(SETTINGS.filter((s) => secretish.test(s.key))).toEqual([]);
  });

  it('gives every setting a description, so `config list` is self-documenting', () => {
    expect(SETTINGS.filter((s) => !s.description.trim())).toEqual([]);
  });
});

describe('parseSettingValue', () => {
  it('accepts a port inside the valid range', () => {
    expect(parseSettingValue(findSetting('gateway.port')!, '7777')).toBe(7777);
  });

  it.each(['0', '65536', '-1', 'eighty', '80.5', ''])('rejects the port %j', (raw) => {
    expect(() => parseSettingValue(findSetting('gateway.port')!, raw)).toThrow();
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['no', false],
  ])('reads the boolean %j as %j', (raw, expected) => {
    expect(parseSettingValue(findSetting('debug')!, raw as string)).toBe(expected);
  });

  it('rejects a boolean it cannot interpret rather than guessing', () => {
    expect(() => parseSettingValue(findSetting('debug')!, 'maybe')).toThrow();
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() => parseSettingValue(findSetting('local.baseUrl')!, 'not a url')).toThrow();
    expect(parseSettingValue(findSetting('local.baseUrl')!, 'http://127.0.0.1:1234/v1')).toBe(
      'http://127.0.0.1:1234/v1'
    );
  });

  it('rejects an empty string for a free-text setting', () => {
    expect(() => parseSettingValue(findSetting('default.model')!, '   ')).toThrow();
  });
});

describe('readEnvValue', () => {
  it('reads a port from the environment', () => {
    expect(readEnvValue(findSetting('gateway.port')!, { ROBIN_GATEWAY_PORT: '8080' })).toBe(8080);
  });

  it('ignores an environment value the setting cannot accept', () => {
    expect(readEnvValue(findSetting('gateway.port')!, { ROBIN_GATEWAY_PORT: 'nonsense' })).toBeUndefined();
  });

  it('treats any non-empty value of a flag variable as true', () => {
    expect(readEnvValue(findSetting('debug')!, { ROBIN_DEBUG: '1' })).toBe(true);
    expect(readEnvValue(findSetting('debug')!, { ROBIN_DEBUG: 'anything' })).toBe(true);
  });

  it('inverts ROBIN_NO_HISTORY_FILE into history.enabled', () => {
    expect(readEnvValue(findSetting('history.enabled')!, { ROBIN_NO_HISTORY_FILE: '1' })).toBe(false);
  });

  it('reports nothing when the variable is unset or empty', () => {
    expect(readEnvValue(findSetting('history.enabled')!, {})).toBeUndefined();
    expect(readEnvValue(findSetting('debug')!, { ROBIN_DEBUG: '' })).toBeUndefined();
  });

  it('reports nothing for a setting with no environment variable at all', () => {
    expect(readEnvValue(findSetting('default.provider')!, { ROBIN_DEFAULT_PROVIDER: 'copilot' })).toBeUndefined();
  });
});
