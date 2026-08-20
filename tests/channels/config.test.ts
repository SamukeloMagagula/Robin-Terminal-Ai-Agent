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

describe('loadChannelConfig — signal', () => {
  const signalFile = () =>
    configFile(
      JSON.stringify({
        channels: {
          signal: { phoneNumber: '+15551234567', apiUrl: 'http://localhost:8080', allow: ['+15559876543'] },
        },
      })
    );

  it('reads phoneNumber and apiUrl from the file', async () => {
    const config = await loadChannelConfig('signal', await signalFile(), {});
    expect(config.phoneNumber).toBe('+15551234567');
    expect(config.apiUrl).toBe('http://localhost:8080');
  });

  it('lets SIGNAL_PHONE_NUMBER override the file, not SIGNAL_BOT_TOKEN', async () => {
    const config = await loadChannelConfig('signal', await signalFile(), {
      SIGNAL_PHONE_NUMBER: '+15550001111',
      SIGNAL_BOT_TOKEN: 'should-be-ignored',
    });
    expect(config.phoneNumber).toBe('+15550001111');
  });

  it('lets SIGNAL_API_URL override the file', async () => {
    const config = await loadChannelConfig('signal', await signalFile(), {
      SIGNAL_API_URL: 'http://elsewhere:9000',
    });
    expect(config.apiUrl).toBe('http://elsewhere:9000');
  });

  it('refuses to start with no phone number anywhere', async () => {
    const file = await configFile(
      JSON.stringify({ channels: { signal: { apiUrl: 'http://localhost:8080', allow: ['1'] } } })
    );
    await expect(loadChannelConfig('signal', file, {})).rejects.toThrow(/No phone number/);
  });

  it('refuses to start with no apiUrl anywhere', async () => {
    const file = await configFile(
      JSON.stringify({ channels: { signal: { phoneNumber: '+15551234567', allow: ['1'] } } })
    );
    await expect(loadChannelConfig('signal', file, {})).rejects.toThrow(/No API URL/);
  });
});

describe('loadChannelConfig — whatsapp', () => {
  const whatsappFile = () =>
    configFile(
      JSON.stringify({
        channels: {
          whatsapp: {
            token: 'wa-token',
            phoneNumberId: '109876543210987',
            verifyToken: 'my-verify-token',
            appSecret: 'my-app-secret',
            webhookPort: 8443,
            allow: ['15559876543'],
          },
        },
      })
    );

  it('reads phoneNumberId, verifyToken, appSecret and webhookPort from the file', async () => {
    const config = await loadChannelConfig('whatsapp', await whatsappFile(), {});
    expect(config.phoneNumberId).toBe('109876543210987');
    expect(config.verifyToken).toBe('my-verify-token');
    expect(config.appSecret).toBe('my-app-secret');
    expect(config.webhookPort).toBe(8443);
  });

  it('lets env vars override the file for all four fields', async () => {
    const config = await loadChannelConfig('whatsapp', await whatsappFile(), {
      WHATSAPP_PHONE_NUMBER_ID: 'env-id',
      WHATSAPP_VERIFY_TOKEN: 'env-verify',
      WHATSAPP_APP_SECRET: 'env-secret',
      WHATSAPP_WEBHOOK_PORT: '9000',
    });
    expect(config.phoneNumberId).toBe('env-id');
    expect(config.verifyToken).toBe('env-verify');
    expect(config.appSecret).toBe('env-secret');
    expect(config.webhookPort).toBe(9000);
  });

  it('refuses to start with no phoneNumberId anywhere', async () => {
    const file = await configFile(
      JSON.stringify({
        channels: {
          whatsapp: {
            token: 't',
            verifyToken: 'v',
            appSecret: 's',
            webhookPort: 8443,
            allow: ['1'],
          },
        },
      })
    );
    await expect(loadChannelConfig('whatsapp', file, {})).rejects.toThrow(/No phone number id/);
  });

  it('refuses to start with no verifyToken anywhere', async () => {
    const file = await configFile(
      JSON.stringify({
        channels: {
          whatsapp: { token: 't', phoneNumberId: 'id', appSecret: 's', webhookPort: 8443, allow: ['1'] },
        },
      })
    );
    await expect(loadChannelConfig('whatsapp', file, {})).rejects.toThrow(/No verify token/);
  });

  it('refuses to start with no appSecret anywhere', async () => {
    const file = await configFile(
      JSON.stringify({
        channels: {
          whatsapp: { token: 't', phoneNumberId: 'id', verifyToken: 'v', webhookPort: 8443, allow: ['1'] },
        },
      })
    );
    await expect(loadChannelConfig('whatsapp', file, {})).rejects.toThrow(/No app secret/);
  });

  it('refuses to start with no webhookPort anywhere', async () => {
    const file = await configFile(
      JSON.stringify({
        channels: { whatsapp: { token: 't', phoneNumberId: 'id', verifyToken: 'v', appSecret: 's', allow: ['1'] } },
      })
    );
    await expect(loadChannelConfig('whatsapp', file, {})).rejects.toThrow(/No webhook port/);
  });

  it('refuses a non-numeric WHATSAPP_WEBHOOK_PORT rather than silently producing NaN', async () => {
    const config = loadChannelConfig('whatsapp', await whatsappFile(), {
      WHATSAPP_WEBHOOK_PORT: 'not-a-port',
    });
    await expect(config).rejects.toThrow(/No webhook port/);
  });

  it('accepts a webhookPort of 0, meaning "let the OS pick"', async () => {
    const file = await configFile(
      JSON.stringify({
        channels: {
          whatsapp: {
            token: 't',
            phoneNumberId: 'id',
            verifyToken: 'v',
            appSecret: 's',
            webhookPort: 0,
            allow: ['1'],
          },
        },
      })
    );
    const config = await loadChannelConfig('whatsapp', file, {});
    expect(config.webhookPort).toBe(0);
  });

  it('still requires the generic token', async () => {
    const file = await configFile(
      JSON.stringify({
        channels: {
          whatsapp: { phoneNumberId: 'id', verifyToken: 'v', appSecret: 's', webhookPort: 8443, allow: ['1'] },
        },
      })
    );
    await expect(loadChannelConfig('whatsapp', file, {})).rejects.toThrow(/No token/);
  });
});
