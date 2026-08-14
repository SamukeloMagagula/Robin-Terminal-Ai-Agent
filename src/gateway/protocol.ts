import type { Message } from '../providers/types.js';
import type { ConfirmRequest } from '../tools/execute.js';

/**
 * Bumped whenever a frame shape changes.
 *
 * This exists because `robin chat` auto-starts a daemon: after a rebuild an old
 * one is still listening, and a new client talking an old protocol to it
 * produces failures that look like anything but the real cause.
 */
export const PROTOCOL_VERSION = 1;

/** What a client is, and what it may be asked to do. */
export type ClientKind = 'terminal' | 'channel';

/** Who caused a turn, so an approval box can say where the request came from. */
export interface ApprovalOrigin {
  /** "terminal", "telegram", ... */
  surface: string;
  /** Sender id or name, where the surface has one. Display only. */
  who?: string;
}

/** Which kind of surface opened a session. */
export type SessionOrigin = 'terminal' | 'channel' | 'http';

/** A session as clients see it. Never carries history — that comes from attach. */
export interface SessionSnapshot {
  id: number;
  /**
   * What opened it. A terminal reopened in a directory reuses its own previous
   * session, and must not adopt one a chat or an HTTP request happens to share
   * a working directory with.
   */
  origin: SessionOrigin;
  label?: string;
  providerId: string;
  providerName: string;
  model: string;
  cwd: string;
  toolsEnabled: boolean;
  autoApprove: boolean;
  turnCount: number;
  /** Running totals for this conversation, where providers reported them. */
  tokens: { input: number; output: number };
  systemPrompt?: string;
  /** A turn is running right now. */
  busy: boolean;
  /** Prompts waiting behind it. */
  queued: number;
}

export type GatewayEvent =
  | { kind: 'turn.started'; turnId: string; providerName: string; model: string }
  | { kind: 'text'; turnId: string; delta: string }
  | { kind: 'thinking'; turnId: string; delta: string }
  | { kind: 'tool.auto_approved'; turnId: string; command: string }
  | { kind: 'tool.output'; turnId: string; chunk: string }
  | {
      kind: 'approval.request';
      approvalId: string;
      request: ConfirmRequest;
      origin: ApprovalOrigin;
    }
  | { kind: 'approval.resolved'; approvalId: string; approved: boolean; by: string }
  | { kind: 'fallback'; turnId: string; message: string; providerName: string; model: string }
  | { kind: 'trim'; turnId: string; dropped: number; limit: number }
  | {
      kind: 'turn.finished';
      turnId: string;
      ok: boolean;
      aborted: boolean;
      providerName: string;
      model: string;
      error?: string;
      /** What the turn cost, where the provider said. */
      tokens?: { input: number; output: number };
    }
  | { kind: 'session.changed'; snapshot: SessionSnapshot };

export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type ResponseFrame =
  | { type: 'res'; id: string; ok: true; result: unknown }
  | { type: 'res'; id: string; ok: false; error: { code: string; message: string } };

export interface EventFrame {
  type: 'event';
  /** Absent for events that are not about one session. */
  sessionId?: number;
  event: GatewayEvent;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

/** Result of `session.attach`. */
export interface AttachResult {
  snapshot: SessionSnapshot;
  history: Message[];
}

/** Result of `prompt.send`. Two-stage: accepted now, `turn.finished` later. */
export interface PromptAccepted {
  turnId: string;
  /** 0 means it started immediately. */
  queuePosition: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses a frame off the wire, returning undefined for anything malformed.
 *
 * Deliberately total: the caller closes the connection on undefined rather than
 * throwing, because an exception here would be raised inside a socket event
 * handler, where there is nothing useful to catch it.
 */
export function parseFrame(raw: string): Frame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (parsed.type === 'req') {
    if (typeof parsed.id !== 'string' || typeof parsed.method !== 'string') return undefined;
    if (!isRecord(parsed.params)) return undefined;
    return parsed as unknown as RequestFrame;
  }
  if (parsed.type === 'res') {
    if (typeof parsed.id !== 'string' || typeof parsed.ok !== 'boolean') return undefined;
    if (parsed.ok === false && !isRecord(parsed.error)) return undefined;
    return parsed as unknown as ResponseFrame;
  }
  if (parsed.type === 'event') {
    if (!isRecord(parsed.event) || typeof parsed.event.kind !== 'string') return undefined;
    return parsed as unknown as EventFrame;
  }
  return undefined;
}
