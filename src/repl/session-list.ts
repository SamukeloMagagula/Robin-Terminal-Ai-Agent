import type { Provider } from '../providers/types.js';
import { createSession, type Session } from './session.js';

/**
 * Single-digit ids keep `/session 3` unambiguous and typo-proof, and nine
 * parallel conversations is already past what anyone tracks. Raising it means
 * two-character ids, which is the actual cost.
 */
export const MAX_SESSIONS = 9;

/**
 * The conversations open right now, and which one the user is talking to.
 *
 * Switching is pure in-memory state — no network, no re-auth. Each session
 * keeps its own history, system prompt, tool setting and transcript, so two
 * sessions on the same model are genuinely independent rather than two views
 * of one thread.
 */
export class SessionList {
  private sessions: Session[];
  private activeId: number;

  constructor(provider: Provider, model: string) {
    this.sessions = [createSession(provider, model, 1)];
    this.activeId = 1;
  }

  get active(): Session {
    const session = this.sessions.find((s) => s.id === this.activeId);
    // Only reachable if close() left the list inconsistent, which it cannot:
    // it refuses to remove the last session and always reassigns activeId.
    if (!session) throw new Error('No active session.');
    return session;
  }

  list(): Session[] {
    return [...this.sessions].sort((a, b) => a.id - b.id);
  }

  /** Creates a session and switches to it. */
  create(provider: Provider, model: string): Session {
    if (this.sessions.length >= MAX_SESSIONS) {
      throw new Error(`Robin keeps at most ${MAX_SESSIONS} sessions. Close one with /session close.`);
    }
    const session = createSession(provider, model, this.nextId());
    this.sessions.push(session);
    this.activeId = session.id;
    return session;
  }

  switchTo(id: number): Session {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) throw new Error(`No session ${id}. Use /session to see what is open.`);
    this.activeId = id;
    return session;
  }

  close(id: number): void {
    if (this.sessions.length === 1) {
      throw new Error('That is the last session — use /exit to leave Robin.');
    }
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index === -1) throw new Error(`No session ${id}.`);

    this.sessions.splice(index, 1);
    // Closing the session you are in has to land somewhere; the lowest
    // remaining id is predictable, where "the next one along" depends on
    // which end of the list you happened to be at.
    if (this.activeId === id) this.activeId = this.list()[0].id;
  }

  /** How a session is named in listings: its label, else provider and model. */
  describe(session: Session): string {
    return session.label ?? `${session.provider.name} · ${session.model}`;
  }

  /** The lowest free id, so ids stay single-digit across a long session. */
  private nextId(): number {
    const taken = new Set(this.sessions.map((s) => s.id));
    for (let id = 1; id <= MAX_SESSIONS; id++) {
      if (!taken.has(id)) return id;
    }
    throw new Error(`Robin keeps at most ${MAX_SESSIONS} sessions.`);
  }
}
