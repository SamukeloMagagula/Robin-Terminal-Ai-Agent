const OPEN = '<final_answer>';
const CLOSE = '</final_answer>';

/** True when `text` could still grow into `tag` — i.e. it is a prefix of it. */
function couldBecome(text: string, tag: string): boolean {
  return tag.startsWith(text);
}

/** How much of the end of `text` might be the start of `tag`. */
function danglingPrefixLength(text: string, tag: string): number {
  const most = Math.min(text.length, tag.length - 1);
  for (let length = most; length > 0; length--) {
    if (tag.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/**
 * Trims the wrapper's own padding without touching the answer's shape.
 *
 * Leading whitespace only until the answer has actually started, and trailing
 * whitespace only once it has ended — a blank line in the middle of a reply is
 * the model's paragraph break, not padding.
 */
function trimInside(text: string, alreadyEmitted: boolean, atEnd: boolean): string {
  let out = alreadyEmitted ? text : text.trimStart();
  if (atEnd) out = out.trimEnd();
  return out;
}

export interface AnswerUnwrapper {
  /** Returns the part of this chunk that is safe to show now. */
  push(chunk: string): string;
  /** Returns whatever was held back, once the reply is over. */
  end(): string;
}

/**
 * Strips the `<final_answer>` wrapper some models put around every reply.
 *
 * Search-style models on Copilot — `copilot-search-a`, `gpt-5.4` — return
 * `<final_answer>\npong\n</final_answer>` for a one-word question, and shown
 * raw that is markup where the answer should be.
 *
 * Two rules keep this from mangling honest text:
 *
 * 1. Only a wrapper at the very start of a reply is stripped. A model that
 *    mentions the tag while explaining it is left alone, because by then the
 *    reply has already begun with something else.
 * 2. Text after the closing tag is kept. If a model closes the wrapper and
 *    keeps talking, that is still the answer.
 *
 * It works on a stream, which is the only reason it is a state machine rather
 * than a regex: holding the whole reply back to match against it would turn
 * streaming into a pause and then a wall of text.
 */
export function createAnswerUnwrapper(): AnswerUnwrapper {
  // 'deciding'   — still working out whether this reply opens with the wrapper
  // 'stripping'  — inside a wrapper; watching for the closing tag
  // 'passthrough'— definitely not wrapped, or already unwrapped
  let state: 'deciding' | 'stripping' | 'passthrough' = 'deciding';
  let held = '';
  /** Whether anything has been emitted from inside the wrapper yet. */
  let emittedInside = false;

  return {
    push(chunk: string): string {
      if (state === 'passthrough') return chunk;

      held += chunk;

      if (state === 'deciding') {
        // Leading whitespace is not yet evidence either way.
        const trimmed = held.trimStart();
        if (trimmed.length === 0) return '';

        if (trimmed.startsWith(OPEN)) {
          state = 'stripping';
          held = trimmed.slice(OPEN.length);
        } else if (couldBecome(trimmed, OPEN)) {
          // Could still turn into the opening tag; wait for more.
          return '';
        } else {
          state = 'passthrough';
          const out = held;
          held = '';
          return out;
        }
      }

      // state === 'stripping': emit everything that cannot be part of a
      // closing tag, and keep the rest until we know.
      const closeAt = held.indexOf(CLOSE);
      if (closeAt !== -1) {
        state = 'passthrough';
        // The newlines a model puts either side of the answer belong to the
        // wrapper's formatting, not to what it said.
        const inside = trimInside(held.slice(0, closeAt), emittedInside, true);
        const after = held.slice(closeAt + CLOSE.length);
        held = '';
        return inside + after;
      }
      const dangling = danglingPrefixLength(held, CLOSE);
      let keepFrom = held.length - dangling;
      // Trailing whitespace is held back too: it may be the newline a model
      // puts before its closing tag, and once emitted it cannot be taken back.
      // If real text follows instead, it goes out with the next chunk.
      const padding = /\s+$/.exec(held.slice(0, keepFrom));
      if (padding) keepFrom -= padding[0].length;

      const out = trimInside(held.slice(0, keepFrom), emittedInside, false);
      held = held.slice(keepFrom);
      if (out.length > 0) emittedInside = true;
      return out;
    },

    end(): string {
      const rest = held;
      held = '';
      if (state === 'deciding') {
        // The whole reply was shorter than the opening tag, so it was never a
        // wrapper — a partial tag is what the model actually said.
        state = 'passthrough';
        return rest;
      }
      // A stream can be cut off mid-wrapper; whatever is left is the answer,
      // minus a closing tag if that is how it ended.
      const withoutClose = rest.endsWith(CLOSE) ? rest.slice(0, -CLOSE.length) : rest;
      return state === 'stripping'
        ? trimInside(withoutClose, emittedInside, true)
        : withoutClose;
    },
  };
}
