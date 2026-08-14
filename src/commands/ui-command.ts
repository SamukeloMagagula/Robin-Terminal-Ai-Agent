import { ensureGateway } from '../gateway/ensure.js';
import { announceAndOpen } from '../browser.js';
import { mutedColor } from '../ui/theme.js';

/**
 * Opens the control UI in a browser.
 *
 * The token travels in the query string because a page cannot read
 * `~/.robin/gateway.json`. That is not ideal — a URL is history, a bookmark and
 * a referrer — so the page takes it out of the address bar the moment it loads
 * and keeps it in sessionStorage instead. Printing the link as well means this
 * still works when there is no browser to open, over SSH for instance.
 */
export async function runUi(): Promise<void> {
  const info = await ensureGateway();
  const url = `http://127.0.0.1:${info.port}/?token=${info.token}`;

  console.log(mutedColor('The link below carries the gateway token. Anyone who has it can'));
  console.log(mutedColor('run commands as you, so treat it like a password.\n'));
  announceAndOpen(url);
}
