import { describe, it, expect } from 'vitest';
import { CHANNELS } from '../../src/channels/registry';

describe('CHANNELS.whatsapp.build', () => {
  const base = {
    token: 't',
    phoneNumberId: 'id',
    verifyToken: 'v',
    appSecret: 's',
  };

  it('accepts a webhookPort of 0 rather than treating it as missing', () => {
    expect(() => CHANNELS.whatsapp.build?.({ ...base, webhookPort: 0 })).not.toThrow();
  });

  it('refuses when webhookPort is genuinely absent', () => {
    expect(() => CHANNELS.whatsapp.build?.({ ...base })).toThrow(/webhookPort/);
  });

  it('refuses when phoneNumberId is missing', () => {
    expect(() => CHANNELS.whatsapp.build?.({ ...base, phoneNumberId: undefined, webhookPort: 8443 })).toThrow();
  });
});
