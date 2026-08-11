import chalk from 'chalk';
import type { Provider } from '../../providers/types.js';
import type { ReplContext } from '../repl-context.js';
import { printConnectionLine } from '../../ui/banner.js';
import { environmentPrompt } from '../../environment-prompt.js';
import { TOOL_DEFINITIONS } from '../../tools/definitions.js';
import { assistantColor, errorColor, mutedColor } from '../../ui/theme.js';

/**
 * A connection switch resets the conversation and starts a new transcript.
 * The model on the other side has not seen any of it, so keeping the history
 * would silently replay someone else's conversation as if it were its own.
 *
 * Mutates `ctx.session` rather than replacing it — the context object is built
 * once and holds this exact reference.
 */
function applyConnectionChange(ctx: ReplContext, provider: Provider, model: string): void {
  ctx.session.provider = provider;
  ctx.session.model = model;
  ctx.session.history = [];
  ctx.session.chatLog.startNewSession();
  printConnectionLine(provider.name, model);
}

export async function handleModel(ctx: ReplContext): Promise<void> {
  const model = await ctx.deps.pickModel(ctx.session.provider);
  applyConnectionChange(ctx, ctx.session.provider, model);
}

export async function handleProvider(ctx: ReplContext): Promise<void> {
  const picked = await ctx.deps.pickProviderAndModel();
  applyConnectionChange(ctx, picked.provider, picked.model);
}

export async function handleRandom(ctx: ReplContext): Promise<void> {
  // A re-roll is a provider switch, so it resets history and starts a new
  // transcript exactly like /model and /provider do.
  try {
    const rolled = await ctx.deps.rollRandom();
    applyConnectionChange(ctx, rolled.provider, rolled.model);
  } catch (err) {
    console.log(errorColor(`✖ ${(err as Error).message}`));
  }
}

export async function handleSystem(ctx: ReplContext, arg?: string): Promise<void> {
  if (!arg) {
    console.log(
      ctx.session.systemPrompt
        ? mutedColor(ctx.session.systemPrompt)
        : mutedColor('No system prompt set. Usage: /system <text>  or  /system clear')
    );
    console.log(mutedColor(`\nAlways sent:\n${environmentPrompt()}`));
  } else if (arg === 'clear') {
    ctx.session.systemPrompt = undefined;
    console.log(chalk.gray('System prompt cleared.'));
  } else {
    ctx.session.systemPrompt = arg;
    console.log(chalk.gray('System prompt set.'));
  }
}

export async function handleTools(ctx: ReplContext, arg?: string): Promise<void> {
  if (arg === 'list') {
    for (const tool of TOOL_DEFINITIONS) {
      console.log(`  ${assistantColor(tool.name.padEnd(14))}${mutedColor(tool.description)}`);
    }
    return;
  }
  ctx.session.toolsEnabled = !ctx.session.toolsEnabled;
  console.log(chalk.gray(`Tools ${ctx.session.toolsEnabled ? 'enabled' : 'disabled'}.`));
}
