import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkGateway } from '../../src/startup/preflight';
import { writeGatewayInfo } from '../../src/gateway/discovery';
import { PROTOCOL_VERSION } from '../../src/gateway/protocol';

function throwawayPath(): string {
  return path.join(os.tmpdir(), `robin-gwcheck-${Date.now()}-${Math.random()}.json`);
}

/** High enough that no real process will have it, low enough to be a valid pid. */
const DEAD_PID = 0x7ffffff0;

describe('checkGateway', () => {
  // Not running is the normal state, not a fault: `robin chat` starts one on
  // demand. Reporting it as a failure would send people chasing a non-problem.
  it('is ok when no gateway is running', async () => {
    const result = await checkGateway(throwawayPath());
    expect(result.status).toBe('ok');
    expect(result.detail).toMatch(/not running|started on demand/i);
    expect(result.remedy).toBeUndefined();
  });

  it('is ok and names the port when one is running', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(
      { port: 18790, pid: process.pid, token: 't', protocol: PROTOCOL_VERSION },
      file
    );

    const result = await checkGateway(file);

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('18790');
  });

  it('warns about a record whose process is gone, and says what clears it', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(
      { port: 18790, pid: DEAD_PID, token: 't', protocol: PROTOCOL_VERSION },
      file
    );

    const result = await checkGateway(file);

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('robin gateway stop');
  });

  // Auto-start means a daemon outlives the build that started it. This is the
  // check that turns a baffling failure into an obvious one.
  it('warns about a daemon speaking an older protocol', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(
      { port: 18790, pid: process.pid, token: 't', protocol: PROTOCOL_VERSION + 1 },
      file
    );

    const result = await checkGateway(file);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/protocol/i);
    expect(result.remedy).toContain('robin gateway stop');
  });

  it('warns rather than throwing when the record is unreadable', async () => {
    const file = throwawayPath();
    await fs.writeFile(file, 'not json', 'utf-8');

    const result = await checkGateway(file);

    // A check that blows up while diagnosing a broken install is worse than no
    // check at all.
    expect(['ok', 'warn']).toContain(result.status);
  });
});

describe('checkGateway and stale builds', () => {
  it('warns when the daemon is running a different build', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(
      {
        port: 18790,
        pid: process.pid,
        token: 't',
        protocol: PROTOCOL_VERSION,
        build: 'notthisbuild',
      },
      file
    );

    const result = await checkGateway(file, 'thisbuild');

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/older build/i);
    expect(result.remedy).toContain('robin gateway stop');
  });

  // Files written before builds were recorded, and builds whose directory
  // cannot be read, are unknown rather than stale.
  it('says nothing when the daemon recorded no build', async () => {
    const file = throwawayPath();
    await writeGatewayInfo(
      { port: 18790, pid: process.pid, token: 't', protocol: PROTOCOL_VERSION },
      file
    );

    expect((await checkGateway(file, 'thisbuild')).status).toBe('ok');
  });
});
