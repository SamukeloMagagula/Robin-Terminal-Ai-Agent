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

export async function handleSkill(ctx: ReplContext, arg?: string): Promise<void> {
  const [sub, ...rest] = (arg ?? '').split(' ').filter(Boolean);
  const name = rest.join(' ');

  if (!sub || sub === 'list') {
    const names = await ctx.stores.skill.list();
    console.log(
      names.length
        ? mutedColor(names.join(', '))
        : mutedColor('No saved skills yet. Usage: /skill save <name>')
    );
  } else if (sub === 'save') {
    if (!name) {
      console.log(errorColor('✖ Usage: /skill save <name>'));
    } else if (!ctx.session.systemPrompt) {
      console.log(errorColor('✖ No system prompt set. Set one with /system <text> first.'));
    } else {
      try {
        await ctx.stores.skill.save(name, {
          prompt: ctx.session.systemPrompt,
          savedAt: new Date().toISOString(),
        });
        console.log(chalk.gray(`Saved skill "${name}".`));
      } catch (err) {
        console.log(errorColor(`✖ ${(err as Error).message}`));
      }
    }
  } else if (sub === 'use') {
    if (!name) {
      console.log(errorColor('✖ Usage: /skill use <name>'));
    } else {
      try {
        const skill = await ctx.stores.skill.load(name);
        ctx.session.systemPrompt = skill.prompt;
        console.log(chalk.gray(`Using skill "${name}".`));
      } catch (err) {
        console.log(errorColor(`✖ Could not load "${name}": ${(err as Error).message}`));
      }
    }
  } else {
    console.log(
      errorColor(`✖ Unknown /skill subcommand "${sub}". Usage: /skill save|use|list [name]`)
    );
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
