import chalk from 'chalk';
import { expand, input } from '@inquirer/prompts';
import type { ReplContext } from '../repl-context.js';
import { getProvider } from '../../providers/index.js';
import { runWorkflow, type CheckpointAnswer } from '../../workflow/run-workflow.js';
import { WorkflowStore } from '../../workflow/store.js';
import { ROLES, type Role, type RoleConfig } from '../../workflow/types.js';
import { assistantColor, errorColor, mutedColor, box } from '../../ui/theme.js';

const ROLE_BLURB: Record<Role, string> = {
  planner: 'decides what to do (no tools)',
  builder: 'makes the change',
  tester: 'runs the checks',
  validator: 'judges whether it met the goal',
};

export async function handleWorkflow(ctx: ReplContext, arg?: string): Promise<void> {
  const [sub, ...rest] = (arg ?? '').split(' ').filter(Boolean);
  const store = ctx.stores.workflow;

  if (!sub || sub === 'list') {
    const names = await store.list();
    console.log(
      names.length
        ? mutedColor(names.join(', '))
        : mutedColor('No workflows yet. Create one with /workflow new.')
    );
    return;
  }

  if (sub === 'new') {
    await createWorkflow(ctx);
    return;
  }

  if (sub === 'show') {
    const config = await store.read(rest[0] ?? '');
    if (!config) {
      console.log(errorColor(`✖ No workflow named "${rest[0] ?? ''}".`));
      return;
    }
    for (const [role, roleConfig] of WorkflowStore.rolesInOrder(config)) {
      console.log(
        `  ${assistantColor(role.padEnd(11))}${roleConfig.providerId} · ${roleConfig.model}  ` +
          mutedColor(ROLE_BLURB[role])
      );
    }
    return;
  }

  if (sub === 'run') {
    await startRun(ctx, rest.join(' '));
    return;
  }

  console.log(
    errorColor(`✖ Unknown /workflow subcommand "${sub}". Usage: /workflow [list|new|show|run]`)
  );
}

async function createWorkflow(ctx: ReplContext): Promise<void> {
  const name = (await input({ message: 'Name this workflow:' })).trim();
  if (!name) {
    console.log(errorColor('✖ A workflow needs a name.'));
    return;
  }

  const roles = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    console.log(`\n${assistantColor(role)} — ${mutedColor(ROLE_BLURB[role])}`);
    const picked = await ctx.deps.pickProviderAndModel();
    roles[role] = { providerId: picked.provider.id, model: picked.model };
  }

  try {
    await ctx.stores.workflow.write({ name, roles });
    console.log(chalk.gray(`\nSaved workflow "${name}". Run it with /workflow run <goal>.`));
  } catch (err) {
    console.log(errorColor(`✖ ${(err as Error).message}`));
  }
}

async function startRun(ctx: ReplContext, goalAndName: string): Promise<void> {
  const names = await ctx.stores.workflow.list();
  if (names.length === 0) {
    console.log(errorColor('✖ No workflows yet. Create one with /workflow new.'));
    return;
  }
  if (!goalAndName) {
    console.log(errorColor('✖ Usage: /workflow run <goal>'));
    return;
  }

  // One workflow is the common case; with several, the first word selects.
  const [maybeName, ...goalWords] = goalAndName.split(' ');
  const named = names.includes(maybeName);
  const config = await ctx.stores.workflow.read(named ? maybeName : names[0]);
  const goal = named ? goalWords.join(' ') : goalAndName;

  if (!config) {
    console.log(errorColor('✖ That workflow could not be read.'));
    return;
  }
  if (!goal.trim()) {
    console.log(errorColor('✖ Give the workflow something to do.'));
    return;
  }

  const models = WorkflowStore.rolesInOrder(config)
    .map(([role, c]) => `${role}: ${c.model}`)
    .join('  ·  ');
  console.log(mutedColor(`\n${models}`));
  console.log(
    mutedColor('A full run with one loop-back is roughly six model turns. Tool use still asks.\n')
  );

  const outcome = await runWorkflow(config, goal, {
    resolveProvider: (id) => getProvider(id),
    turnOptions: {
      confirm: ctx.confirm,
      unsupportedStore: ctx.stores.unsupported,
      memory: ctx.stores.memory,
      skills: ctx.stores.skill,
    },
    onStageStart: (role, model, attempt) => {
      const suffix = attempt > 1 ? ` (attempt ${attempt})` : '';
      console.log(`\n${assistantColor(`▸ ${role}`)} ${mutedColor(`${model}${suffix}`)}\n`);
    },
    onText: (text) => process.stdout.write(text),
    onNotice: (message) => console.log(mutedColor(`\n${message}`)),
    checkpoint: async (role) => {
      const answer = await expand<CheckpointAnswer>({
        message: `\n${role} finished. What now?`,
        default: 'a',
        choices: [
          { key: 'a', name: 'approve and continue', value: 'approve' },
          { key: 'r', name: 'retry this stage with a note', value: 'retry' },
          { key: 's', name: 'skip this stage', value: 'skip' },
          { key: 'q', name: 'quit the workflow', value: 'quit' },
        ],
      });
      if (answer !== 'retry') return { answer };
      const feedback = await input({ message: 'What should it do differently?' });
      return { answer, feedback };
    },
  });

  const closing: Record<typeof outcome.reason, string> = {
    passed: 'Workflow finished — the validator accepted the work.',
    exhausted: 'Workflow stopped — the validator kept rejecting the work.',
    quit: 'Workflow stopped at your request.',
    error: 'Workflow stopped on an error.',
    failed: 'Workflow did not pass.',
  };
  console.log(`\n${box([closing[outcome.reason]])}`);
}
