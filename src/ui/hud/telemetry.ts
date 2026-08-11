import * as os from 'node:os';
import { AuthStore } from '../../auth-store.js';
import { MemoryStore } from '../../memory/store.js';
import { SkillStore } from '../../skills/store.js';
import { listProviders } from '../../providers/index.js';
import { platformName } from '../../environment-prompt.js';

export interface HudStats {
  /** Providers with stored credentials — see the note on `gatherTelemetry`. */
  providersLinked: number;
  providersTotal: number;
  /** Tools armed for this session, built-ins and contributed alike. */
  toolCount: number;
  memoryCount: number;
  skillCount: number;
  mcpServerCount: number;
  host: string;
  node: string;
}

export interface TelemetrySources {
  auth?: AuthStore;
  memory?: MemoryStore;
  skills?: SkillStore;
  toolCount: number;
  mcpServerCount: number;
}

/**
 * The real numbers behind the HUD's meters.
 *
 * **Nothing here may touch the network.** `Provider.isAuthenticated()` is a
 * local file read for the API-key providers but a live HTTP call for Ollama,
 * so counting "online" providers would make the banner wait on a socket. This
 * counts stored credentials instead — instant, and the HUD labels the row
 * LINKED, which is exactly what was counted.
 *
 * Every source is read defensively. A broken memory directory costs one row's
 * accuracy, never the banner.
 */
export async function gatherTelemetry(sources: TelemetrySources): Promise<HudStats> {
  const auth = sources.auth ?? new AuthStore();
  const memory = sources.memory ?? new MemoryStore();
  const skills = sources.skills ?? new SkillStore();
  const providers = listProviders();

  return {
    providersLinked: await countLinked(auth, providers.map((p) => p.id)),
    providersTotal: providers.length,
    toolCount: sources.toolCount,
    memoryCount: await safeCount(() => memory.list()),
    skillCount: await safeCount(() => skills.list()),
    mcpServerCount: sources.mcpServerCount,
    host: `${platformName()} ${os.release()} · ${process.arch}`,
    node: process.version,
  };
}

/**
 * Ollama is deliberately counted as linked: it needs no credentials, so
 * requiring an auth entry would permanently under-report it, and pinging it
 * would break the no-network rule.
 */
async function countLinked(auth: AuthStore, providerIds: string[]): Promise<number> {
  let linked = 0;
  for (const id of providerIds) {
    if (id === 'ollama') {
      linked++;
      continue;
    }
    try {
      const stored = await auth.get(id);
      if (stored && Object.keys(stored).length > 0) linked++;
    } catch {
      // An unreadable auth store means "cannot tell", which reads as not linked.
    }
  }
  return linked;
}

async function safeCount(read: () => Promise<unknown[]>): Promise<number> {
  try {
    return (await read()).length;
  } catch {
    return 0;
  }
}
