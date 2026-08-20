import { randomUUID } from 'node:crypto';
import type { GatewayClient } from '../gateway/client.js';
import type { GatewayEvent, PromptAccepted, SessionSnapshot } from '../gateway/protocol.js';
import type { JsonRpcConnection } from './jsonrpc-connection.js';
import { robinVersion } from '../version.js';

/**
 * Matches ApprovalRegistry's own default (src/gateway/approvals.ts) — a
 * request nobody answers within this long is treated the same way on either
 * surface.
 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export interface AcpBridgeDeps {
  client: GatewayClient;
  /** The provider/model a new ACP session opens with — no picker exists here. */
  resolveDefault: () => Promise<{ providerId: string; model: string }>;
  /**
   * How long to wait for the editor to answer a permission request before
   * treating it as declined. A clean disconnect is already handled by the
   * transport's onClose — this is the backstop for an editor that hangs
   * without ever closing the pipe. Overridable for tests.
   */
  permissionTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bridges ACP (JSON-RPC over stdio) to the gateway (Robin's own protocol,
 * over a loopback socket). Connects as a `kind: 'terminal'` client — an ACP
 * editor session has a human answering permission prompts in real time, the
 * same trust shape a terminal has, not a channel's allowlist model.
 */
export class AcpBridge {
  private readonly acpToGateway = new Map<string, number>();
  private readonly gatewayToAcp = new Map<number, string>();
  /** The most recent turn per gateway session, so session/cancel knows what to interrupt. */
  private readonly currentTurn = new Map<number, string>();
  /** Resolved by 'turn.finished', keyed by turnId — one per in-flight session/prompt. */
  private readonly pendingTurns = new Map<string, (stopReason: string) => void>();

  constructor(
    private readonly connection: JsonRpcConnection,
    private readonly deps: AcpBridgeDeps
  ) {
    connection.onRequest('initialize', async () => this.initialize());
    connection.onRequest('session/new', (params) => this.sessionNew(params));
    connection.onRequest('session/prompt', (params) => this.sessionPrompt(params));
    connection.onNotification('session/cancel', (params) => {
      void this.sessionCancel(params);
    });

    deps.client.on((sessionId, event) => this.handleGatewayEvent(sessionId, event));
    // Without this, a session/prompt awaiting 'turn.finished' hangs forever
    // if the gateway daemon disappears mid-turn (a crash, `robin gateway
    // restart`) — that event can now never arrive.
    deps.client.onClose(() => this.handleGatewayClosed());
  }

  private handleGatewayClosed(): void {
    const pending = [...this.pendingTurns.values()];
    this.pendingTurns.clear();
    for (const resolve of pending) resolve('cancelled');
  }

  private async initialize(): Promise<Record<string, unknown>> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      agentInfo: { name: 'robin', version: robinVersion() },
      authMethods: [],
    };
  }

  private async sessionNew(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cwd = typeof params.cwd === 'string' ? params.cwd : process.cwd();
    const { providerId, model } = await this.deps.resolveDefault();
    const snapshot = await this.deps.client.request<SessionSnapshot>('session.create', {
      providerId,
      model,
      cwd,
    });
    await this.deps.client.request('session.attach', { id: snapshot.id });

    const acpSessionId = randomUUID();
    this.acpToGateway.set(acpSessionId, snapshot.id);
    this.gatewayToAcp.set(snapshot.id, acpSessionId);
    return { sessionId: acpSessionId };
  }

  private async sessionPrompt(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const acpSessionId = String(params.sessionId ?? '');
    const gatewaySessionId = this.acpToGateway.get(acpSessionId);
    if (gatewaySessionId === undefined) {
      throw new Error(`Unknown session "${acpSessionId}".`);
    }

    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    const text = blocks
      .filter(
        (block): block is { type: string; text: string } =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      )
      .map((block) => block.text)
      .join('\n');

    const { turnId } = await this.deps.client.request<PromptAccepted>('prompt.send', {
      id: gatewaySessionId,
      text,
    });
    this.currentTurn.set(gatewaySessionId, turnId);

    const stopReason = await new Promise<string>((resolve) => {
      this.pendingTurns.set(turnId, resolve);
    });
    return { stopReason };
  }

  private async sessionCancel(params: Record<string, unknown>): Promise<void> {
    const gatewaySessionId = this.acpToGateway.get(String(params.sessionId ?? ''));
    if (gatewaySessionId === undefined) return;
    const turnId = this.currentTurn.get(gatewaySessionId);
    if (!turnId) return;
    await this.deps.client.request('turn.interrupt', { turnId }).catch(() => {});
  }

  private sendUpdate(acpSessionId: string, update: Record<string, unknown>): void {
    this.connection.sendNotification('session/update', { sessionId: acpSessionId, update });
  }

  private handleGatewayEvent(sessionId: number | undefined, event: GatewayEvent): void {
    if (sessionId === undefined) return;

    if (event.kind === 'approval.request') {
      void this.handleApprovalRequest(sessionId, event);
      return;
    }

    const acpSessionId = this.gatewayToAcp.get(sessionId);
    if (!acpSessionId) return; // Not a session this bridge opened.

    switch (event.kind) {
      case 'text':
        this.sendUpdate(acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId: event.turnId,
          content: { type: 'text', text: event.delta },
        });
        break;
      case 'thinking':
        this.sendUpdate(acpSessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: event.delta },
        });
        break;
      case 'tool.auto_approved':
        this.sendUpdate(acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `$ ${event.command}\n` },
        });
        break;
      case 'tool.output':
        this.sendUpdate(acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.chunk },
        });
        break;
      case 'trim':
        this.sendUpdate(acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `[dropped ${event.dropped} older message(s) to fit the ${event.limit}-token limit]\n`,
          },
        });
        break;
      case 'fallback':
        this.sendUpdate(acpSessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `[${event.message} — retrying on ${event.providerName} · ${event.model}]\n` },
        });
        break;
      case 'turn.finished': {
        const resolve = this.pendingTurns.get(event.turnId);
        if (!resolve) return;
        this.pendingTurns.delete(event.turnId);
        if (event.aborted) {
          resolve('cancelled');
        } else if (!event.ok) {
          // ACP's stopReason has no "errored" value — the error is surfaced in
          // the transcript instead of silently dropped, and the turn is still
          // reported as ended.
          this.sendUpdate(acpSessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `\n[error: ${event.error ?? 'unknown'}]` },
          });
          resolve('end_turn');
        } else {
          resolve('end_turn');
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleApprovalRequest(
    gatewaySessionId: number,
    event: Extract<GatewayEvent, { kind: 'approval.request' }>
  ): Promise<void> {
    const acpSessionId = this.gatewayToAcp.get(gatewaySessionId);
    // Not one of this bridge's sessions — some other attached client answers it.
    if (!acpSessionId) return;

    this.sendUpdate(acpSessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `\n${event.request.message}\n` },
    });

    let approved = false;
    try {
      const timeoutMs = this.deps.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
      const request = this.connection.sendRequest<{
        outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
      }>('session/request_permission', {
        sessionId: acpSessionId,
        toolCall: { toolCallId: event.approvalId },
        options: [
          { optionId: 'yes', name: 'Yes, this once', kind: 'allow_once' },
          { optionId: 'no', name: 'No', kind: 'reject_once' },
        ],
      });
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('permission request timed out')), timeoutMs);
        timer.unref?.();
      });
      const response = await Promise.race([request, timeout]);
      approved = response.outcome.outcome === 'selected' && response.outcome.optionId === 'yes';
    } catch {
      // Editor unreachable, failed to answer, or timed out — silence means
      // no, the same rule the gateway already applies when nobody is
      // attached at all.
      approved = false;
    }

    await this.deps.client
      .request('approval.answer', { approvalId: event.approvalId, approved, scope: 'once' })
      .catch(() => {});
  }
}
