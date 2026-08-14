import { expand } from '@inquirer/prompts';
import { SkillStore } from '../skills/store.js';
import { parseFrontmatter } from '../frontmatter.js';
import {
  CATALOGUE_SOURCES,
  listCatalogue,
  fetchSkillBody,
  localNameFor,
} from '../skills/catalogue.js';
import { assistantColor, mutedColor, errorColor, divider } from '../ui/theme.js';

function describeSources(): string {
  return Object.entries(CATALOGUE_SOURCES)
    .map(([name, source]) => `  ${assistantColor(name.padEnd(10))}${mutedColor(source.description)}`)
    .join('\n');
}

/** Lists what a catalogue offers, optionally narrowed by a substring. */
export async function runSkillList(source?: string, filter?: string): Promise<void> {
  if (!source) {
    console.log(assistantColor('Skill catalogues'));
    console.log(divider());
    console.log(describeSources());
    console.log(mutedColor('\nList one with `robin skill list <source> [filter]`.'));
    return;
  }

  const entries = await listCatalogue(source);
  const term = filter?.toLowerCase();
  const shown = term ? entries.filter((e) => e.name.toLowerCase().includes(term)) : entries;

  console.log(assistantColor(`${source} — ${shown.length} of ${entries.length} skill(s)`));
  console.log(divider());
  for (const entry of shown) console.log(`  ${entry.name}`);
  if (shown.length === 0) {
    console.log(mutedColor('  Nothing matched. Try a different filter, or omit it.'));
  }
  console.log(mutedColor(`\nInstall with \`robin skill add ${source} <name>\`.`));
}

/**
 * Installs named skills from a catalogue.
 *
 * A skill is standing instructions that shape every later session, so the user
 * sees what is about to be written and agrees to it. Fetching from a public
 * repository is exactly the case where that matters: nobody reviewed these on
 * the way in.
 */
export async function runSkillAdd(source: string, names: string[]): Promise<void> {
  if (names.length === 0) {
    console.log(errorColor('✖ Usage: robin skill add <source> <name>...'));
    return;
  }

  const entries = await listCatalogue(source);
  const wanted = names.map((name) => {
    const entry = entries.find((e) => e.name === name);
    if (!entry) {
      throw new Error(
        `"${name}" is not in the ${source} catalogue. ` +
          `Run \`robin skill list ${source} ${name}\` to find it.`
      );
    }
    return entry;
  });

  console.log(mutedColor(`About to install ${wanted.length} skill(s) from ${source}:`));
  for (const entry of wanted) {
    console.log(`  ${assistantColor(localNameFor(source, entry.name))} ${mutedColor(entry.path)}`);
  }
  console.log(
    mutedColor(
      '\nA skill is a standing instruction set — it is added to the model’s context\n' +
        'in every later session. These come from a public repository.'
    )
  );

  const answer = await expand<'yes' | 'no'>({
    message: 'Install them?',
    default: 'n',
    choices: [
      { key: 'y', name: 'yes', value: 'yes' },
      { key: 'n', name: 'no', value: 'no' },
    ],
  });
  if (answer !== 'yes') {
    console.log(mutedColor('Nothing installed.'));
    return;
  }

  const store = new SkillStore();
  let installed = 0;
  for (const entry of wanted) {
    try {
      const raw = await fetchSkillBody(source, entry.path);
      // A published SKILL.md without frontmatter is still a skill; its body is
      // the instructions, and the catalogue name stands in for the description.
      const parsed = parseFrontmatter(raw);
      const name = localNameFor(source, entry.name);
      await store.write({
        name,
        description: parsed?.fields.description?.trim() || entry.name,
        body: (parsed?.body ?? raw).trim(),
      });
      console.log(`  ${assistantColor('✓')} ${name}`);
      installed += 1;
    } catch (err) {
      // One bad skill must not abandon the rest of the batch.
      console.log(`  ${errorColor('✖')} ${entry.name} — ${(err as Error).message}`);
    }
  }

  console.log(
    installed > 0
      ? mutedColor(`\nInstalled ${installed}. They are offered from the next turn.`)
      : errorColor('\nNothing was installed.')
  );
}
