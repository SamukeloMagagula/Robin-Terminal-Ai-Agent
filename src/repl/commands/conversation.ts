import chalk from 'chalk';
import type { ReplContext } from '../repl-context.js';
import { copyToClipboard } from '../../clipboard.js';
import { printConnectionLine } from '../../ui/banner.js';
import { errorColor, mutedColor } from '../../ui/theme.js';

/**
 * 2J wipes the visible screen, 3J wipes the scrollback buffer, H homes the
 * cursor. 3J matters: without it the cleared conversation is still one scroll
 * wheel away, which defeats the point of clearing it.
 */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

export async function handleClear(ctx: ReplContext): Promise<void> {
  ctx.session.history = [];
  // Resets the memory nudge with the conversation: the nudge exists to catch
  // what was learned in *this* exchange, so carrying the count across a clear
  // would fire it on turn one of an unrelated one.
  ctx.session.turnCount = 0;
  ctx.session.chatLog.startNewSession();
  process.stdout.write(CLEAR_SCREEN);
  // Reprinted after the wipe, because clearing the screen also removes the
  // connection line — leaving no on-screen record of which model is answering.
  printConnectionLine(ctx.session.provider.name, ctx.session.model);
  console.log(chalk.gray('Conversation cleared.'));
}

export async function handleCopy(ctx: ReplContext): Promise<void> {
  const lastReply = [...ctx.session.history]
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
      providerId: ctx.session.provider.id,
      providerName: ctx.session.provider.name,
      model: ctx.session.model,
      savedAt: new Date().toISOString(),
      messages: ctx.session.history,
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
    ctx.session.history = saved.messages;
    ctx.session.chatLog.startNewSession();
    console.log(
      chalk.gray(`Loaded conversation "${arg}" (saved on ${saved.providerName} · ${saved.model}).`)
    );
  } catch (err) {
    console.log(errorColor(`✖ Could not load "${arg}": ${(err as Error).message}`));
  }
}
