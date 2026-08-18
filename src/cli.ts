#!/usr/bin/env node
import { Command } from 'commander';
import { select, confirm } from '@inquirer/prompts';
import type { Provider } from './providers/types.js';
import { listProviders, getProvider } from './providers/index.js';
import { runLogin, runLogout } from './commands/auth-commands.js';
import { runStatus } from './commands/status-command.js';
import { runModelsList, runModelsForget } from './commands/models-command.js';
import { runRepl } from './repl/run-repl.js';
import { runDoctor } from './commands/doctor-command.js';
import {
  runGatewayStart,
  runGatewayStop,
  runGatewayStatus,
} from './commands/gateway-command.js';
import { runMcp } from './commands/mcp-command.js';
import { runUi } from './commands/ui-command.js';
import {
  runConfigList,
  runConfigGet,
  runConfigSet,
  runConfigUnset,
} from './commands/config-command.js';
import { runSetupCommand } from './commands/setup-command.js';
import {
  runAutonomyAdd,
  runAutonomyList,
  runAutonomyLog,
  runAutonomyRevoke,
  runAutonomyShow,
  type RuleFlags,
} from './commands/autonomy-command.js';
import { AutonomyStore } from './autonomy/grant-store.js';
import { AuditLog } from './autonomy/audit.js';
import { SettingsStore } from './settings/store.js';
import { storedChatDefault } from './settings/defaults.js';
import { hydrateEnv } from './settings/hydrate.js';
import { capturePristineEnv } from './settings/env.js';
import { runSkillList, runSkillAdd, runSkillUpdate } from './commands/skill-command.js';
import { runServe, serveHelpText, type ServeOptions } from './commands/serve-command.js';
import { pickRandomProviderAndModel } from './random-pick.js';
import { robinVersion } from './version.js';
import { pickFromChoices, toChoices } from './ui/model-picker.js';
import { mutedColor, errorColor } from './ui/theme.js';
import {
  installGlobalErrorHandlers,
  reportFatal,
  requireInteractiveTerminal,
} from './startup/bootstrap.js';
import { buildChecks, runChecks, blockingFailures } from './startup/preflight.js';

const RANDOM = '__random__';

/**
 * A provider chosen from the menu still needs a model picked; a random roll
 * already has one. Keeping them distinct stops the roll's model being
 * announced and then thrown away by the model picker.
 */
type ProviderChoice =
  | { kind: 'chosen'; provider: Provider }
  | { kind: 'rolled'; provider: Provider; model: string };

async function rollRandom(): Promise<{ provider: Provider; model: string }> {
  const choice = await pickRandomProviderAndModel(listProviders());
  // A random pick the user can't see leaves them unable to judge the reply.
  console.log(`🎲 Rolled ${choice.provider.name} · ${choice.model}`);
  return choice;
}

async function chooseProvider(): Promise<ProviderChoice> {
  const id = await select({
    message: 'Select a provider:',
    choices: [
      { name: '🎲 Random', value: RANDOM },
      ...listProviders().map((p) => ({ name: p.name, value: p.id })),
    ],
  });
  if (id === RANDOM) return { kind: 'rolled', ...(await rollRandom()) };
  return { kind: 'chosen', provider: getProvider(id) };
}

async function pickModel(provider: Provider): Promise<string> {
  const models = await provider.listModels();
  return pickFromChoices('Select a model:', toChoices(models));
}

const BACK = '__back__';

/** Same as pickModel, but with a "← Back" choice for returning to provider selection. */
async function pickModelWithBack(provider: Provider): Promise<string> {
  const models = await provider.listModels();
  return pickFromChoices('Select a model:', toChoices(models), [
    { name: '← Back to provider list', value: BACK },
  ]);
}

async function ensureAuthenticated(provider: Provider): Promise<void> {
  if (!(await provider.isAuthenticated())) {
    console.log(`Not logged in to ${provider.name} yet.`);
    await provider.login();
  }
}

/** Picks a provider, then a model — looping back to provider selection if the model picker's "Back" choice is taken. */
async function pickProviderAndModel(): Promise<{ provider: Provider; model: string }> {
  let choice = await chooseProvider();
  while (true) {
    // A rolled pair is already complete, and the roll only considers providers
    // that are authenticated, so there is nothing left to ask.
    if (choice.kind === 'rolled') {
      return { provider: choice.provider, model: choice.model };
    }
    await ensureAuthenticated(choice.provider);
    const modelChoice = await pickModelWithBack(choice.provider);
    if (modelChoice === BACK) {
      choice = await chooseProvider();
      continue;
    }
    return { provider: choice.provider, model: modelChoice };
  }
}

/**
 * The gate every interactive session passes through.
 *
 * Only the critical checks abort — a stale native module or an unwritable
 * config directory means nothing downstream will work, and finding that out
 * six screens later as a stack trace is what "I can't run this" looks like.
 * Non-critical findings are deliberately not printed here: a clean start
 * should be silent, and `robin doctor` exists for the full picture.
 */
async function preflightOrExit(): Promise<void> {
  const results = await runChecks(buildChecks({ providers: listProviders() }));
  const blocking = blockingFailures(results);
  if (blocking.length === 0) return;

  console.error(errorColor('✖ Robin cannot start:'));
  for (const failure of blocking) {
    console.error(errorColor(`  ${failure.label}: ${failure.detail}`));
    if (failure.remedy) console.error(mutedColor(`    → ${failure.remedy}`));
  }
  console.error(mutedColor('\nRun `robin doctor` for the full report.'));
  process.exit(1);
}

async function startChat(providerId?: string, continueSession = false): Promise<void> {
  requireInteractiveTerminal();
  await preflightOrExit();

  const common = { pickModel, pickProviderAndModel, rollRandom, continueSession };

  if (providerId === 'random') {
    const { provider, model } = await rollRandom();
    await runRepl({ provider, model, ...common });
    return;
  }
  if (providerId) {
    const provider = getProvider(providerId);
    await ensureAuthenticated(provider);
    const model = await pickModel(provider);
    await runRepl({ provider, model, ...common });
    return;
  }
  // No provider named: honour the pair `robin setup` stored, and only fall
  // back to the menu when there is nothing usable to honour.
  const stored = await storedChatDefault(new SettingsStore(), listProviders());
  if (stored) {
    await ensureAuthenticated(stored.provider);
    console.log(mutedColor(`${stored.provider.name} · ${stored.model} — your default. Change it with \`robin setup\`.`));
    await runRepl({ provider: stored.provider, model: stored.model, ...common });
    return;
  }

  const { provider, model } = await pickProviderAndModel();
  await runRepl({ provider, model, ...common });
}

const program = new Command();
program
  .name('robin')
  .description('Chat with AI models from your terminal')
  // `robin --version` answered "unknown option" until there were releases to
  // tell apart. It is the first thing anyone is asked for in a bug report.
  .version(robinVersion(), '-v, --version');

program
  .command('login <provider>')
  .description('Log in to a provider')
  .action(async (providerId: string) => {
    await runLogin(getProvider(providerId));
  });

program
  .command('logout <provider>')
  .description('Log out of a provider')
  .action(async (providerId: string) => {
    await runLogout(getProvider(providerId));
  });

program
  .command('status')
  .description('Show login/reachability status for every provider')
  .action(async () => {
    await runStatus(listProviders());
  });

const models = program
  .command('models')
  .description('Inspect models Robin has recorded as unsupported');

models
  .command('list', { isDefault: true })
  .description('List models recorded as unsupported, per provider')
  .action(async () => {
    await runModelsList(listProviders());
  });

models
  .command('forget <provider>')
  .description('Forget a provider’s unsupported-model records so they are offered again')
  .action(async (providerId: string) => {
    await runModelsForget(getProvider(providerId));
  });

program
  .command('serve <channel>')
  .description('Run Robin as a bridge so it can be driven from a messaging app')
  .option('-p, --provider <id>', 'provider to answer with (default: first logged in)')
  .option('-m, --model <model>', 'model to answer with')
  .option('--allow-tools', 'let tool calls run without approval — see the warning below', false)
  .option('--manifest <id>', 'let it act unattended within a capability manifest (see `robin autonomy`)')
  .option('--whoami', 'print the sender id of anyone who messages the bot, then exit', false)
  .addHelpText('after', `\n${serveHelpText()}`)
  .action(async (channel: string, options: ServeOptions) => {
    await runServe(channel, options);
  });

const gateway = program
  .command('gateway')
  .description('The local control plane that owns sessions. `robin chat` starts one for you');

gateway
  .command('status', { isDefault: true })
  .description('Report whether a gateway is running, and where')
  .action(async () => {
    await runGatewayStatus();
  });

gateway
  .command('start')
  .description('Run the gateway in the foreground')
  .action(async () => {
    await runGatewayStart();
  });

gateway
  .command('stop')
  .description('Stop the running gateway')
  .action(async () => {
    await runGatewayStop();
  });

const skill = program
  .command('skill')
  .description('Install skills from the Anthropic, OpenClaw and Hermes catalogues');

skill
  .command('list [source] [filter]', { isDefault: true })
  .description('List a catalogue, or the catalogues themselves')
  .action(async (source?: string, filter?: string) => {
    await runSkillList(source, filter);
  });

skill
  .command('update')
  .description('Re-fetch installed catalogue skills')
  .action(async () => {
    await runSkillUpdate();
  });

skill
  .command('add <source> <names...>')
  .description('Install named skills from a catalogue')
  .action(async (source: string, names: string[]) => {
    await runSkillAdd(source, names);
  });

program
  .command('ui')
  .description('Open the control UI in a browser')
  .action(async () => {
    await runUi();
  });

program
  .command('mcp')
  .description('Review and approve the MCP servers in ~/.robin/mcp.json')
  .action(async () => {
    await runMcp();
  });

program
  .command('doctor')
  .description('Check this installation and report anything that would stop Robin starting')
  .action(async () => {
    await runDoctor(listProviders());
  });

program
  .command('setup')
  .description('First-run wizard: pick a provider, log in, and save a default model')
  .action(async () => {
    requireInteractiveTerminal();
    await runSetupCommand();
  });

const config = program
  .command('config')
  .description('Read and change stored settings (~/.robin/settings.json)');

config
  .command('list', { isDefault: true })
  .description('Show every setting, its value, and where that value came from')
  .action(async () => {
    await runConfigList(new SettingsStore());
  });

config
  .command('get <key>')
  .description('Show one setting')
  .action(async (key: string) => {
    await runConfigGet(new SettingsStore(), key);
  });

config
  .command('set <key> <value>')
  .description('Change one setting')
  .action(async (key: string, value: string) => {
    await runConfigSet(new SettingsStore(), key, value);
  });

config
  .command('unset <key>')
  .description('Forget one setting, reverting it to its default')
  .action(async (key: string) => {
    await runConfigUnset(new SettingsStore(), key);
  });

const autonomy = program
  .command('autonomy')
  .description('Capability manifests — what Robin may do with nobody watching');

autonomy
  .command('list', { isDefault: true })
  .description('List every manifest and when it lapses')
  .action(async () => {
    await runAutonomyList(new AutonomyStore());
  });

autonomy
  .command('show <id>')
  .description('Show one manifest in full')
  .action(async (id: string) => {
    await runAutonomyShow(new AutonomyStore(), id);
  });

autonomy
  .command('add <id>')
  .description('Create a manifest, after showing you exactly what it would allow')
  .option('--command <pattern...>', 'a command it may run, e.g. "git *"')
  .option('--read <glob...>', 'a path it may read')
  .option('--write <glob...>', 'a path it may write')
  .option('--mcp <name...>', 'an MCP tool it may call, e.g. "github.list_issues"')
  .option('--expires <duration>', 'how long the grant lasts: 7d, 24h, or never', '7d')
  .option('--escalate <surface:minutes>', 'also offer approvals here, e.g. telegram:30')
  .action(async (id: string, flags: RuleFlags) => {
    // A manifest is a decision made by someone who is present. Creating one
    // from a script would be exactly the thing it exists to prevent.
    requireInteractiveTerminal();
    await runAutonomyAdd(new AutonomyStore(), id, flags, {
      confirm: () => confirm({ message: 'Create this manifest?', default: false }),
      now: new Date(),
      out: console.log,
    });
  });

autonomy
  .command('revoke <id>')
  .description('Delete a manifest — running sessions lose it at once')
  .action(async (id: string) => {
    await runAutonomyRevoke(new AutonomyStore(), id);
  });

autonomy
  .command('log <id>')
  .description('What this manifest allowed, and what it refused')
  .action(async (id: string) => {
    await runAutonomyLog(new AuditLog(), id);
  });

program
  .command('chat [provider]')
  .description('Start a chat session — pass a provider id, or "random" to roll one')
  .option('-c, --continue', "Pick up this directory's last conversation instead of starting a new one")
  .action(async (providerId: string | undefined, options: { continue?: boolean }) => {
    await startChat(providerId, options.continue ?? false);
  });

program.option('-c, --continue', "Pick up this directory's last conversation instead of starting a new one");
program.action(async (options: { continue?: boolean }) => {
  await startChat(undefined, options.continue ?? false);
});

installGlobalErrorHandlers();

// Stored settings become the environment the rest of the process reads, before
// any command runs. Variables already exported are left alone, so the shell
// still outranks the file — and the snapshot taken first is what keeps a
// hydrated value from later being mistaken for one the user exported.
capturePristineEnv();
hydrateEnv(new SettingsStore())
  .then(() => program.parseAsync(process.argv))
  .catch(reportFatal);
