import { expand, input, password } from '@inquirer/prompts';
import { TrustStore } from '../trust-store.js';
import { loadMcpConfig, serverFingerprint, addMcpServer, removeMcpServer, type McpServerConfig } from '../mcp/config.js';
import {
  searchRegistry,
  installablePackage,
  installableRemote,
  commandFor,
  type RegistryServer,
} from '../mcp/catalogue.js';
import { readLiveGatewayInfo } from '../gateway/discovery.js';
import { mutedColor, assistantColor, errorColor, box, divider } from '../ui/theme.js';

/**
 * Reviews the servers in mcp.json and approves the ones the user wants.
 *
 * This exists because the gateway cannot ask. It runs detached with no
 * terminal, and an mcp.json entry is a command Robin will execute, so approval
 * has to happen somewhere a person is present — here.
 */
export async function runMcp(): Promise<void> {
  const trustStore = new TrustStore();
  const configured = await loadMcpConfig();

  console.log(assistantColor('MCP servers'));
  console.log(divider());

  if (configured.length === 0) {
    console.log(mutedColor('None configured. Declare them in ~/.robin/mcp.json.'));
    return;
  }

  let changed = 0;
  for (const server of configured) {
    const fingerprint = serverFingerprint(server.name, server);
    // A remote entry runs nothing locally — "wants to run" would be a lie
    // for it. Different blast radius (a network request plus whatever
    // tools it advertises, vs. arbitrary local code execution), different
    // sentence.
    const isRemote = Boolean(server.url);
    const target = isRemote ? server.url! : [server.command, ...(server.args ?? [])].join(' ');

    if (await trustStore.isTrusted('mcp-server', server.name, fingerprint)) {
      console.log(`  ${assistantColor('✓')} ${server.name.padEnd(20)}${mutedColor(target)}`);
      continue;
    }

    console.log(`\n${mutedColor(`"${server.name}" wants to ${isRemote ? 'connect to' : 'run'}:`)}`);
    console.log(box([target]));
    if (isRemote && server.headers && Object.keys(server.headers).length > 0) {
      console.log(
        mutedColor(`Sends these header names (values not shown): ${Object.keys(server.headers).join(', ')}`)
      );
    }
    console.log(
      mutedColor('Its tools become available to the model, each still asking before it runs.')
    );

    const answer = await expand<'yes' | 'no' | 'always'>({
      message: `Approve "${server.name}"?`,
      default: 'n',
      choices: [
        { key: 'y', name: `yes, this exact ${isRemote ? 'url' : 'command'}`, value: 'yes' },
        { key: 'n', name: 'no', value: 'no' },
        {
          key: 'a',
          name: `yes, and trust this server even if its ${isRemote ? 'url' : 'command'} changes`,
          value: 'always',
        },
      ],
    });

    if (answer === 'yes') {
      await trustStore.trustContent('mcp-server', server.name, fingerprint);
      changed += 1;
    } else if (answer === 'always') {
      await trustStore.trustKey('mcp-server', server.name);
      changed += 1;
    }
  }

  if (changed === 0) return;

  // The daemon reads trust once, at startup. Saying so beats leaving the user
  // wondering why an approved server produced no tools.
  const running = await readLiveGatewayInfo();
  console.log(
    running
      ? errorColor(
          '\nRun `robin gateway stop` for this to take effect — the running gateway ' +
            'started its servers before you approved these.'
        )
      : mutedColor('\nThey will start with the next `robin chat`.')
  );
}

/** Explains why neither installablePackage nor installableRemote found anything usable. */
function notInstallableReason(server: RegistryServer): string {
  const remotes = server.remotes ?? [];
  if (remotes.length > 0 && remotes.every((r) => r.type !== 'streamable-http')) {
    return 'only offers the legacy sse transport';
  }
  if (remotes.some((r) => r.type === 'streamable-http' && /\{[^}]+\}/.test(r.url))) {
    return 'its remote url has an unresolved {placeholder} this catalogue will not guess at';
  }
  return 'HTTP/SSE only, or a package shape this catalogue does not map';
}

/** Queries the MCP registry and shows what each result would run, or why it can't. */
export async function runMcpSearch(term: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const found = await searchRegistry(term, fetchImpl);

  console.log(assistantColor(`MCP registry — ${found.length} result(s) for "${term}"`));
  console.log(divider());

  if (found.length === 0) {
    console.log(mutedColor('  Nothing matched. Try a different term.'));
    return;
  }

  for (const server of found) {
    // A local package is preferred when a server offers both — faster, more
    // capable, and never sends headers over a network.
    const pkg = installablePackage(server);
    const remote = pkg ? undefined : installableRemote(server);
    console.log(`\n  ${assistantColor(server.name)} ${mutedColor(server.description)}`);
    if (pkg) {
      const { command, args } = commandFor(pkg);
      console.log(`    ${mutedColor([command, ...args].join(' '))}`);
    } else if (remote) {
      console.log(`    ${mutedColor(`GET ${remote.url}`)}`);
    } else {
      console.log(
        `    ${errorColor('not installable')} ${mutedColor(
          `— ${notInstallableReason(server)}`
        )}`
      );
    }
  }
  console.log(mutedColor(`\nInstall with \`robin mcp add <name>\`.`));
}

/**
 * Installs a named server from the registry.
 *
 * The registry accepts submissions from anyone — a name and description are
 * not a review. The confirmation shows the exact command and says so in
 * plainer terms than the skill catalogue needs, since a server is an
 * executable Robin will run with the operator's full permissions, not text
 * reviewed once and left in a prompt. Confirming writes the entry and
 * records trust in the same step, so nothing is left half-installed
 * requiring a second `robin mcp` pass.
 */
export async function runMcpAdd(name: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const found = await searchRegistry(name, fetchImpl);
  const server = found.find((s) => s.name === name);
  if (!server) {
    console.log(errorColor(`✖ "${name}" is not in the MCP registry.`));
    return;
  }

  // A local package is preferred when a server offers both — faster, more
  // capable, and never sends headers over a network.
  const pkg = installablePackage(server);
  const remote = pkg ? undefined : installableRemote(server);
  if (!pkg && !remote) {
    console.log(errorColor(`✖ "${name}" is not installable — ${notInstallableReason(server)}.`));
    return;
  }

  let entry: McpServerConfig;
  let target: string;
  if (pkg) {
    const collected: Record<string, string> = {};
    for (const variable of pkg.environmentVariables ?? []) {
      if (!variable.isRequired) continue;
      const prompt = variable.isSecret ? password : input;
      collected[variable.name] = await prompt({
        message: `${variable.name} — ${variable.description}`,
        default: variable.default,
      });
    }
    const { command, args } = commandFor(pkg);
    entry = { name, command, args, ...(Object.keys(collected).length ? { env: collected } : {}) };
    target = [command, ...args].join(' ');
  } else {
    const collected: Record<string, string> = {};
    for (const header of remote!.headers ?? []) {
      if (!header.isRequired) continue;
      const prompt = header.isSecret ? password : input;
      collected[header.name] = await prompt({
        message: `${header.name} — ${header.description}`,
        default: header.default,
      });
    }
    entry = { name, url: remote!.url, ...(Object.keys(collected).length ? { headers: collected } : {}) };
    target = remote!.url;
  }

  console.log(mutedColor(`\n"${name}" wants to ${pkg ? 'run' : 'connect to'}:`));
  console.log(box([target]));
  console.log(
    errorColor(
      'The MCP registry accepts submissions from anyone — nothing here vets what a ' +
        `server actually does. Read the ${pkg ? 'command' : 'url'} above carefully.`
    )
  );

  const answer = await expand<'yes' | 'no'>({
    message: 'Install it?',
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

  await addMcpServer(entry);
  const trustStore = new TrustStore();
  await trustStore.trustContent('mcp-server', name, serverFingerprint(name, entry));

  console.log(assistantColor(`✓ Installed "${name}".`));
  const running = await readLiveGatewayInfo();
  console.log(
    running
      ? errorColor(
          'Run `robin gateway stop` for this to take effect — the running gateway ' +
            'started its servers before you added this one.'
        )
      : mutedColor('It will start with the next `robin chat`.')
  );
}

/** Removes a named server from mcp.json. A no-op is reported, not treated as an error. */
export async function runMcpRemove(name: string, filePath?: string): Promise<void> {
  const removed = await removeMcpServer(name, filePath);
  console.log(
    removed
      ? assistantColor(`✓ Removed "${name}" from mcp.json.`)
      : mutedColor(`No "${name}" entry to remove.`)
  );
}
