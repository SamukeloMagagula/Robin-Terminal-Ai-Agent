import { expand } from '@inquirer/prompts';
import type { ReplContext } from '../repl-context.js';
import { discoverPersonality, type Personality } from '../../personality.js';
import type { PersonalityTrustStore } from '../../personality-trust.js';
import { assistantColor, mutedColor, box } from '../../ui/theme.js';

/**
 * Personality files the user has agreed to, joined into one block.
 *
 * The global file is never prompted for: the user wrote it, and asking about
 * one's own config is the noise that trains people to approve without reading.
 * Project files are a different matter — they arrive with cloned repositories.
 */
export async function loadPersonality(
  trustStore: PersonalityTrustStore,
  cwd: string = process.cwd()
): Promise<{ text?: string; sources: Personality[] }> {
  const found = await discoverPersonality(cwd);
  const accepted: Personality[] = [];

  for (const personality of found) {
    if (personality.scope === 'global') {
      accepted.push(personality);
      continue;
    }
    if (await trustStore.isTrusted(personality.source, personality.content)) {
      accepted.push(personality);
      continue;
    }
    if (await promptToTrust(trustStore, personality)) {
      accepted.push(personality);
    }
  }

  return {
    text: accepted.length ? accepted.map((p) => p.content).join('\n\n') : undefined,
    sources: accepted,
  };
}

async function promptToTrust(
  trustStore: PersonalityTrustStore,
  personality: Personality
): Promise<boolean> {
  console.log(`\n${mutedColor(`Found ${personality.source}:`)}`);
  console.log(box(personality.content.split('\n')));
  console.log(
    mutedColor(
      'This becomes part of the system prompt, for a tool that can run commands and read files.'
    )
  );

  const answer = await expand<'yes' | 'no' | 'always'>({
    message: 'Use this personality?',
    default: 'n',
    choices: [
      { key: 'y', name: 'yes, this version of the file', value: 'yes' },
      { key: 'n', name: 'no', value: 'no' },
      {
        key: 'a',
        name: 'yes, and trust this file from now on even if it changes',
        value: 'always',
      },
    ],
  });

  if (answer === 'yes') {
    await trustStore.trustContent(personality.source, personality.content);
    return true;
  }
  if (answer === 'always') {
    await trustStore.trustPath(personality.source);
    return true;
  }
  return false;
}

export async function handlePersonality(ctx: ReplContext, arg?: string): Promise<void> {
  if (arg === 'off') {
    // null clears it; undefined would mean "leave it alone" in a patch.
    await ctx.client.request('session.update', {
      id: ctx.sessionId,
      patch: { personality: null },
    });
    console.log(mutedColor('Personality dropped for this session.'));
    return;
  }

  if (arg === 'reload') {
    const { text, sources } = await loadPersonality(ctx.stores.personalityTrust);
    await ctx.client.request('session.update', {
      id: ctx.sessionId,
      patch: { personality: text ?? null },
    });
    console.log(
      sources.length
        ? mutedColor(`Reloaded from ${sources.map((s) => s.source).join(', ')}.`)
        : mutedColor('No personality files found.')
    );
    return;
  }

  const { personality } = await ctx.client.request<{ personality?: string }>(
    'session.history',
    { id: ctx.sessionId }
  );
  if (!personality) {
    console.log(mutedColor('No personality loaded. Create a PERSONALITY.md here, or in ~/.robin/.'));
    return;
  }

  console.log(assistantColor('Active personality:'));
  console.log(mutedColor(personality));
}
