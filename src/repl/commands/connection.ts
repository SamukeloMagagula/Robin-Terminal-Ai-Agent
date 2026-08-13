import chalk from 'chalk';
import type { ReplContext } from '../repl-context.js';
import type { SessionSnapshot } from '../../gateway/protocol.js';
import { environmentPrompt } from '../../environment-prompt.js';
import { TOOL_DEFINITIONS } from '../../tools/definitions.js';
import { assistantColor, errorColor, mutedColor } from '../../ui/theme.js';

/**
 * Asks the gateway to change the session, and remembers what it said back.
 *
 * The connection line is not printed here: the gateway emits session.changed
 * to every attached client, and run-repl prints it from there. Printing it
 * locally as well would double it up for the terminal that made the change.
 */
async function patchSession(
  ctx: ReplContext,
  patch: Record<string, unknown>
): Promise<void> {
  ctx.snapshot = await ctx.client.request<SessionSnapshot>('session.update', {
    id: ctx.sessionId,
    patch,
  });
}

export async function handleModel(ctx: ReplContext): Promise<void> {
  const model = await ctx.deps.pickModel(ctx.deps.provider);
  await patchSession(ctx, { model });
}

export async function handleProvider(ctx: ReplContext): Promise<void> {
  const picked = await ctx.deps.pickProviderAndModel();
  await patchSession(ctx, { providerId: picked.provider.id, model: picked.model });
}

export async function handleRandom(ctx: ReplContext): Promise<void> {
  // A re-roll is a provider switch, so the gateway resets history and starts a
  // new transcript exactly as /model and /provider do.
  try {
    const rolled = await ctx.deps.rollRandom();
    await patchSession(ctx, { providerId: rolled.provider.id, model: rolled.model });
  } catch (err) {
    console.log(errorColor(`✖ ${(err as Error).message}`));
  }
}

export async function handleSystem(ctx: ReplContext, arg?: string): Promise<void> {
  if (!arg) {
    console.log(
      ctx.snapshot.systemPrompt
        ? mutedColor(ctx.snapshot.systemPrompt)
        : mutedColor('No system prompt set. Usage: /system <text>  or  /system clear')
    );
    console.log(mutedColor(`\nAlways sent:\n${environmentPrompt()}`));
  } else if (arg === 'clear') {
    // null clears it. undefined would mean "leave it alone" once this is a
    // patch travelling over a wire.
    await patchSession(ctx, { systemPrompt: null });
    console.log(chalk.gray('System prompt cleared.'));
  } else {
    await patchSession(ctx, { systemPrompt: arg });
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
  // Sends the state it wants rather than a toggle: two clients toggling one
  // session would otherwise race, and the gateway is the source of truth for
  // what the value currently is.
  await patchSession(ctx, { toolsEnabled: !ctx.snapshot.toolsEnabled });
  console.log(chalk.gray(`Tools ${ctx.snapshot.toolsEnabled ? 'enabled' : 'disabled'}.`));
}
