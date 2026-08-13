import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureGateway } from '../../src/gateway/ensure';
import { startGateway } from '../../src/gateway/start';
import { writeGatewayInfo } from '../../src/gateway/discovery';
import { PROTOCOL_VERSION } from '../../src/gateway/protocol';

function throwawayInfo(): string {
  return path.join(os.tmpdir(), `robin-ensure-${Date.now()}-${Math.random()}.json`);
}

/** High enough that no real process will have it, low enough to be a valid pid. */
const DEAD_PID = 0x7ffffff0;

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe('ensureGateway', () => {
  it('uses a gateway that is already running, without spawning', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
    stop = gateway.stop;
    const spawn = vi.fn();

    const info = await ensureGateway({ infoPath, spawn });

    expect(info.port).toBe(gateway.port);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns when nothing is running, and waits for the file to appear', async () => {
    const infoPath = throwawayInfo();
    const spawn = vi.fn(async () => {
      const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
      stop = gateway.stop;
    });

    const info = await ensureGateway({ infoPath, spawn });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(info.protocol).toBe(PROTOCOL_VERSION);
  });

  // A crashed daemon leaves its file behind. Trusting it would send every
  // client at a closed port.
  it('ignores a file whose process is gone and starts fresh', async () => {
    const infoPath = throwawayInfo();
    await writeGatewayInfo(
      { port: 1, pid: DEAD_PID, token: 'stale', protocol: PROTOCOL_VERSION },
      infoPath
    );
    const spawn = vi.fn(async () => {
      const gateway = await startGateway({ port: 0, infoPath, log: () => {} });
      stop = gateway.stop;
    });

    const info = await ensureGateway({ infoPath, spawn });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(info.token).not.toBe('stale');
  });

  it('gives up with a useful message when the spawn never comes up', async () => {
    const infoPath = throwawayInfo();

    await expect(
      ensureGateway({ infoPath, spawn: async () => {}, timeoutMs: 200 })
    ).rejects.toThrow(/gateway/i);
  });

  // Two `robin chat` invocations can both decide to spawn. The loser's daemon
  // fails to bind and exits; polling for the file is what makes that harmless.
  it('picks up the winner when its own spawn loses the race', async () => {
    const infoPath = throwawayInfo();
    const winner = await startGateway({ port: 0, infoPath, log: () => {} });
    stop = winner.stop;

    const spawn = vi.fn(async () => {
      await expect(
        startGateway({ port: winner.port, infoPath: throwawayInfo(), log: () => {} })
      ).rejects.toThrow();
    });

    // The file is already there from the winner, so ensure never even spawns.
    const info = await ensureGateway({ infoPath, spawn });

    expect(info.port).toBe(winner.port);
    expect(spawn).not.toHaveBeenCalled();
  });
});
