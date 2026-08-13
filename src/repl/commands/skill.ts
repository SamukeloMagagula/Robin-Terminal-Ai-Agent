import chalk from 'chalk';
import type { ReplContext } from '../repl-context.js';
import type { SessionSnapshot } from '../../gateway/protocol.js';
import { assistantColor, errorColor, mutedColor } from '../../ui/theme.js';

/** Descriptions are what the model reads to decide; a truncated prompt is a poor one. */
function describeFromPrompt(prompt: string): string {
  const firstLine = prompt.split('\n').find((l) => l.trim()) ?? prompt;
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

export async function handleSkill(ctx: ReplContext, arg?: string): Promise<void> {
  const [sub, ...rest] = (arg ?? '').split(' ').filter(Boolean);
  const name = rest.join(' ');
  const store = ctx.stores.skill;

  if (!sub || sub === 'list') {
    const all = await store.list();
    if (all.length === 0) {
      console.log(mutedColor('No skills yet. Usage: /skill save <name>'));
      return;
    }
    for (const skill of all) {
      console.log(`  ${assistantColor(skill.name.padEnd(20))}${mutedColor(skill.description)}`);
    }
    console.log(mutedColor('\nApply one with /skill use <name>.'));
    return;
  }

  if (sub === 'save') {
    if (!name) {
      console.log(errorColor('✖ Usage: /skill save <name>'));
    } else if (!ctx.snapshot.systemPrompt) {
      console.log(errorColor('✖ No system prompt set. Set one with /system <text> first.'));
    } else {
      try {
        await store.write({
          name,
          description: describeFromPrompt(ctx.snapshot.systemPrompt),
          body: ctx.snapshot.systemPrompt,
        });
        console.log(chalk.gray(`Saved skill "${name}".`));
      } catch (err) {
        console.log(errorColor(`✖ ${(err as Error).message}`));
      }
    }
    return;
  }

  if (sub === 'use') {
    if (!name) {
      console.log(errorColor('✖ Usage: /skill use <name>'));
      return;
    }
    const skill = await store.read(name);
    if (!skill) {
      console.log(errorColor(`✖ No skill named "${name}".`));
      return;
    }
    ctx.snapshot = await ctx.client.request<SessionSnapshot>('session.update', {
      id: ctx.sessionId,
      patch: { systemPrompt: skill.body },
    });
    console.log(chalk.gray(`Using skill "${name}".`));
    return;
  }

  if (sub === 'forget') {
    if (!name) {
      console.log(errorColor('✖ Usage: /skill forget <name>'));
      return;
    }
    const removed = await store.forget(name);
    console.log(removed ? chalk.gray(`Forgot skill "${name}".`) : errorColor(`✖ No skill named "${name}".`));
    return;
  }

  if (sub === 'migrate') {
    const migrated = await store.migrate();
    if (migrated.length === 0) {
      console.log(mutedColor('Nothing to migrate — no legacy JSON presets found.'));
      return;
    }
    console.log(chalk.gray(`Converted ${migrated.length} preset(s): ${migrated.join(', ')}.`));
    console.log(
      mutedColor('The original .json files were left in place; delete them once you are happy.')
    );
    return;
  }

  console.log(
    errorColor(
      `✖ Unknown /skill subcommand "${sub}". Usage: /skill save|use|list|forget|migrate [name]`
    )
  );
}
