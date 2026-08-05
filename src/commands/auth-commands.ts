import chalk from 'chalk';
import type { Provider } from '../providers/types.js';

export async function runLogin(provider: Provider): Promise<void> {
  if (await provider.isAuthenticated()) {
    console.log(chalk.yellow(`Already logged in to ${provider.name}.`));
    return;
  }
  await provider.login();
  console.log(chalk.green(`Logged in to ${provider.name}.`));
}

export async function runLogout(provider: Provider): Promise<void> {
  await provider.logout();
  console.log(chalk.green(`Logged out of ${provider.name}.`));
}
