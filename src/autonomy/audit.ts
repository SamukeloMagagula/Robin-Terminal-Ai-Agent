import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuleKind } from './manifest.js';

export interface AuditEntry {
  ts: string;
  manifest: string;
  kind: RuleKind;
  /** The command, path or tool name — the request's subject, verbatim. */
  detail: string;
  decision: 'allowed' | 'refused' | 'expired';
  /** The rule pattern that granted it, or null when nothing did. */
  rule: string | null;
}

export function defaultAuditDir(): string {
  return path.join(os.homedir(), '.robin', 'audit');
}

/**
 * A manifest id becomes a filename, so it must not be able to name a path.
 * Separators are flattened, and a leading dot is prefixed so no id can produce
 * a dotfile or a `..`-prefixed name — `../escape` becomes `_.._escape`.
 */
function safeName(manifestId: string): string {
  const flattened = manifestId.replace(/[^A-Za-z0-9._-]/g, '_');
  return flattened.startsWith('.') ? `_${flattened}` : flattened;
}

/**
 * What an unattended run actually did, and what it tried to do.
 *
 * Both decisions are recorded. A log of only the allowed calls answers "what
 * did it do" but not "what did it try to do", and the second question is the
 * one that reveals a manifest that is wrong or a model behaving oddly.
 */
export class AuditLog {
  constructor(private readonly dir: string = defaultAuditDir()) {}

  private file(manifestId: string): string {
    return path.join(this.dir, `${safeName(manifestId)}.jsonl`);
  }

  /**
   * Returns the error rather than throwing it.
   *
   * A full disk must not become a way to make Robin refuse every tool call, and
   * equally must not become a way to act unrecorded — so the caller surfaces
   * this on the run report instead of either failing or swallowing it.
   */
  async append(entry: AuditEntry): Promise<Error | undefined> {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.file(entry.manifest), `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  async read(manifestId: string): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(manifestId), 'utf-8');
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        // A truncated final line from an interrupted write must not lose the rest.
      }
    }
    return out;
  }
}
