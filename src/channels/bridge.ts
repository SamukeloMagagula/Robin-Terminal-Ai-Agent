/**
 * The transport-agnostic half of remote control: access, sessions, commands
 * and the agent turn. Everything here works identically for Telegram,
 * WhatsApp or Teams — only ChannelTransport differs between them.
 *
 * The bridge no longer runs turns. It holds a gateway connection and one
 * gateway session per chat, so a conversation started here can be continued
 * from a terminal and back. What it kept is the part that is genuinely its
 * own: who is allowed to talk to it.
 */

import type { ChannelTransport, IncomingMessage } from './types.js';
import { checkAccess } from './access.js';
import { createReplyStream } from './streamer.js';
import type { GatewayClient } from '../gateway/client.js';
import type { GatewayEvent, PromptAccepted, SessionSnapshot } from '../gateway/protocol.js';

export interface BridgeOptions {
  transport: ChannelTransport;
  client: GatewayClient;
  providerId: string;
  model: string;
  allowlist: string[];
  /**
   * Whether tool calls that would prompt in a terminal may run unattended.
   *
   * Default false, and that default matters more than any other setting here.
   * Over a chat channel there is nobody at the keyboard to read the request, so
   * "approve everything" would turn a chat message into unattended code
   * execution on the operator's machine.
   *
   * It is no longer the whole story, though: with a gateway, an approval is
   * offered to any attached terminal, so leaving this off now means "ask me at
   * my desk" rather than "refuse outright".
   */
  allowTools?: boolean;
  log?: (line: string) => void;
}

const HELP = [
  'Robin — remote control',
  '',
  '/new     start a fresh conversation',
  '/status  which model is answering, and how many turns so far',
  '/help    this message',
  '',
  'Anything else is sent to the model.',
].join('\n');

export class ChannelBridge {
  /** chatId → gateway session id. One conversation per chat, as before. */
  private readonly sessions = new Map<string, number>();
  /**
   * One promise chain per chat. The gateway serialises turns per session, but
   * this also keeps session creation from racing when two messages arrive
   * together in a chat that has none yet.
   */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly log: (line: string) => void;

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? ((line) => console.log(line));
  }

  /**
   * Connects, announces the bot identity, and polls until `signal` aborts.
   *
   * The allowlist is validated before the transport is touched: bringing a bot
   * online that will refuse every message is a misconfiguration worth failing
   * loudly on, not a state to sit in quietly.
   */
  async start(signal: AbortSignal): Promise<void> {
    if (this.options.allowlist.length === 0) {
      throw new Error(
        `No senders are allowed for ${this.options.transport.name}. ` +
          'Add ids to the "allow" array in ~/.robin/channels.json before starting.'
      );
    }

    const { identity } = await this.options.transport.connect();
    this.log(`${this.options.transport.name} connected as ${identity}`);
    this.log(
      `Answering ${this.options.allowlist.length} allowed sender(s) via ${this.options.providerId} · ${this.options.model}`
    );
    this.log(
      this.options.allowTools
        ? 'Tool approvals: AUTO-APPROVED — commands and writes will run unattended.'
        : 'Tool approvals: asked at any attached terminal, and refused if none is. Pass --allow-tools to change this.'
    );

    await this.options.transport.receive((message) => this.enqueue(message), signal);
  }

  /** Serialises handling per chat while returning immediately to the poll loop. */
  private enqueue(message: IncomingMessage): Promise<void> {
    const previous = this.queues.get(message.chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.handle(message));
    this.queues.set(message.chatId, next);
    return next;
  }

  private async handle(message: IncomingMessage): Promise<void> {
    const decision = checkAccess(message.senderId, this.options.allowlist);
    if (!decision.allowed) {
      // Logged for the operator, and deliberately unanswered — see access.ts.
      this.log(`Refused: ${decision.reason}`);
      return;
    }

    const text = message.text.trim();
    if (!text) return;
    this.log(`← ${message.senderName ?? message.senderId}: ${text.slice(0, 80)}`);

    const reply = await this.respond(message, text);
    // A model turn posts and edits its own reply as it arrives; anything else
    // is a one-line answer with nothing to stream.
    if (reply !== null) await this.options.transport.send(message.chatId, reply);
  }

  /** Returns the text to send, or null when the reply has already been sent. */
  private async respond(message: IncomingMessage, text: string): Promise<string | null> {
    if (text === '/help' || text === '/start') return HELP;

    if (text === '/new') {
      const existing = this.sessions.get(message.chatId);
      if (existing !== undefined) {
        await this.options.client.request('session.clear', { id: existing }).catch(() => {});
      }
      return 'Started a fresh conversation.';
    }

    if (text === '/status') {
      const id = this.sessions.get(message.chatId);
      if (id === undefined) return 'No conversation yet — send a message to start one.';
      const snapshot = await this.options.client.request<SessionSnapshot>('session.snapshot', {
        id,
      });
      return [
        `Model:  ${snapshot.providerName} · ${snapshot.model}`,
        `Turns:  ${snapshot.turnCount}`,
        `Tools:  ${snapshot.autoApprove ? 'auto-approved' : 'asked at a terminal'}`,
      ].join('\n');
    }

    return this.runModelTurn(message, text);
  }

  private async sessionFor(message: IncomingMessage): Promise<number> {
    const existing = this.sessions.get(message.chatId);
    if (existing !== undefined) return existing;

    const created = await this.options.client.request<SessionSnapshot>('session.create', {
      providerId: this.options.providerId,
      model: this.options.model,
      // The bridge has no directory of its own; tools run where the daemon was
      // started, which is the only honest answer for a chat with no cwd.
      cwd: process.cwd(),
      label: `${this.options.transport.id} ${message.chatId}`,
      autoApprove: this.options.allowTools ?? false,
    });
    this.sessions.set(message.chatId, created.id);
    await this.options.client.request('session.attach', { id: created.id });
    return created.id;
  }

  private async runModelTurn(message: IncomingMessage, text: string): Promise<null> {
    const sessionId = await this.sessionFor(message);

    // Posted immediately and edited as it arrives. A chat client has no
    // partial-message concept, so the alternative is a long silence and then a
    // wall of text — indistinguishable, while waiting, from a dead bot.
    const stream = createReplyStream(this.options.transport, message.chatId);
    let answer = '';
    const refusals: string[] = [];

    // Declared before the listener and assigned after prompt.send answers.
    // The listener has to be in place first — a turn that finishes quickly
    // would otherwise be over before anyone was watching for it.
    let turnId: string | undefined;

    const finished = new Promise<Extract<GatewayEvent, { kind: 'turn.finished' }>>((resolve) => {
      const stop = this.options.client.on((eventSessionId, event) => {
        if (eventSessionId !== sessionId) return;
        if (event.kind === 'text') {
          answer += event.delta;
          void stream.push(answer);
        }
        // The bridge cannot approve — it said so at connect — so this only
        // arrives to be counted, and the count is what the reply reports.
        if (event.kind === 'approval.resolved' && !event.approved) refusals.push('tool');
        if (event.kind === 'turn.finished' && event.turnId === turnId) {
          stop();
          resolve(event);
        }
      });
    });

    const accepted = await this.options.client.request<PromptAccepted>('prompt.send', {
      id: sessionId,
      text,
      surface: this.options.transport.id,
      who: message.senderName ?? message.senderId,
    });
    turnId = accepted.turnId;

    const result = await finished;
    if (!result.ok) {
      await stream.finish(`✖ ${result.error ?? 'The turn failed.'}`);
      return null;
    }

    const declined =
      refusals.length > 0 && !this.options.allowTools
        ? `\n\n⚠ ${refusals.length} tool request(s) were declined — ` +
          'nobody was at a terminal to approve them.'
        : '';
    await stream.finish(answer.trim() + declined);
    return null;
  }
}
