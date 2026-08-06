import chalk from 'chalk';
import type { Provider } from '../providers/types.js';

async function checkAuthenticated(provider: Provider): Promise<boolean> {
  try {
    return await provider.isAuthenticated();
  } catch {
    return false;
  }
}

function labelFor(provider: Provider, ok: boolean): string {
  if (provider.id === 'ollama') {
    return ok ? 'reachable' : 'not reachable — start it with `ollama serve`';
  }
  return ok ? 'logged in' : `not logged in — run \`robin login ${provider.id}\``;
}

const NAME_WIDTH = 18;

export async function runStatus(providers: Provider[]): Promise<void> {
  console.log('Provider status:');
  for (const provider of providers) {
    const ok = await checkAuthenticated(provider);
    const icon = ok ? chalk.green('✓') : chalk.red('✖');
    console.log(`  ${icon} ${provider.name.padEnd(NAME_WIDTH)} ${labelFor(provider, ok)}`);
  }
}
