import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  loadEmailConfig,
  isEmailAddress,
  buildMessage,
  sendEmail,
  type EmailConfig,
} from '../../src/channels/email';

async function configFile(contents: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-email-'));
  const file = path.join(dir, 'channels.json');
  await fs.writeFile(file, JSON.stringify(contents), 'utf-8');
  return file;
}

const complete = {
  email: {
    host: 'smtp.example.com',
    port: 587,
    user: 'robin@example.com',
    from: 'Robin <robin@example.com>',
  },
};

const config: EmailConfig = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: 'robin@example.com',
  password: 'hunter2',
  from: 'Robin <robin@example.com>',
};

describe('isEmailAddress', () => {
  it.each(['a@b.co', 'first.last@sub.example.com', 'x+tag@example.org'])('accepts %j', (value) => {
    expect(isEmailAddress(value)).toBe(true);
  });

  it.each(['', 'nobody', '@example.com', 'a@', 'a b@example.com', 'a@b', 'a@@b.co'])(
    'refuses %j',
    (value) => {
      expect(isEmailAddress(value)).toBe(false);
    }
  );
});

describe('loadEmailConfig', () => {
  it('reads a complete configuration, with the password from the environment', async () => {
    const file = await configFile(complete);
    const loaded = await loadEmailConfig(file, { SMTP_PASSWORD: 'hunter2' });
    expect(loaded).toEqual(config);
  });

  it('lets the environment override a password kept in the file', async () => {
    const file = await configFile({ email: { ...complete.email, password: 'from-file' } });
    const loaded = await loadEmailConfig(file, { SMTP_PASSWORD: 'from-env' });
    expect(loaded.password).toBe('from-env');
  });

  it('accepts a password from the file when the environment has none', async () => {
    const file = await configFile({ email: { ...complete.email, password: 'from-file' } });
    expect((await loadEmailConfig(file, {})).password).toBe('from-file');
  });

  it('treats port 465 as implicitly secure, which is what it means', async () => {
    const file = await configFile({ email: { ...complete.email, port: 465 } });
    expect((await loadEmailConfig(file, { SMTP_PASSWORD: 'x' })).secure).toBe(true);
  });

  it('honours an explicit secure flag over the port convention', async () => {
    const file = await configFile({ email: { ...complete.email, port: 465, secure: false } });
    expect((await loadEmailConfig(file, { SMTP_PASSWORD: 'x' })).secure).toBe(false);
  });

  it('falls back to the user as the from address', async () => {
    const file = await configFile({ email: { ...complete.email, from: undefined } });
    expect((await loadEmailConfig(file, { SMTP_PASSWORD: 'x' })).from).toBe('robin@example.com');
  });

  it('says where to put the settings when the file has no email section', async () => {
    const file = await configFile({ channels: {} });
    await expect(loadEmailConfig(file, {})).rejects.toThrow(/email/i);
  });

  it('names the missing setting rather than failing later inside the mailer', async () => {
    const file = await configFile({ email: { port: 587, user: 'x@y.co' } });
    await expect(loadEmailConfig(file, { SMTP_PASSWORD: 'x' })).rejects.toThrow(/host/i);
  });

  it('names SMTP_PASSWORD when no password can be found anywhere', async () => {
    const file = await configFile(complete);
    await expect(loadEmailConfig(file, {})).rejects.toThrow(/SMTP_PASSWORD/);
  });

  it('reports a missing file with the path, rather than a bare error', async () => {
    await expect(loadEmailConfig('/nowhere/channels.json', {})).rejects.toThrow(
      /nowhere|channels\.json/
    );
  });
});

describe('buildMessage', () => {
  it('sends from the configured address to the recipient', () => {
    const message = buildMessage(config, 'you@example.com', 'standup', 'the answer');
    expect(message).toMatchObject({
      from: 'Robin <robin@example.com>',
      to: 'you@example.com',
      subject: 'standup',
    });
  });

  it('sends plain text, not HTML', () => {
    const message = buildMessage(config, 'you@example.com', 'standup', 'the answer');
    expect(message.text).toBe('the answer');
    expect(message).not.toHaveProperty('html');
  });
});

describe('sendEmail', () => {
  it('hands the built message to the mailer', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await sendEmail(config, 'you@example.com', 'standup', 'the answer', { sendMail });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'you@example.com', subject: 'standup' })
    );
  });

  it('refuses an address that is not one, before opening any connection', async () => {
    const sendMail = vi.fn();
    await expect(
      sendEmail(config, 'not-an-address', 'standup', 'body', { sendMail })
    ).rejects.toThrow(/not-an-address/);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
