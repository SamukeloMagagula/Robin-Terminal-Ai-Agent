/**
 * Preflight checks — the questions "why won't this run on my machine?" always
 * turns out to be.
 *
 * Every check answers one question, reports its own remedy, and never throws:
 * a check that blows up while diagnosing a broken install is worse than no
 * check at all. Checks are pure enough to test by injecting their probes.
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  defaultGatewayInfoPath,
  isProcessAlive,
  readGatewayInfo,
} from '../gateway/discovery.js';
import { PROTOCOL_VERSION } from '../gateway/protocol.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  status: CheckStatus;
  /** What was actually observed — always populated, including on success. */
  detail: string;
  /** What the user should do about it. Omitted when there is nothing to do. */
  remedy?: string;
}

export interface Check {
  id: string;
  label: string;
  /**
   * True when a failure makes Robin genuinely unusable rather than degraded.
   * Only these abort startup; the rest are reported and stepped over.
   */
  critical: boolean;
  run: () => Promise<CheckResult>;
}

/** The oldest Node that Robin is tested against, matching package.json engines. */
export const MIN_NODE_MAJOR = 18;

export function checkNodeVersion(version: string = process.version): CheckResult {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) {
    return {
      status: 'warn',
      detail: `unrecognised version string "${version}"`,
      remedy: `Robin needs Node ${MIN_NODE_MAJOR} or newer.`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      status: 'fail',
      detail: `Node ${version} is too old`,
      remedy: `Install Node ${MIN_NODE_MAJOR} or newer, then run \`npm ci && npm run build\` again.`,
    };
  }
  return { status: 'ok', detail: `Node ${version}` };
}

/**
 * better-sqlite3 is a native addon, compiled against one Node ABI. Upgrading
 * Node without rebuilding leaves a binary that loads on the old runtime and
 * throws NODE_MODULE_VERSION on the new one — the single most common reason a
 * working checkout stops running after an unrelated Node upgrade. Memory,
 * recall and workflow all sit on it, so a broken addon is fatal.
 */
export function checkNativeModules(
  load: () => unknown = () => createRequire(import.meta.url)('better-sqlite3')
): CheckResult {
  try {
    load();
    return { status: 'ok', detail: `native modules load (ABI ${process.versions.modules})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const abiMismatch = /NODE_MODULE_VERSION|was compiled against a different/i.test(message);
    return {
      status: 'fail',
      detail: abiMismatch
        ? `better-sqlite3 was built for a different Node version (this one is ABI ${process.versions.modules})`
        : `better-sqlite3 failed to load — ${message.split('\n')[0]}`,
      remedy: abiMismatch
        ? 'Run `npm rebuild better-sqlite3`, or `npm ci` to reinstall against this Node.'
        : 'Run `npm ci` to reinstall dependencies.',
    };
  }
}

/**
 * Everything Robin persists — credentials, transcripts, memory, trust grants —
 * lives under ~/.robin. A home directory that cannot be written to (a roaming
 * profile that failed to mount, a locked-down corporate image) turns every one
 * of those into a separate confusing failure later, so it is checked once here.
 */
export async function checkConfigDir(
  dir: string = path.join(os.homedir(), '.robin')
): Promise<CheckResult> {
  const probe = path.join(dir, '.write-probe');
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(probe, '', { mode: 0o600 });
    await fs.rm(probe, { force: true });
    return { status: 'ok', detail: dir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      detail: `cannot write to ${dir} — ${message}`,
      remedy: 'Check the directory’s permissions, or set HOME/USERPROFILE to a writable location.',
    };
  }
}

/**
 * A malformed mcp.json is already handled by failing closed to zero servers,
 * which is safe but silent — the user sees their tools quietly missing with no
 * explanation. Here that becomes a warning that names the file.
 */
export async function checkMcpConfig(filePath: string): Promise<CheckResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { status: 'ok', detail: 'no mcp.json (optional)' };
  }
  try {
    const parsed = JSON.parse(raw) as { servers?: Record<string, unknown> };
    const count = Object.keys(parsed?.servers ?? {}).length;
    return { status: 'ok', detail: `${count} server(s) declared` };
  } catch (err) {
    return {
      status: 'warn',
      detail: `${filePath} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
      remedy: 'Fix the syntax, or MCP servers will be silently skipped.',
    };
  }
}

/**
 * Non-fatal by design: the banner and the model picker both degrade to plain
 * text, and Robin is still driven from a pipe by the workflow runner. This
 * exists so a garbled display has an explanation rather than looking like a bug.
 */
export function checkTerminal(
  isTty: boolean = Boolean(process.stdout.isTTY),
  columns: number | undefined = process.stdout.columns
): CheckResult {
  if (!isTty) {
    return {
      status: 'warn',
      detail: 'not a TTY — interactive prompts are unavailable',
      remedy: 'Run Robin directly in a terminal rather than through a pipe.',
    };
  }
  if (columns !== undefined && columns < 60) {
    return {
      status: 'warn',
      detail: `terminal is ${columns} columns wide`,
      remedy: 'Widen the window to at least 60 columns for the HUD to lay out correctly.',
    };
  }
  return { status: 'ok', detail: `interactive, ${columns ?? 'unknown'} columns` };
}

/**
 * At least one provider must be usable, or the first thing the user types will
 * fail. Reported as a whole rather than per provider — `robin status` already
 * breaks it down, and repeating that here buries the one line that matters.
 */
export async function checkProviders(
  providers: { id: string; name: string; isAuthenticated: () => Promise<boolean> }[]
): Promise<CheckResult> {
  const usable: string[] = [];
  for (const provider of providers) {
    try {
      if (await provider.isAuthenticated()) usable.push(provider.name);
    } catch {
      // A provider that throws while being asked is simply not usable. It is
      // not this check's job to explain why — `robin status` does that.
    }
  }
  if (usable.length === 0) {
    return {
      status: 'fail',
      detail: 'no provider is logged in',
      remedy: `Run \`robin login <provider>\` — one of: ${providers.map((p) => p.id).join(', ')}.`,
    };
  }
  return { status: 'ok', detail: `${usable.length} available (${usable.join(', ')})` };
}

export interface PreflightOptions {
  providers: { id: string; name: string; isAuthenticated: () => Promise<boolean> }[];
  configDir?: string;
  mcpConfigPath?: string;
}

/** The full check list, in the order they are reported. */
/**
 * Reports on the gateway, without ever calling its absence a problem.
 *
 * Not running is the ordinary state: `robin chat` starts one on demand. What is
 * worth flagging is a record pointing at a process that is gone, and a daemon
 * speaking a protocol this build does not — the second one is the failure mode
 * auto-start creates, because a daemon outlives the build that started it and
 * the resulting errors look like anything but version skew.
 */
export async function checkGateway(infoPath?: string): Promise<CheckResult> {
  const info = await readGatewayInfo(infoPath ?? defaultGatewayInfoPath());
  if (!info) {
    return { status: 'ok', detail: 'not running (started on demand by `robin chat`)' };
  }
  if (!isProcessAlive(info.pid)) {
    return {
      status: 'warn',
      detail: `a record points at pid ${info.pid}, which is gone`,
      remedy: 'Run `robin gateway stop` to clear it. Nothing is actually running.',
    };
  }
  if (info.protocol !== PROTOCOL_VERSION) {
    return {
      status: 'warn',
      detail: `running on port ${info.port}, but speaking protocol ${info.protocol} — this build speaks ${PROTOCOL_VERSION}`,
      remedy: 'Run `robin gateway stop`. That daemon predates your last build.',
    };
  }
  return { status: 'ok', detail: `running on 127.0.0.1:${info.port} (pid ${info.pid})` };
}

export function buildChecks(options: PreflightOptions): Check[] {
  const configDir = options.configDir ?? path.join(os.homedir(), '.robin');
  const mcpConfigPath = options.mcpConfigPath ?? path.join(configDir, 'mcp.json');

  return [
    {
      id: 'runtime',
      label: 'Node runtime',
      critical: true,
      run: async () => checkNodeVersion(),
    },
    {
      id: 'native',
      label: 'Native modules',
      critical: true,
      run: async () => checkNativeModules(),
    },
    {
      id: 'config-dir',
      label: 'Config directory',
      critical: true,
      run: () => checkConfigDir(configDir),
    },
    {
      id: 'terminal',
      label: 'Terminal',
      critical: false,
      run: async () => checkTerminal(),
    },
    {
      id: 'gateway',
      label: 'Gateway',
      critical: false,
      run: () => checkGateway(path.join(configDir, 'gateway.json')),
    },
    {
      id: 'mcp',
      label: 'MCP config',
      critical: false,
      run: () => checkMcpConfig(mcpConfigPath),
    },
    {
      id: 'providers',
      label: 'Providers',
      critical: false,
      run: () => checkProviders(options.providers),
    },
  ];
}

export interface CompletedCheck extends CheckResult {
  id: string;
  label: string;
  critical: boolean;
}

/**
 * Runs every check, converting a check that throws into a reported failure
 * rather than letting it escape — diagnosis must not itself be a crash site.
 */
export async function runChecks(checks: Check[]): Promise<CompletedCheck[]> {
  const results: CompletedCheck[] = [];
  for (const check of checks) {
    let result: CheckResult;
    try {
      result = await check.run();
    } catch (err) {
      result = {
        status: 'fail',
        detail: `check itself failed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    results.push({ ...result, id: check.id, label: check.label, critical: check.critical });
  }
  return results;
}

/** Critical failures only — the set that must abort startup. */
export function blockingFailures(results: CompletedCheck[]): CompletedCheck[] {
  return results.filter((r) => r.critical && r.status === 'fail');
}
