/**
 * The transport-agnostic half of remote control: access, sessions, commands
 * and the agent turn. Everything here works identically for Telegram,
 * WhatsApp or Teams — only ChannelTransport differs between them.
 */

import type { Provider } from '../providers/types.js';
import type { ChannelTransport, IncomingMessage } from './types.js';
import { checkAccess } from './access.js';
import { createSession, type Session } from '../repl/session.js';
import { runTurn } from '../repl/run-turn.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { MemoryStore } from '../memory/store.js';
import { SkillStore } from '../skills/store.js';
import type { ConfirmRequest } from '../tools/execute.js';

export interface BridgeOptions {
  transport: ChannelTransport;
  provider: Provider;
  model: string;
  allowlist: string[];
  /**
   * Whether tool calls that would prompt in the REPL may run unattended.
   *
   * Default false, and that default matters more than any other setting here.
   * The interactive gate exists because the model asks to run commands and
   * write files; over a chat channel there is nobody at the keyboard to read
   * the request, so "approve everything" would turn a chat message into
   * unattended code execution on the operator's machine. Read-only commands
   * are unaffected — those never reach the gate.
   */
  allowTools?: boolean;
  /** Injectable for tests. */
  stores?: {
    unsupported?: UnsupportedModelStore;
    memory?: MemoryStore;
    skills?: SkillStore;
  };
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
  private readonly sessions = new Map<string, Session>();
  /**
   * One promise chain per chat. Two messages arriving while a turn is in
   * flight would otherwise both mutate the same history array concurrently and
   * interleave into nonsense.
   */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly unsupported: UnsupportedModelStore;
  private readonly memory: MemoryStore;
  private readonly skills: SkillStore;
  private readonly log: (line: string) => void;

  constructor(private readonly options: BridgeOptions) {
    this.unsupported = options.stores?.unsupported ?? new UnsupportedModelStore();
    this.memory = options.stores?.memory ?? new MemoryStore();
    this.skills = options.stores?.skills ?? new SkillStore();
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
    this.log(`Answering ${this.options.allowlist.length} allowed sender(s) via ${this.options.provider.name} · ${this.options.model}`);
    this.log(
      this.options.allowTools
        ? 'Tool approvals: AUTO-APPROVED — commands and writes will run unattended.'
        : 'Tool approvals: denied (read-only work only). Pass --allow-tools to change this.'
    );

    await this.options.transport.receive((message) => this.enqueue(message), signal);
  }

  /** Serialises handling per chat while returning immediately to the poll loop. */
  private enqueue(message: IncomingMessage): Promise<void> {
    const previous = this.queues.get(message.chatId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.handle(message));
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

    const reply = await this.respond(message.chatId, text);
    if (reply) await this.options.transport.send(message.chatId, reply);
  }

  private async respond(chatId: string, text: string): Promise<string | null> {
    if (text === '/help' || text === '/start') return HELP;

    if (text === '/new') {
      this.sessions.delete(chatId);
      return 'Started a fresh conversation.';
    }

    if (text === '/status') {
      const session = this.sessions.get(chatId);
      return [
        `Model:  ${this.options.provider.name} · ${this.options.model}`,
        `Turns:  ${session?.turnCount ?? 0}`,
        `Tools:  ${this.options.allowTools ? 'auto-approved' : 'read-only'}`,
      ].join('\n');
    }

    return this.runModelTurn(chatId, text);
  }

  private sessionFor(chatId: string): Session {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = createSession(this.options.provider, this.options.model);
      this.sessions.set(chatId, session);
    }
    return session;
  }

  private async runModelTurn(chatId: string, text: string): Promise<string> {
    const session = this.sessionFor(chatId);
    // Collected rather than streamed: chat clients have no partial-message
    // concept, and editing a message per token would burn through Telegram's
    // rate limit within one reply.
    let answer = '';
    const refusals: string[] = [];

    const result = await runTurn(session, text, {
      onText: (chunk) => {
        answer += chunk;
      },
      confirm: async (request: ConfirmRequest) => {
        if (this.options.allowTools) return true;
        refusals.push(request.kind);
        return false;
      },
      unsupportedStore: this.unsupported,
      memory: this.memory,
      skills: this.skills,
    });

    if (!result.ok) {
      return `✖ ${result.error?.message ?? 'The turn failed.'}`;
    }

    const trimmed = answer.trim();
    const body = trimmed || '(no reply)';
    if (refusals.length > 0 && !this.options.allowTools) {
      const kinds = [...new Set(refusals)].join(', ');
      return `${body}\n\n⚠ Declined ${refusals.length} tool request(s) (${kinds}) — this bridge is running read-only.`;
    }
    return body;
  }
}
