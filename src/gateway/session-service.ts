import type { Message, Provider } from '../providers/types.js';
import type { AttachResult, GatewayEvent, SessionSnapshot } from './protocol.js';
import type { ApprovalRegistry } from './approvals.js';
import { createSession, type Session } from '../repl/session.js';
import type { UnsupportedModelStore } from '../providers/unsupported-models.js';
import type { ContextLimitStore } from '../providers/context-limits.js';
import type { MemoryStore } from '../memory/store.js';
import type { SkillStore } from '../skills/store.js';

export interface SessionServiceDeps {
  providers: Provider[];
  approvals: ApprovalRegistry;
  emit(sessionId: number, event: GatewayEvent): void;
  stores: {
    unsupported: UnsupportedModelStore;
    contextLimits: ContextLimitStore;
    /** Absent disables the memory tools, exactly as it does in the REPL. */
    memory?: MemoryStore;
    /** Absent disables the skill tools. */
    skills?: SkillStore;
  };
  /** PERSONALITY.md, already loaded and approved by the caller. */
  personality?: string;
}

/** A session plus what the daemon needs that a REPL session never carried. */
interface SessionRecord {
  session: Session;
  cwd: string;
  autoApprove: boolean;
  /** Turns waiting or running. A new prompt queues behind the tail. */
  queue: Promise<void>;
  queued: number;
  busy: boolean;
}

/**
 * Owns every open conversation and the stores behind them.
 *
 * Deliberately socket-free. This is where the daemon's behaviour lives, and it
 * is testable by calling methods; server.ts translates frames into these calls
 * and does nothing else.
 *
 * SessionList is not reused here. Its rules — ids capped at nine, never fewer
 * than one session — were REPL rules: nine is what a person tracks at a `/session`
 * prompt, and the REPL had nowhere to land if you closed your only conversation.
 * A daemon holding zero sessions is a normal, quiet state.
 */
export class SessionService {
  private readonly records = new Map<number, SessionRecord>();
  private nextId = 1;

  constructor(private readonly deps: SessionServiceDeps) {}

  list(): SessionSnapshot[] {
    return [...this.records.keys()].sort((a, b) => a - b).map((id) => this.snapshot(id));
  }

  create(params: {
    providerId: string;
    model: string;
    cwd: string;
    label?: string;
    autoApprove?: boolean;
  }): SessionSnapshot {
    const provider = this.provider(params.providerId);
    // Ids are never reused: a client still holding a closed session's id would
    // otherwise start addressing a conversation it has never seen.
    const id = this.nextId++;
    const session = createSession(provider, params.model, id);
    session.label = params.label;
    session.personality = this.deps.personality;
    this.records.set(id, {
      session,
      cwd: params.cwd,
      autoApprove: params.autoApprove ?? false,
      queue: Promise.resolve(),
      queued: 0,
      busy: false,
    });
    return this.snapshot(id);
  }

  attach(id: number): AttachResult {
    return { snapshot: this.snapshot(id), history: [...this.record(id).session.history] };
  }

  update(
    id: number,
    patch: {
      providerId?: string;
      model?: string;
      /** null clears it; undefined leaves it alone. */
      systemPrompt?: string | null;
      toolsEnabled?: boolean;
      label?: string;
    }
  ): SessionSnapshot {
    const { session } = this.record(id);

    // A connection switch resets the conversation: the model on the other side
    // has not seen any of it, and replaying it would present someone else's
    // conversation as its own.
    const switchingConnection =
      (patch.providerId !== undefined && patch.providerId !== session.provider.id) ||
      (patch.model !== undefined && patch.model !== session.model);

    if (patch.providerId !== undefined) session.provider = this.provider(patch.providerId);
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.toolsEnabled !== undefined) session.toolsEnabled = patch.toolsEnabled;
    if (patch.label !== undefined) session.label = patch.label;
    if (patch.systemPrompt !== undefined) session.systemPrompt = patch.systemPrompt ?? undefined;

    if (switchingConnection) {
      session.history = [];
      session.chatLog.startNewSession();
    }

    const snapshot = this.snapshot(id);
    this.deps.emit(id, { kind: 'session.changed', snapshot });
    return snapshot;
  }

  clear(id: number): SessionSnapshot {
    const { session } = this.record(id);
    session.history = [];
    // The nudge cadence counts turns in *this* conversation, so a reset
    // conversation starts its count over.
    session.turnCount = 0;
    session.chatLog.startNewSession();
    const snapshot = this.snapshot(id);
    this.deps.emit(id, { kind: 'session.changed', snapshot });
    return snapshot;
  }

  close(id: number): void {
    this.record(id);
    this.records.delete(id);
  }

  snapshot(id: number): SessionSnapshot {
    const record = this.record(id);
    const { session } = record;
    return {
      id,
      label: session.label,
      providerId: session.provider.id,
      providerName: session.provider.name,
      model: session.model,
      cwd: record.cwd,
      toolsEnabled: session.toolsEnabled,
      autoApprove: record.autoApprove,
      turnCount: session.turnCount,
      systemPrompt: session.systemPrompt,
      busy: record.busy,
      queued: record.queued,
    };
  }

  /** Test-only seam: history is otherwise written only by a turn. */
  appendForTest(id: number, message: Message): void {
    this.record(id).session.history.push(message);
  }

  private record(id: number): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`No session ${id}.`);
    return record;
  }

  private provider(id: string): Provider {
    const provider = this.deps.providers.find((p) => p.id === id);
    if (!provider) throw new Error(`Unknown provider "${id}".`);
    return provider;
  }
}
