import { expand } from '@inquirer/prompts';
import { TrustStore } from '../trust-store.js';
import { loadMcpConfig, serverFingerprint } from '../mcp/config.js';
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
    const command = [server.command, ...(server.args ?? [])].join(' ');

    if (await trustStore.isTrusted('mcp-server', server.name, fingerprint)) {
      console.log(`  ${assistantColor('✓')} ${server.name.padEnd(20)}${mutedColor(command)}`);
      continue;
    }

    console.log(`\n${mutedColor(`"${server.name}" wants to run:`)}`);
    console.log(box([command]));
    console.log(
      mutedColor('Its tools become available to the model, each still asking before it runs.')
    );

    const answer = await expand<'yes' | 'no' | 'always'>({
      message: `Approve "${server.name}"?`,
      default: 'n',
      choices: [
        { key: 'y', name: 'yes, this exact command', value: 'yes' },
        { key: 'n', name: 'no', value: 'no' },
        {
          key: 'a',
          name: 'yes, and trust this server even if its command changes',
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
