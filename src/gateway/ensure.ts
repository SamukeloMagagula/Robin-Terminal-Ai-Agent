import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultGatewayInfoPath, readLiveGatewayInfo, type GatewayInfo } from './discovery.js';

const WAIT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

/** Launches `robin gateway start` detached, so it outlives this process. */
export async function spawnDetached(): Promise<void> {
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'gateway', 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  // Without this the parent will not exit while the child lives.
  child.unref();
}

export interface EnsureGatewayOptions {
  infoPath?: string;
  spawn?: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Returns a gateway to talk to, starting one if there is none.
 *
 * Two `robin chat` invocations can race here and both decide to spawn. That is
 * fine and needs no lock: the loser's daemon fails to bind, exits, and the poll
 * below picks up the winner's file. Polling for the file rather than
 * coordinating is what makes the race harmless.
 */
export async function ensureGateway(
  options: EnsureGatewayOptions = {}
): Promise<GatewayInfo> {
  const infoPath = options.infoPath ?? defaultGatewayInfoPath();

  const existing = await readLiveGatewayInfo(infoPath);
  if (existing) return existing;

  await (options.spawn ?? spawnDetached)();

  const deadline = Date.now() + (options.timeoutMs ?? WAIT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const info = await readLiveGatewayInfo(infoPath);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  throw new Error(
    'The Robin gateway did not come up. Run `robin gateway start` in another terminal ' +
      'to see why, or check ~/.robin/gateway.log.'
  );
}
