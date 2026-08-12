import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadChannelConfig, tokenEnvVar } from '../../src/channels/config';

async function configFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-channels-'));
  const file = path.join(dir, 'channels.json');
  await fs.writeFile(file, contents);
  return file;
}

const valid = JSON.stringify({
  channels: { telegram: { token: 'tok', allow: ['123'], provider: 'copilot', model: 'gpt-4o' } },
});

describe('tokenEnvVar', () => {
  it('names the conventional variable for a channel', () => {
    expect(tokenEnvVar('telegram')).toBe('TELEGRAM_BOT_TOKEN');
  });
});

describe('loadChannelConfig', () => {
  it('reads token, allowlist, provider and model', async () => {
    const config = await loadChannelConfig('telegram', await configFile(valid), {});
    expect(config).toEqual({ token: 'tok', allow: ['123'], provider: 'copilot', model: 'gpt-4o' });
  });

  it('lets the environment override the token in the file', async () => {
    const config = await loadChannelConfig('telegram', await configFile(valid), {
      TELEGRAM_BOT_TOKEN: 'from-env',
    });
    expect(config.token).toBe('from-env');
  });

  it('explains how to create the file when it is missing', async () => {
    await expect(loadChannelConfig('telegram', '/nope/channels.json', {})).rejects.toThrow(
      /No channel config at/
    );
  });

  it('reports malformed JSON rather than silently authorising nobody', async () => {
    const file = await configFile('{ not json');
    await expect(loadChannelConfig('telegram', file, {})).rejects.toThrow(/not valid JSON/);
  });

  it('reports a missing channel entry', async () => {
    const file = await configFile(JSON.stringify({ channels: {} }));
    await expect(loadChannelConfig('telegram', file, {})).rejects.toThrow(/No "telegram" entry/);
  });

  it('refuses to start with no token anywhere', async () => {
    const file = await configFile(JSON.stringify({ channels: { telegram: { allow: ['1'] } } }));
    await expect(loadChannelConfig('telegram', file, {})).rejects.toThrow(/No token/);
  });

  it('refuses to start with an empty allowlist, and points at --whoami', async () => {
    const file = await configFile(
      JSON.stringify({ channels: { telegram: { token: 't', allow: [] } } })
    );
    await expect(loadChannelConfig('telegram', file, {})).rejects.toThrow(/--whoami/);
  });

  it('permits an empty allowlist in discovery mode, which never reaches the model', async () => {
    const file = await configFile(
      JSON.stringify({ channels: { telegram: { token: 't', allow: [] } } })
    );
    const config = await loadChannelConfig('telegram', file, {}, { requireAllowlist: false });
    expect(config.allow).toEqual([]);
  });

  it('ignores a non-string provider or model rather than passing junk downstream', async () => {
    const file = await configFile(
      JSON.stringify({ channels: { telegram: { token: 't', allow: ['1'], provider: 7, model: {} } } })
    );
    const config = await loadChannelConfig('telegram', file, {});
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });
});
