/**
 * Sending mail. Deliberately one-way.
 *
 * Email is not a ChannelTransport and never will be here: there is no
 * `receive`, because reading an inbox would mean deciding who is allowed to
 * drive Robin from a `From` header, and a `From` header is whatever the sender
 * typed. Every other channel's allowlist checks an identity the platform
 * authenticated — a Telegram user id, a Slack member id — and swapping that
 * for a forgeable string on a surface that can trigger tool calls would be a
 * real downgrade dressed up as a feature.
 *
 * So Robin can mail you. You cannot mail Robin.
 */

import { promises as fs } from 'node:fs';
import { UserFacingError } from '../startup/bootstrap.js';
import { defaultChannelConfigPath } from './config.js';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** The From header. Falls back to `user` when not given separately. */
  from: string;
}

/** How a job names email as its destination: `email:you@example.com`. */
export const EMAIL_TARGET = 'email';

/** The environment variable holding the SMTP password, preferred over the file. */
export const PASSWORD_ENV_VAR = 'SMTP_PASSWORD';

export const EXAMPLE_EMAIL_CONFIG = `{
  "email": {
    "host": "smtp.gmail.com",
    "port": 587,
    "user": "you@gmail.com",
    "from": "Robin <you@gmail.com>"
  }
}`;

/**
 * Deliberately strict rather than RFC-complete.
 *
 * The addresses this sees are typed on a command line by the person who wants
 * the mail, so refusing an odd-but-legal address costs them a moment, while
 * accepting a typo means a report that silently goes nowhere.
 */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  filePath: string
): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new UserFacingError(
      `The "email" section of ${filePath} needs a "${key}".\n\n${EXAMPLE_EMAIL_CONFIG}`
    );
  }
  return value.trim();
}

export async function loadEmailConfig(
  filePath: string = defaultChannelConfigPath(),
  env: NodeJS.ProcessEnv = process.env
): Promise<EmailConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    throw new UserFacingError(
      `No channel config at ${filePath}, so there is nowhere to send mail from. Create it with:\n\n${EXAMPLE_EMAIL_CONFIG}`
    );
  }

  let parsed: { email?: unknown };
  try {
    parsed = JSON.parse(raw) as { email?: unknown };
  } catch (err) {
    throw new UserFacingError(
      `${filePath} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const section = parsed.email;
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new UserFacingError(
      `No "email" section in ${filePath}. Add one:\n\n${EXAMPLE_EMAIL_CONFIG}`
    );
  }

  const record = section as Record<string, unknown>;
  const host = requireString(record, 'host', filePath);
  const user = requireString(record, 'user', filePath);

  const port = typeof record.port === 'number' ? record.port : 587;
  // 465 is implicit TLS by long convention, 587 is STARTTLS. Guessing from the
  // port is what every mail client does, and an explicit flag still wins.
  const secure = typeof record.secure === 'boolean' ? record.secure : port === 465;

  const password =
    env[PASSWORD_ENV_VAR]?.trim() ||
    (typeof record.password === 'string' ? record.password.trim() : '');
  if (!password) {
    throw new UserFacingError(
      `No SMTP password. Set ${PASSWORD_ENV_VAR}, or add a "password" to the "email" section of ${filePath}.\n` +
        'The environment variable is the better habit — channels.json travels with your dotfiles.'
    );
  }

  const from = typeof record.from === 'string' && record.from.trim() ? record.from.trim() : user;

  return { host, port, secure, user, password, from };
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** Plain text only. HTML from a terminal agent would be pretending. */
export function buildMessage(
  config: EmailConfig,
  to: string,
  subject: string,
  body: string
): MailMessage {
  return { from: config.from, to, subject, text: body };
}

/** The one thing nodemailer is asked for, so tests need no socket. */
export interface MailSender {
  sendMail(message: MailMessage): Promise<unknown>;
}

export async function sendEmail(
  config: EmailConfig,
  to: string,
  subject: string,
  body: string,
  sender: MailSender
): Promise<void> {
  // Checked before connecting: a rejected address should cost nothing.
  if (!isEmailAddress(to)) {
    throw new UserFacingError(`"${to}" is not an email address.`);
  }
  await sender.sendMail(buildMessage(config, to, subject, body));
}

/** Builds the real sender. Kept apart so nothing else imports nodemailer. */
export async function createSender(config: EmailConfig): Promise<MailSender> {
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
  });
  return { sendMail: (message) => transport.sendMail(message) };
}
