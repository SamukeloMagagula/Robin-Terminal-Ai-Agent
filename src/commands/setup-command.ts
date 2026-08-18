/**
 * `robin setup` — the first run, and nothing more.
 *
 * The wizard owns no logic of its own: logging in, listing models and checking
 * reachability all already exist, and duplicating any of them here would mean
 * two places to fix when a provider changes. What is genuinely new is the
 * sequencing, and the rule that a failure anywhere in it writes nothing — a
 * stored default pointing at a provider you never finished logging into is
 * worse than no default at all, because `robin chat` would then fail every
 * time with no hint that setup was the cause.
 *
 * Everything it depends on arrives through SetupDeps so the sequence can be
 * tested without a terminal attached.
 */

import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { mutedColor } from '../ui/theme.js';
import { pickFromChoices, toChoices } from '../ui/model-picker.js';
import { runLogin } from './auth-commands.js';
import { listProviders } from '../providers/index.js';
import { SettingsStore } from '../settings/store.js';
import { UserFacingError } from '../startup/bootstrap.js';
import type { Provider } from '../providers/types.js';

type Out = (line: string) => void;

export interface SetupPrompts {
  chooseProvider(providers: Provider[], current?: string): Promise<Provider>;
  chooseModel(models: string[], current?: string): Promise<string>;
}

export interface SetupDeps {
  providers: Provider[];
  store: SettingsStore;
  prompts: SetupPrompts;
  login(provider: Provider): Promise<void>;
  /** One real turn, to prove the pair actually answers before it is stored. */
  verify(provider: Provider, model: string): Promise<void>;
  out: Out;
}

/**
 * Providers that need no account first.
 *
 * Someone running `robin setup` for the first time may have no API key for
 * anything, and offering a route that works in under a minute is more useful
 * than alphabetical order. Everything else keeps the order it was given.
 */
const NO_ACCOUNT_NEEDED = ['ollama', 'local'];

export function orderForSetup(providers: Provider[]): Provider[] {
  const rank = (p: Provider): number => {
    const index = NO_ACCOUNT_NEEDED.indexOf(p.id);
    return index === -1 ? NO_ACCOUNT_NEEDED.length : index;
  };
  return [...providers].sort((a, b) => rank(a) - rank(b));
}

export async function runSetup(deps: SetupDeps): Promise<void> {
  const { store, prompts, out } = deps;

  const currentProvider = String(await store.get('default.provider')) || undefined;
  const currentModel = String(await store.get('default.model')) || undefined;

  const provider = await prompts.chooseProvider(orderForSetup(deps.providers), currentProvider);

  if (!(await provider.isAuthenticated())) {
    out(mutedColor(`Logging in to ${provider.name}...`));
    await deps.login(provider);
  }

  const models = await provider.listModels();
  if (models.length === 0) {
    throw new UserFacingError(
      `${provider.name} reported no models. Check it is running and reachable, then run \`robin setup\` again.`
    );
  }

  const model = await prompts.chooseModel(models, currentModel);

  out(mutedColor(`Checking ${provider.name} answers with ${model}...`));
  await deps.verify(provider, model);

  // Only now, with every step proven, is anything persisted.
  await store.set('default.provider', provider.id);
  await store.set('default.model', model);

  out('');
  out(`${chalk.green('✓')} ${provider.name} · ${model} saved as your default.`);
  out(mutedColor('Start talking with `robin chat`. Change it later with `robin config set default.model <name>`.'));
}

/** Sends the shortest possible prompt and insists on getting something back. */
async function verifyWithTurn(provider: Provider, model: string): Promise<void> {
  let answered = false;
  for await (const event of provider.chat(model, [{ role: 'user', content: 'Say OK.' }])) {
    if (event.type === 'text' && event.text.trim()) answered = true;
  }
  if (!answered) {
    throw new UserFacingError(
      `${provider.name} accepted the request but returned nothing for ${model}. Try another model.`
    );
  }
}

/** Marks the stored choice so re-running setup shows what is already in place. */
function labelWithCurrent(label: string, isCurrent: boolean): string {
  return isCurrent ? `${label} (current)` : label;
}

export async function runSetupCommand(): Promise<void> {
  await runSetup({
    providers: listProviders(),
    store: new SettingsStore(),
    prompts: {
      chooseProvider: async (providers, current) =>
        select({
          message: 'Which provider should Robin use?',
          choices: providers.map((p) => ({
            name: labelWithCurrent(p.name, p.id === current),
            value: p,
          })),
          default: providers.find((p) => p.id === current),
        }),
      chooseModel: async (models, current) =>
        pickFromChoices(
          'Which model?',
          toChoices(models),
          current && models.includes(current)
            ? [{ name: labelWithCurrent(current, true), value: current }]
            : []
        ),
    },
    login: runLogin,
    verify: verifyWithTurn,
    out: console.log,
  });
}
