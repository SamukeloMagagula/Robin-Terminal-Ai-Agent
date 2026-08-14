import { startGateway } from '../gateway/start.js';
import {
  isProcessAlive,
  readGatewayInfo,
  readLiveGatewayInfo,
  removeGatewayInfo,
} from '../gateway/discovery.js';
import { PROTOCOL_VERSION } from '../gateway/protocol.js';
import { buildFingerprint } from '../gateway/build-id.js';
import { mutedColor, errorColor } from '../ui/theme.js';

/**
 * Runs in the foreground and stays there. `robin chat` spawns this detached
 * when it finds nothing listening.
 */
export async function runGatewayStart(): Promise<void> {
  const gateway = await startGateway();

  // Tidies up after Ctrl-C, and after a SIGTERM on platforms that deliver one.
  // Windows is not one of them: `process.kill(pid)` there terminates the
  // process outright, so this handler never runs and the daemon cannot remove
  // its own file. That is why runGatewayStop removes it from the other side —
  // and why a stale file has to be survivable rather than merely unlikely.
  const shutdown = async (): Promise<void> => {
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

export async function runGatewayStop(): Promise<void> {
  const info = await readGatewayInfo();
  if (!info) {
    console.log(mutedColor('No gateway is recorded as running.'));
    return;
  }
  if (!isProcessAlive(info.pid)) {
    await removeGatewayInfo();
    console.log(mutedColor('Cleared a stale gateway record; nothing was running.'));
    return;
  }
  process.kill(info.pid);
  // Not belt-and-braces: on Windows the kill above is abrupt and the daemon
  // never gets to clean up after itself, so this is the only thing that
  // removes the file.
  await removeGatewayInfo();
  console.log(`Stopped the gateway (pid ${info.pid}).`);
}

export async function runGatewayStatus(): Promise<void> {
  const info = await readLiveGatewayInfo();
  if (!info) {
    console.log(mutedColor('Not running. `robin chat` will start one when you need it.'));
    return;
  }
  console.log(`Running on 127.0.0.1:${info.port} (pid ${info.pid}), protocol ${info.protocol}.`);
  const own = await buildFingerprint();
  if (own && info.build && info.build !== own) {
    console.log(
      errorColor(
        `It is running build ${info.build}; this one is ${own}. ` +
          'Run `robin gateway stop` to pick up your changes.'
      )
    );
  }
  if (info.protocol !== PROTOCOL_VERSION) {
    // Auto-start means a daemon outlives the build that started it.
    console.log(
      errorColor(
        `This build speaks protocol ${PROTOCOL_VERSION}. Run \`robin gateway stop\` — ` +
          'that daemon predates your last build.'
      )
    );
  }
}
