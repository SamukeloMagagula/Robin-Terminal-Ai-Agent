import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { startGateway } from '../../src/gateway/start';
import { GatewayClient } from '../../src/gateway/client';
import { readGatewayInfo } from '../../src/gateway/discovery';
import { PROTOCOL_VERSION } from '../../src/gateway/protocol';

/** A sessions directory of its own, so the suite never reads the real one. */
function throwawaySessions(): string {
  return path.join(os.tmpdir(), `robin-sessions-${Date.now()}-${Math.random()}`);
}

function throwawayInfo(): string {
  return path.join(os.tmpdir(), `robin-gw-info-${Date.now()}-${Math.random()}.json`);
}

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe('startGateway', () => {
  it('listens, and records where it is listening', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {}, sessionsDir: throwawaySessions() });
    stop = gateway.stop;

    const info = await readGatewayInfo(infoPath);

    expect(info?.port).toBe(gateway.port);
    expect(info?.pid).toBe(process.pid);
    expect(info?.token).toBe(gateway.token);
    expect(info?.protocol).toBe(PROTOCOL_VERSION);
  });

  it('mints a token nobody could guess', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {}, sessionsDir: throwawaySessions() });
    stop = gateway.stop;

    // Anything that can open this socket can run commands as this user.
    expect(gateway.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serves a client end to end', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {}, sessionsDir: throwawaySessions() });
    stop = gateway.stop;

    const client = await GatewayClient.connect({
      port: gateway.port,
      token: gateway.token,
      kind: 'terminal',
      canApprove: true,
      cwd: '.',
    });

    expect(client.sessions).toEqual([]);
    await client.close();
  });

  it('removes its info file on stop, so nothing chases a dead daemon', async () => {
    const infoPath = throwawayInfo();
    const gateway = await startGateway({ port: 0, infoPath, log: () => {}, sessionsDir: throwawaySessions() });
    await gateway.stop();
    stop = undefined;

    expect(await readGatewayInfo(infoPath)).toBeUndefined();
  });

  it('refuses to start when the port is already taken', async () => {
    const first = await startGateway({ port: 0, infoPath: throwawayInfo(), log: () => {} });
    stop = first.stop;

    // The loser of an auto-start race must fail loudly rather than sit there
    // having bound nothing.
    await expect(
      startGateway({ port: first.port, infoPath: throwawayInfo(), log: () => {}, sessionsDir: throwawaySessions() })
    ).rejects.toThrow(/EADDRINUSE|address already in use/i);
  });
});
