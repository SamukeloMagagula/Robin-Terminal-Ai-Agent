import type { GatewayEvent } from '../gateway/protocol.js';

export interface EventOutput {
  /** The assistant's reply, written as it streams. */
  text(chunk: string): void;
  /** Anything the user should see but did not ask the model for. */
  muted(line: string): void;
  error(line: string): void;
  connectionChanged(providerName: string, model: string): void;
}

/**
 * Thousands separators, the same on every machine.
 *
 * Not `toLocaleString`: on an en-ZA machine that returns "1 234" with a
 * non-breaking space, which is both a surprise in a terminal and a reason for
 * the same code to print differently for two people.
 */
export function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Turns one gateway event into terminal output.
 *
 * Split out of run-repl so it can be tested without a socket or a TTY. The
 * approval events are deliberately not handled here: they need a prompt, not a
 * line of output, and the prompt has to be cancellable when another client
 * answers first.
 */
export function renderEvent(event: GatewayEvent, out: EventOutput): void {
  switch (event.kind) {
    case 'text':
      out.text(event.delta);
      return;
    case 'thinking':
      out.muted(event.delta);
      return;
    case 'tool.auto_approved':
      out.muted(`\n  $ ${event.command}`);
      return;
    case 'tool.output':
      out.muted(event.chunk);
      return;
    case 'fallback':
      out.muted(`\n  ${event.message} — trying ${event.providerName} · ${event.model}...`);
      return;
    case 'trim':
      out.muted(
        `\n  Dropped the oldest ${event.dropped} message(s) to fit ${event.limit} tokens. ` +
          '/clear starts fresh.'
      );
      return;
    case 'session.changed':
      out.connectionChanged(event.snapshot.providerName, event.snapshot.model);
      return;
    case 'turn.finished':
      if (event.aborted) out.muted('Interrupted. Your next message continues from here.');
      else if (!event.ok) out.error(`\n✖ ${event.error ?? 'The turn failed.'}`);
      // Only when the provider actually said. Printing "0 tokens" for a model
      // that reports nothing would be a number someone could act on wrongly.
      else if (event.tokens) {
        out.muted(`\n  ${grouped(event.tokens.input)} in · ${grouped(event.tokens.output)} out`);
      }
      return;
    default:
      // turn.started and the approval events are the caller's business.
      return;
  }
}
