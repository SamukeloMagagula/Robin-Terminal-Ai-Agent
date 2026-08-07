import { randomBytes } from 'node:crypto';

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** Display-only id for the current chat session, e.g. `20260807_1432_a3f1c9`. */
export function newSessionId(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}`;
  return `${date}_${time}_${randomBytes(3).toString('hex')}`;
}
