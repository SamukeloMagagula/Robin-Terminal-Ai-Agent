import chalk from 'chalk';
import type { Provider } from '../providers/types.js';
import { UnsupportedModelStore } from '../providers/unsupported-models.js';
import { mutedColor } from '../ui/theme.js';

/**
 * Lists the models Robin has recorded as unsupported for a provider.
 *
 * These records come partly from an explicit provider error code and partly
 * from matching an error message, and message matching can be wrong — so the
 * list has to be inspectable and the records erasable.
 */
export async function runModelsList(
  providers: Provider[],
  store: UnsupportedModelStore = new UnsupportedModelStore()
): Promise<void> {
  let any = false;
  for (const provider of providers) {
    const models = await store.listFor(provider.id);
    if (models.length === 0) continue;
    any = true;
    console.log(`${provider.name} — ${models.length} recorded as unsupported:`);
    for (const model of models) console.log(`  ${mutedColor(model)}`);
  }
  if (!any) {
    console.log(mutedColor('No models have been recorded as unsupported.'));
  } else {
    console.log(mutedColor('\nClear with: robin models forget <provider>'));
  }
}

/** Forgets every unsupported-model record for one provider, so its catalogue is retried. */
export async function runModelsForget(
  provider: Provider,
  store: UnsupportedModelStore = new UnsupportedModelStore()
): Promise<void> {
  const before = await store.listFor(provider.id);
  if (before.length === 0) {
    console.log(mutedColor(`Nothing recorded for ${provider.name}.`));
    return;
  }
  await store.clear(provider.id);
  console.log(
    chalk.gray(
      `Forgot ${before.length} unsupported model${before.length === 1 ? '' : 's'} for ${provider.name}. They will be offered again.`
    )
  );
}
