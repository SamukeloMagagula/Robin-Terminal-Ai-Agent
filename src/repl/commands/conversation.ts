import chalk from 'chalk';
import type { ReplContext } from '../repl-context.js';
import type { Message } from '../../providers/types.js';
import type { SessionSnapshot } from '../../gateway/protocol.js';
import { copyToClipboard } from '../../clipboard.js';
import { printConnectionLine } from '../../ui/banner.js';
import { errorColor, mutedColor } from '../../ui/theme.js';

/**
 * 2J wipes the visible screen, 3J wipes the scrollback buffer, H homes the
 * cursor. 3J matters: without it the cleared conversation is still one scroll
 * wheel away, which defeats the point of clearing it.
 */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** The conversation as the gateway currently holds it. */
async function history(ctx: ReplContext): Promise<Message[]> {
  const result = await ctx.client.request<{ history: Message[] }>('session.history', {
    id: ctx.sessionId,
  });
  return result.history;
}

export async function handleClear(ctx: ReplContext): Promise<void> {
  // The gateway resets the turn count with the history: the memory nudge exists
  // to catch what was learned in *this* exchange, so carrying the count across
  // a clear would fire it on turn one of an unrelated one.
  ctx.snapshot = await ctx.client.request<SessionSnapshot>('session.clear', {
    id: ctx.sessionId,
  });
  process.stdout.write(CLEAR_SCREEN);
  // Reprinted after the wipe, because clearing the screen also removes the
  // connection line — leaving no on-screen record of which model is answering.
  printConnectionLine(ctx.snapshot.providerName, ctx.snapshot.model);
  console.log(chalk.gray('Conversation cleared.'));
}

export async function handleCopy(ctx: ReplContext): Promise<void> {
  const lastReply = [...(await history(ctx))]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content);
  if (!lastReply) {
    console.log(chalk.gray('Nothing to copy yet.'));
    return;
  }
  try {
    await copyToClipboard(lastReply.content);
    console.log(chalk.gray('Copied last reply to clipboard.'));
  } catch (err) {
    console.log(errorColor(`✖ Could not copy to clipboard: ${(err as Error).message}`));
  }
}

export async function handleSave(ctx: ReplContext, arg?: string): Promise<void> {
  if (!arg) {
    const names = await ctx.stores.conversation.list();
    console.log(
      names.length
        ? mutedColor(names.join(', '))
        : mutedColor('No saved conversations yet. Usage: /save <name>')
    );
    return;
  }
  try {
    await ctx.stores.conversation.save(arg, {
      providerId: ctx.snapshot.providerId,
      providerName: ctx.snapshot.providerName,
      model: ctx.snapshot.model,
      savedAt: new Date().toISOString(),
      messages: await history(ctx),
    });
    console.log(chalk.gray(`Saved conversation as "${arg}".`));
  } catch (err) {
    console.log(errorColor(`✖ ${(err as Error).message}`));
  }
}

export async function handleLoad(ctx: ReplContext, arg?: string): Promise<void> {
  if (!arg) {
    const names = await ctx.stores.conversation.list();
    console.log(
      names.length
        ? mutedColor(names.join(', '))
        : mutedColor('No saved conversations yet. Usage: /load <name>')
    );
    return;
  }
  try {
    const saved = await ctx.stores.conversation.load(arg);
    // The gateway starts a new transcript for it: a loaded conversation is a
    // different conversation, not a continuation of whatever was open.
    ctx.snapshot = await ctx.client.request<SessionSnapshot>('session.setHistory', {
      id: ctx.sessionId,
      messages: saved.messages,
    });
    console.log(
      chalk.gray(`Loaded conversation "${arg}" (saved on ${saved.providerName} · ${saved.model}).`)
    );
  } catch (err) {
    console.log(errorColor(`✖ Could not load "${arg}": ${(err as Error).message}`));
  }
}
