import chalk from 'chalk';
import type { ReplContext } from '../repl-context.js';
import { printConnectionLine } from '../../ui/banner.js';
import { assistantColor, errorColor, mutedColor } from '../../ui/theme.js';

export async function handleSession(ctx: ReplContext, arg?: string): Promise<void> {
  const [sub, ...rest] = (arg ?? '').split(' ').filter(Boolean);
  const sessions = ctx.sessions;

  if (!sub || sub === 'list') {
    for (const session of sessions.list()) {
      const marker = session.id === sessions.active.id ? assistantColor('▸') : ' ';
      const turns = session.history.filter((m) => m.role === 'user').length;
      console.log(
        `${marker} ${assistantColor(String(session.id))}  ${sessions.describe(session).padEnd(34)}` +
          mutedColor(`${turns} turn${turns === 1 ? '' : 's'}`)
      );
    }
    console.log(mutedColor('\nSwitch with /session <n>, open one with /session new.'));
    return;
  }

  if (sub === 'new') {
    try {
      const picked = await ctx.deps.pickProviderAndModel();
      const session = sessions.create(picked.provider, picked.model);
      console.log(chalk.gray(`Opened session ${session.id}.`));
      printConnectionLine(session.provider.name, session.model);
    } catch (err) {
      console.log(errorColor(`✖ ${(err as Error).message}`));
    }
    return;
  }

  if (sub === 'name') {
    const label = rest.join(' ');
    if (!label) {
      console.log(errorColor('✖ Usage: /session name <label>'));
      return;
    }
    sessions.active.label = label;
    console.log(chalk.gray(`Session ${sessions.active.id} is now "${label}".`));
    return;
  }

  if (sub === 'close') {
    // Defaults to the active session, which is what "close this" means.
    const id = rest[0] ? Number(rest[0]) : sessions.active.id;
    if (!Number.isInteger(id)) {
      console.log(errorColor('✖ Usage: /session close [n]'));
      return;
    }
    try {
      sessions.close(id);
      console.log(chalk.gray(`Closed session ${id}. Now in session ${sessions.active.id}.`));
      printConnectionLine(sessions.active.provider.name, sessions.active.model);
    } catch (err) {
      console.log(errorColor(`✖ ${(err as Error).message}`));
    }
    return;
  }

  const id = Number(sub);
  if (Number.isInteger(id)) {
    try {
      const session = sessions.switchTo(id);
      console.log(chalk.gray(`Session ${session.id}.`));
      printConnectionLine(session.provider.name, session.model);
    } catch (err) {
      console.log(errorColor(`✖ ${(err as Error).message}`));
    }
    return;
  }

  console.log(
    errorColor(`✖ Unknown /session subcommand "${sub}". Usage: /session [list|new|name|close|<n>]`)
  );
}
