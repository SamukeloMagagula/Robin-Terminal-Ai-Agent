import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PROTOCOL_VERSION } from './protocol.js';
import { robinHome } from '../profile.js';

/** 18789 is OpenClaw's. A machine may reasonably run both. */
export const DEFAULT_PORT = 18790;

export interface GatewayInfo {
  port: number;
  pid: number;
  token: string;
  /** The protocol this daemon speaks — lets a client spot skew before connecting. */
  protocol: number;
  /**
   * The compiled output it is running. Absent from files written before this
   * existed, and from a build whose directory could not be read.
   */
  build?: string;
}

export function defaultGatewayInfoPath(): string {
  return path.join(robinHome(), 'gateway.json');
}

export function defaultPort(): number {
  const configured = Number(process.env.ROBIN_GATEWAY_PORT);
  return Number.isInteger(configured) && configured > 0 && configured < 65536
    ? configured
    : DEFAULT_PORT;
}

function isGatewayInfo(value: unknown): value is GatewayInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.port === 'number' &&
    typeof info.pid === 'number' &&
    typeof info.token === 'string' &&
    typeof info.protocol === 'number'
  );
}

export async function readGatewayInfo(
  filePath: string = defaultGatewayInfoPath()
): Promise<GatewayInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return isGatewayInfo(parsed) ? parsed : undefined;
  } catch {
    // Missing and corrupt mean the same thing to every caller: there is no
    // gateway to talk to, so start a fresh one.
    return undefined;
  }
}

/**
 * Writes the file the whole discovery mechanism rests on.
 *
 * 0600 is not decoration. Anything that can read this token can open the
 * socket, and anything that can open the socket can run commands as this user.
 */
export async function writeGatewayInfo(
  info: GatewayInfo,
  filePath: string = defaultGatewayInfoPath()
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(info, null, 2), { mode: 0o600 });
  // writeFile's mode applies only when it creates the file, so one that already
  // exists with looser permissions would silently keep them.
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

export async function removeGatewayInfo(
  filePath: string = defaultGatewayInfoPath()
): Promise<void> {
  await fs.rm(filePath, { force: true });
}

/** Signal 0 tests for existence without delivering anything. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The info file, but only when the process it names is still running.
 *
 * A crashed daemon leaves its file behind. Treating that as "a gateway is up"
 * would make every client hang on a connect to a closed port.
 */
export async function readLiveGatewayInfo(
  filePath: string = defaultGatewayInfoPath()
): Promise<GatewayInfo | undefined> {
  const info = await readGatewayInfo(filePath);
  if (!info) return undefined;
  return isProcessAlive(info.pid) ? info : undefined;
}

export { PROTOCOL_VERSION };
