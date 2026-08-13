import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readGatewayInfo,
  writeGatewayInfo,
  removeGatewayInfo,
  readLiveGatewayInfo,
  isProcessAlive,
  defaultPort,
  type GatewayInfo,
} from '../../src/gateway/discovery';
import { PROTOCOL_VERSION } from '../../src/gateway/protocol';

function throwawayPath(): string {
  return path.join(os.tmpdir(), `robin-gateway-${Date.now()}-${Math.random()}.json`);
}

/** High enough that no real process will have it, low enough to be a valid pid. */
const DEAD_PID = 0x7ffffff0;

const info: GatewayInfo = {
  port: 18790,
  pid: process.pid,
  token: 'a-token',
  protocol: PROTOCOL_VERSION,
};

describe('gateway info file', () => {
  it('round-trips', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(info, file);
    expect(await readGatewayInfo(file)).toEqual(info);
  });

  it('reads as absent when the file does not exist', async () => {
    expect(await readGatewayInfo(throwawayPath())).toBeUndefined();
  });

  // Fails closed, like TrustStore: a corrupt file must mean "start fresh",
  // never "crash on startup".
  it.each(['not json', '{}', '[]', '{"port":"nope","pid":1,"token":"t","protocol":1}'])(
    'reads as absent when the file is %s',
    async (contents) => {
      const file = throwawayPath();
      await fs.writeFile(file, contents, 'utf-8');
      expect(await readGatewayInfo(file)).toBeUndefined();
    }
  );

  it('removes the file, and does not mind if it is already gone', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(info, file);
    await removeGatewayInfo(file);
    expect(await readGatewayInfo(file)).toBeUndefined();
    await expect(removeGatewayInfo(file)).resolves.toBeUndefined();
  });
});

describe('isProcessAlive', () => {
  it('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for a pid that cannot exist', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});

describe('readLiveGatewayInfo', () => {
  it('returns the info when the recorded process is alive', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(info, file);
    expect(await readLiveGatewayInfo(file)).toEqual(info);
  });

  // A crashed daemon leaves its file behind. Trusting it would send every
  // client at a closed port.
  it('returns nothing when the recorded process is gone', async () => {
    const file = throwawayPath();
    await writeGatewayInfo({ ...info, pid: DEAD_PID }, file);
    expect(await readLiveGatewayInfo(file)).toBeUndefined();
  });
});

describe('defaultPort', () => {
  const original = process.env.ROBIN_GATEWAY_PORT;

  afterEach(() => {
    if (original === undefined) delete process.env.ROBIN_GATEWAY_PORT;
    else process.env.ROBIN_GATEWAY_PORT = original;
  });

  it('is 18790 by default', () => {
    delete process.env.ROBIN_GATEWAY_PORT;
    expect(defaultPort()).toBe(18790);
  });

  it('honours ROBIN_GATEWAY_PORT', () => {
    process.env.ROBIN_GATEWAY_PORT = '20000';
    expect(defaultPort()).toBe(20000);
  });

  it.each(['banana', '0', '-1', '70000'])(
    'ignores a nonsense ROBIN_GATEWAY_PORT (%s) rather than binding somewhere random',
    (value) => {
      process.env.ROBIN_GATEWAY_PORT = value;
      expect(defaultPort()).toBe(18790);
    }
  );
});
