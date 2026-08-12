import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  checkNodeVersion,
  checkNativeModules,
  checkConfigDir,
  checkMcpConfig,
  checkTerminal,
  checkProviders,
  runChecks,
  blockingFailures,
  buildChecks,
  MIN_NODE_MAJOR,
  type Check,
} from '../../src/startup/preflight';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'robin-preflight-'));
}

function provider(id: string, authed: boolean | (() => Promise<boolean>)) {
  return {
    id,
    name: id.toUpperCase(),
    isAuthenticated: typeof authed === 'function' ? authed : async () => authed,
  };
}

describe('checkNodeVersion', () => {
  it('passes on a supported major', () => {
    expect(checkNodeVersion(`v${MIN_NODE_MAJOR}.0.0`).status).toBe('ok');
    expect(checkNodeVersion('v24.18.0').status).toBe('ok');
  });

  it('fails on a major below the minimum, and says how to fix it', () => {
    const result = checkNodeVersion(`v${MIN_NODE_MAJOR - 1}.0.0`);
    expect(result.status).toBe('fail');
    expect(result.remedy).toContain(String(MIN_NODE_MAJOR));
  });

  it('warns rather than failing on an unparseable version string', () => {
    expect(checkNodeVersion('not-a-version').status).toBe('warn');
  });
});

describe('checkNativeModules', () => {
  it('passes when the addon loads', () => {
    expect(checkNativeModules(() => ({})).status).toBe('ok');
  });

  it('really loads better-sqlite3 by default', () => {
    expect(checkNativeModules().status).toBe('ok');
  });

  it('recognises an ABI mismatch and recommends a rebuild', () => {
    const result = checkNativeModules(() => {
      throw new Error('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.');
    });
    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('npm rebuild better-sqlite3');
  });

  it('reports an unrelated load failure without claiming it is an ABI problem', () => {
    const result = checkNativeModules(() => {
      throw new Error('Cannot find module');
    });
    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('npm ci');
  });
});

describe('checkConfigDir', () => {
  it('passes for a writable directory and leaves no probe file behind', async () => {
    const dir = path.join(await tempDir(), 'nested', '.robin');
    expect((await checkConfigDir(dir)).status).toBe('ok');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('fails, without throwing, when the directory cannot be created', async () => {
    const result = await checkConfigDir('\0invalid');
    expect(result.status).toBe('fail');
    expect(result.remedy).toBeDefined();
  });
});

describe('checkMcpConfig', () => {
  it('treats an absent file as fine, because MCP is optional', async () => {
    const result = await checkMcpConfig(path.join(await tempDir(), 'mcp.json'));
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('optional');
  });

  it('counts the declared servers', async () => {
    const file = path.join(await tempDir(), 'mcp.json');
    await fs.writeFile(file, JSON.stringify({ servers: { a: {}, b: {} } }));
    expect((await checkMcpConfig(file)).detail).toContain('2 server(s)');
  });

  it('warns on malformed JSON instead of letting servers vanish silently', async () => {
    const file = path.join(await tempDir(), 'mcp.json');
    await fs.writeFile(file, '{ not json');
    const result = await checkMcpConfig(file);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(file);
  });
});

describe('checkTerminal', () => {
  it('passes for a wide interactive terminal', () => {
    expect(checkTerminal(true, 120).status).toBe('ok');
  });

  it('warns when there is no TTY', () => {
    expect(checkTerminal(false, 120).status).toBe('warn');
  });

  it('warns when the terminal is too narrow for the HUD', () => {
    expect(checkTerminal(true, 40).status).toBe('warn');
  });
});

describe('checkProviders', () => {
  it('passes when at least one provider is authenticated', async () => {
    const result = await checkProviders([provider('a', false), provider('b', true)]);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('B');
  });

  it('fails when none are, and names the login command', async () => {
    const result = await checkProviders([provider('a', false)]);
    expect(result.status).toBe('fail');
    expect(result.remedy).toContain('robin login');
  });

  it('treats a provider that throws as merely unavailable', async () => {
    const result = await checkProviders([
      provider('boom', async () => {
        throw new Error('network down');
      }),
      provider('ok', true),
    ]);
    expect(result.status).toBe('ok');
  });
});

describe('runChecks', () => {
  const passing: Check = {
    id: 'p',
    label: 'Passing',
    critical: false,
    run: async () => ({ status: 'ok', detail: 'fine' }),
  };

  it('converts a check that throws into a reported failure', async () => {
    const exploding: Check = {
      id: 'x',
      label: 'Exploding',
      critical: true,
      run: async () => {
        throw new Error('kaboom');
      },
    };

    const results = await runChecks([passing, exploding]);

    expect(results).toHaveLength(2);
    expect(results[1].status).toBe('fail');
    expect(results[1].detail).toContain('kaboom');
  });

  it('preserves each check’s id, label and criticality', async () => {
    const [result] = await runChecks([passing]);
    expect(result).toMatchObject({ id: 'p', label: 'Passing', critical: false });
  });
});

describe('blockingFailures', () => {
  it('reports only critical failures, not warnings or non-critical ones', () => {
    const results = [
      { id: 'a', label: 'A', critical: true, status: 'fail' as const, detail: '' },
      { id: 'b', label: 'B', critical: false, status: 'fail' as const, detail: '' },
      { id: 'c', label: 'C', critical: true, status: 'warn' as const, detail: '' },
      { id: 'd', label: 'D', critical: true, status: 'ok' as const, detail: '' },
    ];
    expect(blockingFailures(results).map((r) => r.id)).toEqual(['a']);
  });
});

describe('buildChecks', () => {
  it('marks runtime, native modules and the config directory as start-blocking', () => {
    const checks = buildChecks({ providers: [] });
    const critical = checks.filter((c) => c.critical).map((c) => c.id);
    expect(critical).toEqual(['runtime', 'native', 'config-dir']);
  });

  it('does not block startup on providers or the terminal, which only degrade it', () => {
    const checks = buildChecks({ providers: [] });
    for (const id of ['providers', 'terminal', 'mcp']) {
      expect(checks.find((c) => c.id === id)?.critical).toBe(false);
    }
  });
});
