import { randomUUID } from 'node:crypto';
import type { Message, Provider } from '../providers/types.js';
import type {
  ApprovalOrigin,
  AttachResult,
  GatewayEvent,
  PromptAccepted,
  SessionSnapshot,
} from './protocol.js';
import { runTurn } from '../repl/run-turn.js';
import type { ApprovalRegistry } from './approvals.js';
import { createSession, type Session } from '../repl/session.js';
import type { UnsupportedModelStore } from '../providers/unsupported-models.js';
import type { ContextLimitStore } from '../providers/context-limits.js';
import type { MemoryStore } from '../memory/store.js';
import type { SkillStore } from '../skills/store.js';
import type { SessionStore, PersistedSession } from './session-store.js';
import { ChatLog } from '../chat-log.js';

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
    /** Absent means conversations do not survive a restart. */
    sessions?: SessionStore;
  };
  /** PERSONALITY.md, already loaded and approved by the caller. */
  personality?: string;
  /** Tools contributed by approved MCP servers, offered alongside the built-ins. */
  mcp?: {
    toolDefinitions(): { name: string; description: string; parameters: Record<string, unknown> }[];
    has(name: string): boolean;
    call(name: string, args: Record<string, unknown>): Promise<string>;
  };
}

/** A session plus what the daemon needs that a REPL session never carried. */
interface SessionRecord {
  session: Session;
  cwd: string;
  autoApprove: boolean;
  /** Turns waiting or running. A new prompt queues behind the tail. */
  queue: Promise<void>;
  /**
   * Turns accepted and not yet finished, including the one running.
   *
   * One counter rather than a `busy` flag and a `queued` count kept in step:
   * `sendPrompt` returns before its turn begins, so a flag set inside the turn
   * would report a session as idle in the window where a client has just been
   * told its prompt was accepted.
   */
  pending: number;
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
  /** In-flight turns, so an interrupt can find the one it means. */
  private readonly running = new Map<string, AbortController>();
  /**
   * One write chain per session id.
   *
   * Ordering matters and is not obvious: a create and the close that follows it
   * are two separate writes, and without a chain the delete can land first and
   * the save then puts the file back. The chain outlives the session, because
   * the last write for an id is usually its removal.
   */
  private readonly writeChains = new Map<number, Promise<void>>();
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
      pending: 0,
    });
    this.persist(id);
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
      /** null clears it; undefined leaves it alone. */
      personality?: string | null;
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
    if (patch.personality !== undefined) session.personality = patch.personality ?? undefined;

    if (switchingConnection) {
      session.history = [];
      session.chatLog.startNewSession();
    }

    const snapshot = this.snapshot(id);
    this.persist(id);
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
    this.persist(id);
    this.deps.emit(id, { kind: 'session.changed', snapshot });
    return snapshot;
  }

  close(id: number): void {
    this.record(id);
    this.records.delete(id);
    const store = this.deps.stores.sessions;
    // Behind the same chain as this session's saves, so the delete cannot be
    // overtaken by a write that was already in flight.
    if (store) this.queueWrite(id, () => store.remove(id));
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
      busy: record.pending > 0,
      // Everything behind whichever turn is at the head of the queue.
      queued: Math.max(0, record.pending - 1),
    };
  }

  /**
   * Queues a prompt and returns immediately.
   *
   * The queue is per session, and the reason is not politeness: two messages
   * arriving during a turn would otherwise both mutate one history array and
   * interleave into nonsense. bridge.ts has always done this per chat; here it
   * covers every surface at once, which is the point of a shared session.
   */
  sendPrompt(id: number, text: string, origin: ApprovalOrigin): PromptAccepted {
    const record = this.record(id);
    const turnId = randomUUID();
    const queuePosition = record.pending;
    record.pending += 1;

    record.queue = record.queue
      .catch(() => {})
      .then(() => this.runOne(id, turnId, text, origin));

    return { turnId, queuePosition };
  }

  /** False when that turn has already finished, or never existed. */
  interrupt(turnId: string): boolean {
    const controller = this.running.get(turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Resolves once nothing is queued and everything is written. */
  async idle(): Promise<void> {
    await Promise.all(
      [...this.records.values()].map((record) => record.queue.catch(() => {}))
    );
    await this.flush();
  }

  private async runOne(
    id: number,
    turnId: string,
    text: string,
    origin: ApprovalOrigin
  ): Promise<void> {
    const record = this.records.get(id);
    // The session may have been closed while this sat in the queue.
    if (!record) return;

    const { session } = record;
    const controller = new AbortController();
    this.running.set(turnId, controller);

    this.deps.emit(id, {
      kind: 'turn.started',
      turnId,
      providerName: session.provider.name,
      model: session.model,
    });
    this.deps.approvals.beginTurn(id);

    try {
      const result = await runTurn(session, text, {
        signal: controller.signal,
        cwd: record.cwd,
        // Without this runTurn falls back to the real provider registry, so a
        // daemon built with a restricted set of providers would quietly reach
        // past it — and a test would make live network calls.
        providers: this.deps.providers,
        confirm: this.deps.approvals.confirmFor(id, origin, record.autoApprove),
        unsupportedStore: this.deps.stores.unsupported,
        contextLimits: this.deps.stores.contextLimits,
        memory: this.deps.stores.memory,
        skills: this.deps.stores.skills,
        mcp: this.deps.mcp,
        onText: (delta) => this.deps.emit(id, { kind: 'text', turnId, delta }),
        onThinking: (delta) => this.deps.emit(id, { kind: 'thinking', turnId, delta }),
        onAutoApproved: (command) =>
          this.deps.emit(id, { kind: 'tool.auto_approved', turnId, command }),
        onOutput: (chunk) => this.deps.emit(id, { kind: 'tool.output', turnId, chunk }),
        onTrim: ({ dropped, limit }) =>
          this.deps.emit(id, { kind: 'trim', turnId, dropped, limit }),
        onFallback: ({ error, next }) =>
          this.deps.emit(id, {
            kind: 'fallback',
            turnId,
            message: error.message,
            providerName: next.provider.name,
            model: next.model,
          }),
      });

      if (result.provider.id !== session.provider.id || result.model !== session.model) {
        // Fallback rescued the turn on another model. The session follows it,
        // exactly as the REPL has always done, and every attached client is
        // told — otherwise their status line quietly becomes a lie.
        session.provider = result.provider;
        session.model = result.model;
        this.deps.emit(id, { kind: 'session.changed', snapshot: this.snapshot(id) });
      }

      await session.chatLog.write(session.provider.name, session.model, session.history);
      // After the transcript, so the persisted record carries where that
      // transcript lives and a restart continues the same file.
      this.persist(id);

      this.deps.emit(id, {
        kind: 'turn.finished',
        turnId,
        ok: result.ok,
        aborted: result.aborted ?? false,
        providerName: result.provider.name,
        model: result.model,
        error: result.error?.message,
      });
    } catch (err) {
      // runTurn reports failure in its result rather than throwing, so this is
      // a bug or a store failure. It must still close the turn out: a client
      // waiting on turn.finished would otherwise wait for good.
      this.deps.emit(id, {
        kind: 'turn.finished',
        turnId,
        ok: false,
        aborted: false,
        providerName: session.provider.name,
        model: session.model,
        error: (err as Error).message,
      });
    } finally {
      this.running.delete(turnId);
      record.pending = Math.max(0, record.pending - 1);
    }
  }

  /**
   * Reads conversations back off disk. Call once, before serving.
   *
   * A session whose provider this build no longer has is dropped rather than
   * failing the start: the conversation is still readable on disk, it just
   * cannot be continued as-is, and refusing to boot over it would be a poor
   * trade.
   */
  async restore(): Promise<void> {
    const store = this.deps.stores.sessions;
    if (!store) return;

    for (const saved of await store.load()) {
      const provider = this.deps.providers.find((p) => p.id === saved.providerId);
      if (!provider) {
        await store.remove(saved.id);
        continue;
      }

      const session = createSession(provider, saved.model, saved.id);
      session.label = saved.label;
      session.history = saved.history;
      session.turnCount = saved.turnCount;
      session.systemPrompt = saved.systemPrompt;
      session.toolsEnabled = saved.toolsEnabled;
      // Personality is deliberately not restored: it comes from PERSONALITY.md,
      // which is trust-gated and may have changed since. The client re-applies
      // it when it attaches.
      if (saved.transcript) {
        session.chatLog.resume(saved.transcript.path, new Date(saved.transcript.startedAt));
      }

      this.records.set(saved.id, {
        session,
        cwd: saved.cwd,
        autoApprove: saved.autoApprove,
        queue: Promise.resolve(),
        // Whatever was running when the daemon stopped is not running now.
        pending: 0,
      });
      this.nextId = Math.max(this.nextId, saved.id + 1);
    }
  }

  /** Writes one conversation out. Called after anything that changes it. */
  private persist(id: number): void {
    const store = this.deps.stores.sessions;
    if (!store) return;
    const record = this.records.get(id);
    if (!record) return;

    const { session } = record;
    const transcript = session.chatLog.location();
    const saved: PersistedSession = {
      id,
      label: session.label,
      providerId: session.provider.id,
      model: session.model,
      cwd: record.cwd,
      toolsEnabled: session.toolsEnabled,
      autoApprove: record.autoApprove,
      turnCount: session.turnCount,
      systemPrompt: session.systemPrompt,
      history: session.history,
      transcript: transcript
        ? { path: transcript.filePath, startedAt: transcript.startedAt.toISOString() }
        : undefined,
      updatedAt: new Date().toISOString(),
    };
    // Not awaited here: the user is waiting on a reply, not on a disk write.
    // Queued, though, so a shutdown — or a test — can wait for writes to settle
    // rather than racing them.
    this.queueWrite(id, () => store.save(saved));
  }

  private queueWrite(id: number, write: () => Promise<void>): void {
    const chain = (this.writeChains.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(write);
    this.writeChains.set(id, chain);
  }

  /** Waits for every queued write to settle. */
  async flush(): Promise<void> {
    await Promise.all([...this.writeChains.values()].map((chain) => chain.catch(() => {})));
  }

  /** Where this session's transcript is being written. Test seam. */
  transcriptPathForTest(id: number): string | undefined {
    return this.record(id).session.chatLog.location()?.filePath;
  }

  /** A copy: a client that mutated this would be editing the daemon's memory. */
  history(id: number): Message[] {
    return [...this.record(id).session.history];
  }

  /** Appends one message. /recall uses it to put found excerpts in front of the model. */
  append(id: number, message: Message): void {
    this.record(id).session.history.push(message);
    this.persist(id);
  }

  /** Replaces the conversation wholesale, as /load does. */
  setHistory(id: number, messages: Message[]): SessionSnapshot {
    const { session } = this.record(id);
    session.history = [...messages];
    // A loaded conversation is a different conversation, so it gets its own
    // transcript rather than being appended to whatever was open.
    session.chatLog.startNewSession();
    const snapshot = this.snapshot(id);
    this.persist(id);
    this.deps.emit(id, { kind: 'session.changed', snapshot });
    return snapshot;
  }

  /** The session's standing behaviour, for /personality to display. */
  personality(id: number): string | undefined {
    return this.record(id).session.personality;
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
