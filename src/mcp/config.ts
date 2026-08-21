import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { robinHome } from '../profile.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export function defaultMcpConfigPath(): string {
  return path.join(robinHome(), 'mcp.json');
}

/**
 * Server names become the first half of a `server__tool` identifier, so a name
 * containing the separator would make the split ambiguous — and an ambiguous
 * split is how a server ends up shadowing a built-in tool. Path characters are
 * rejected for the same reason `isValidConversationName` rejects them.
 */
function isValidServerName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.includes('__');
}

/**
 * Servers declared in ~/.robin/mcp.json.
 *
 * Fails closed: an unreadable or malformed file yields zero servers rather
 * than throwing, and one bad entry is skipped rather than discarding the rest.
 * A wrong config must leave Robin usable, just without MCP.
 */
export async function loadMcpConfig(
  filePath: string = defaultMcpConfigPath()
): Promise<McpServerConfig[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  // Both spellings. Robin documents `servers`, but Claude Desktop, Cursor and
  // most other hosts key this `mcpServers` — and Robin's own README invites you
  // to paste server blocks straight from their docs, which silently did nothing
  // while only one spelling was read.
  const file = parsed as { servers?: unknown; mcpServers?: unknown };
  const entries: Record<string, unknown> = {};
  for (const candidate of [file.mcpServers, file.servers]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    // `servers` is read last, so Robin's documented spelling wins a collision.
    Object.assign(entries, candidate as Record<string, unknown>);
  }
  if (Object.keys(entries).length === 0) return [];

  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    if (!isValidServerName(name)) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== 'string' || !entry.command) continue;

    out.push({
      name,
      command: entry.command,
      args: Array.isArray(entry.args)
        ? entry.args.filter((a): a is string => typeof a === 'string')
        : undefined,
      env: isStringMap(entry.env) ? entry.env : undefined,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    });
  }
  return out;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

/** Reads the raw parsed file, or {} for a missing one. Throws on unparseable JSON. */
async function readRawConfig(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `${filePath} already exists but is not valid JSON. Fix or remove it before adding a server.`
    );
  }
}

async function writeRawConfig(filePath: string, parsed: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Writes one server into mcp.json, under `servers` — Robin's documented,
 * collision-winning spelling — even when the file currently only has an
 * `mcpServers` block; loadMcpConfig already merges both, so the addition is
 * usable either way. Unlike the read path, a write must never silently
 * discard something that might still be recoverable by hand: an existing
 * file that fails to parse throws rather than being overwritten from empty.
 */
export async function addMcpServer(
  entry: McpServerConfig,
  filePath: string = defaultMcpConfigPath()
): Promise<void> {
  const parsed = await readRawConfig(filePath);
  const servers =
    parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)
      ? { ...(parsed.servers as Record<string, unknown>) }
      : {};
  servers[entry.name] = {
    command: entry.command,
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.env ? { env: entry.env } : {}),
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
  };
  await writeRawConfig(filePath, { ...parsed, servers });
}

/**
 * Deletes a named entry from whichever of servers/mcpServers it is under.
 * Leaves the trust store alone — a stale trust record for a server no
 * longer in mcp.json is inert, the same "nothing to clean up" reasoning
 * already applied to a declined skill install never being recorded.
 */
export async function removeMcpServer(
  name: string,
  filePath: string = defaultMcpConfigPath()
): Promise<boolean> {
  let parsed: Record<string, unknown>;
  try {
    parsed = await readRawConfig(filePath);
  } catch {
    return false;
  }

  let removed = false;
  for (const key of ['servers', 'mcpServers'] as const) {
    const block = parsed[key];
    if (block && typeof block === 'object' && !Array.isArray(block) && name in block) {
      const next = { ...(block as Record<string, unknown>) };
      delete next[name];
      parsed = { ...parsed, [key]: next };
      removed = true;
    }
  }
  if (!removed) return false;

  await writeRawConfig(filePath, parsed);
  return true;
}

/**
 * The exact command this entry will run — what the user is asked to approve.
 *
 * `env` contributes its **keys only**, never its values: the fingerprint is
 * written to disk, and a rotated token must not re-prompt. A new key still
 * changes the fingerprint, because that changes what the server can reach.
 */
export function serverFingerprint(name: string, config: McpServerConfig): string {
  return JSON.stringify({
    name,
    command: config.command,
    args: config.args ?? [],
    env: Object.keys(config.env ?? {}).sort(),
    cwd: config.cwd ?? null,
  });
}
