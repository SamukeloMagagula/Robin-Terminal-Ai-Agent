import { randomUUID } from 'node:crypto';
import type { ConfirmFn, ConfirmRequest } from '../tools/execute.js';
import type { ApprovalOrigin } from './protocol.js';
import { permits, type Escalation, type Manifest, type Rule } from '../autonomy/manifest.js';
import type { AutonomyStore } from '../autonomy/grant-store.js';
import type { AuditLog } from '../autonomy/audit.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How far an answer reaches.
 *
 * 'once' is the default and the safe reading — a client that says nothing gets
 * it. The others are the user widening their own answer deliberately.
 *
 * 'manifest' is narrow where 'session' is broad: it adds the one rule that was
 * asked about to the governing manifest, on disk. It deliberately does NOT
 * touch allowedKinds, which is keyed on the coarse `kind` — approving a single
 * restic command must not become approval of every command for the session.
 */
export type ApprovalScope = 'once' | 'session' | 'reply' | 'manifest';

/**
 * What governs a session allowed to act with nobody attached.
 *
 * The manifest is a decision a human made at a moment when they were present.
 * Consulted here it only ever grants — checkPath and the read-only allowlist
 * have already run upstream in execute.ts, and no manifest is consulted for
 * them at all.
 */
export interface Governance {
  manifest: Manifest;
  audit: AuditLog;
  store: AutonomyStore;
}

export interface PendingApproval {
  id: string;
  sessionId: number;
  request: ConfirmRequest;
  origin: ApprovalOrigin;
  /**
   * Where this approval may also be offered, when the governing manifest asks
   * for it. Present so a client such as the channel bridge can route it; the
   * registry itself uses only the window, to widen its own timeout.
   */
  escalate?: Escalation;
}

export interface ApprovalRegistryDeps {
  /** Offers a pending approval to clients. Returns how many can answer it. */
  broadcast(pending: PendingApproval): number;
  /** Tells clients an approval is settled, so they close their prompt. */
  resolved(pending: PendingApproval, approved: boolean, by: string): void;
  timeoutMs?: number;
}

interface Entry {
  pending: PendingApproval;
  settle: (approved: boolean, by: string) => void;
}

function requestKey(sessionId: number, request: ConfirmRequest): string {
  // The message carries the command, path or tool arguments, so two requests
  // with the same key really are the same request.
  return `${sessionId} ${request.kind} ${request.message}`;
}

/**
 * Holds tool approvals until a human answers, or until it is clear none will.
 *
 * Refusals are remembered for the rest of the reply, and that is not symmetry
 * for its own sake. A declined tool call reads to a model as a failed attempt,
 * and the reflex after a failed attempt is another attempt: one reply put the
 * same skill proposal to the user four times and seven variants of a search
 * command. Re-asking a question already answered is not caution, it is noise,
 * and noise is what stops people reading these prompts at all.
 *
 * Approvals are deliberately not remembered the same way. A yes is about the
 * one thing being asked for; a no is about a direction the model should stop
 * taking.
 *
 * The memory is per session and per reply — the next thing the user types may
 * be precisely a request to do the thing they just refused.
 */
export class ApprovalRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly declined = new Map<number, Set<string>>();
  /**
   * Kinds granted for the rest of a session, per session.
   *
   * Per session rather than per daemon on purpose: approving commands in the
   * repository you are working in must not silence the gate for a Telegram
   * chat that happens to share the daemon.
   */
  private readonly allowedKinds = new Map<number, Set<ConfirmRequest['kind']>>();
  /** Kinds refused for the rest of a reply, per session. Cleared by beginTurn. */
  private readonly declinedKinds = new Map<number, Set<ConfirmRequest['kind']>>();
  /**
   * What governs each session that has governance, recorded when a request
   * arrives so that answer() — which is handed only an approval id — can find
   * the manifest a 'manifest'-scoped answer belongs to.
   */
  private readonly governing = new Map<number, Governance>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: ApprovalRegistryDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Clears the per-reply refusals for one session. Session grants survive. */
  beginTurn(sessionId: number): void {
    this.declined.delete(sessionId);
    this.declinedKinds.delete(sessionId);
  }

  pending(): PendingApproval[] {
    return [...this.entries.values()].map((entry) => entry.pending);
  }

  confirmFor(
    sessionId: number,
    origin: ApprovalOrigin,
    autoApprove: boolean,
    governance?: Governance
  ): ConfirmFn {
    return (request) => this.ask(sessionId, origin, autoApprove, request, governance);
  }

  /**
   * Settles one approval.
   *
   * `scope` widens the answer beyond this single request: 'session' stops
   * asking about that kind until the daemon stops, 'reply' stops asking about
   * it until the user speaks again. Anything else — including a client that
   * sends nothing — means this once, which is the safe reading.
   *
   * Returns false when the approval is unknown or already settled.
   */
  answer(
    approvalId: string,
    approved: boolean,
    by: string,
    scope: ApprovalScope = 'once'
  ): boolean {
    const entry = this.entries.get(approvalId);
    if (!entry) return false;

    const { sessionId, request } = entry.pending;
    if (approved && scope === 'session') {
      const allowed = this.allowedKinds.get(sessionId) ?? new Set<ConfirmRequest['kind']>();
      allowed.add(request.kind);
      this.allowedKinds.set(sessionId, allowed);
    }
    if (approved && scope === 'manifest') {
      const governance = this.governing.get(sessionId);
      if (governance) {
        // The exact subject, not a pattern widened from it. Turning one
        // approval into a rule that covers more is a guess about intent that
        // nobody actually made.
        const rule: Rule = { kind: request.kind, pattern: request.subject };
        void governance.store.addRule(governance.manifest.id, rule);
        // Keep the running session consistent without waiting on a re-read.
        if (
          !governance.manifest.rules.some(
            (candidate) => candidate.kind === rule.kind && candidate.pattern === rule.pattern
          )
        ) {
          governance.manifest.rules.push(rule);
        }
      }
    }
    if (!approved && scope === 'reply') {
      const refused = this.declinedKinds.get(sessionId) ?? new Set<ConfirmRequest['kind']>();
      refused.add(request.kind);
      this.declinedKinds.set(sessionId, refused);
    }

    entry.settle(approved, by);
    return true;
  }

  /** The first rule of `manifest` that covers `request`, if any. */
  private async matchingRule(
    manifest: Manifest,
    request: ConfirmRequest
  ): Promise<Rule | undefined> {
    for (const rule of manifest.rules) {
      if (await permits({ ...manifest, rules: [rule] }, request, new Date())) return rule;
    }
    return undefined;
  }

  private async ask(
    sessionId: number,
    origin: ApprovalOrigin,
    autoApprove: boolean,
    request: ConfirmRequest,
    governance?: Governance
  ): Promise<boolean> {
    // A session the operator marked auto-approve never reaches a human by
    // design. This is the old --allow-tools, now a property of the session
    // rather than of the process, so `/session` and `gateway status` can show
    // which conversations carry it.
    if (autoApprove) return true;

    // A manifest is a decision this user already made, at a moment when they
    // were present and paying attention. Looking it up is not deciding
    // anything now — it is declining to ask a question already answered.
    //
    // A request it does not cover gets no special treatment: it falls through
    // to everything below, which already refuses when no client can answer.
    if (governance) {
      this.governing.set(sessionId, governance);
      const rule = await this.matchingRule(governance.manifest, request);
      if (rule) {
        void governance.audit.append({
          ts: new Date().toISOString(),
          manifest: governance.manifest.id,
          kind: request.kind,
          detail: request.subject,
          decision: 'allowed',
          rule: rule.pattern,
        });
        return true;
      }
    }

    // Standing answers, widest first. Both are answers the user already gave;
    // asking again would be asking them to repeat themselves.
    if (this.allowedKinds.get(sessionId)?.has(request.kind)) return true;
    if (this.declinedKinds.get(sessionId)?.has(request.kind)) return false;

    const key = requestKey(sessionId, request);
    if (this.declined.get(sessionId)?.has(key)) return false;

    const escalate = governance?.manifest.escalate;
    const pending: PendingApproval = {
      id: randomUUID(),
      sessionId,
      request,
      origin,
      ...(escalate ? { escalate } : {}),
    };

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean, by: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.entries.delete(pending.id);
        if (!approved) {
          const refused = this.declined.get(sessionId) ?? new Set<string>();
          refused.add(key);
          this.declined.set(sessionId, refused);
          // Refusals are recorded too. A log of only the allowed calls answers
          // "what did it do" but not "what did it try to do", and the second
          // question is the one that reveals a manifest that is wrong.
          if (governance) {
            void governance.audit.append({
              ts: new Date().toISOString(),
              manifest: governance.manifest.id,
              kind: request.kind,
              detail: request.subject,
              decision: by === 'timeout' ? 'expired' : 'refused',
              rule: null,
            });
          }
        }
        this.deps.resolved(pending, approved, by);
        resolve(approved);
      };

      // An escalated approval is offered to someone who is not at the keyboard,
      // so the window is theirs to answer in rather than the few minutes a
      // terminal prompt assumes. Expiry is still a refusal.
      const waitMs = escalate ? escalate.windowMinutes * 60_000 : this.timeoutMs;
      const timer = setTimeout(() => settle(false, 'timeout'), waitMs);
      // Node keeps a process alive for a pending timer. A daemon waiting on an
      // approval nobody will answer should not also be unkillable.
      timer.unref?.();

      this.entries.set(pending.id, { pending, settle });

      const approvers = this.deps.broadcast(pending);
      // Nobody at a keyboard means no. This is exactly what `robin serve` does
      // today, and it is what makes running the bridge without --allow-tools
      // safe rather than merely quiet.
      if (approvers === 0) settle(false, 'nobody attached');
    });
  }
}
