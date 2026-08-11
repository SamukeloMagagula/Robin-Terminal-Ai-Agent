import type { ReplContext } from '../repl-context.js';
import { assistantColor, errorColor, mutedColor } from '../../ui/theme.js';

export async function handleMemory(ctx: ReplContext, arg?: string): Promise<void> {
  const [sub, ...rest] = (arg ?? '').split(' ').filter(Boolean);
  const name = rest.join(' ');
  const store = ctx.stores.memory;

  if (sub === 'forget') {
    if (!name) {
      console.log(errorColor('✖ Usage: /memory forget <name>'));
      return;
    }
    const removed = await store.forget(name);
    console.log(removed ? mutedColor(`Forgot "${name}".`) : errorColor(`✖ No memory named "${name}".`));
    return;
  }

  if (sub === 'show') {
    if (!name) {
      console.log(errorColor('✖ Usage: /memory show <name>'));
      return;
    }
    const memory = await store.read(name);
    if (!memory) {
      console.log(errorColor(`✖ No memory named "${name}".`));
      return;
    }
    console.log(assistantColor(`${memory.name} (${memory.type})`));
    console.log(mutedColor(memory.description));
    console.log(`\n${memory.body}`);
    return;
  }

  if (sub && sub !== 'list') {
    console.log(errorColor(`✖ Unknown /memory subcommand "${sub}". Usage: /memory [list|show|forget]`));
    return;
  }

  const all = await store.list();
  if (all.length === 0) {
    console.log(mutedColor('No memories yet. Robin writes them itself as it learns things.'));
    return;
  }

  // Marking what is actually in the prompt matters: over the cap, older
  // entries stay on disk but stop being sent, and that is invisible otherwise.
  const index = await store.index();
  for (const memory of all) {
    const inPrompt = index.includes(`- ${memory.name} (`);
    const marker = inPrompt ? ' ' : mutedColor('·');
    console.log(`${marker} ${assistantColor(memory.name.padEnd(24))}${mutedColor(memory.description)}`);
  }
  const omitted = all.filter((m) => !index.includes(`- ${m.name} (`)).length;
  if (omitted > 0) {
    console.log(
      mutedColor(`\n· ${omitted} older entr${omitted === 1 ? 'y is' : 'ies are'} on disk but no longer sent with each turn.`)
    );
  }
  console.log(mutedColor(`\nStored in ~/.robin/memory/. Remove one with /memory forget <name>.`));
}
