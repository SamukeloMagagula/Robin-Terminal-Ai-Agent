import { createRequire } from 'node:module';

/**
 * Robin's version, from package.json — the one place it is actually declared.
 *
 * Shared rather than read in each place that wants it, because the copy that
 * was typed into the MCP client handshake still said 0.1.0 several releases
 * later. A version string that has to be remembered is a version string that
 * goes stale.
 */
export function robinVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // One level up: this compiles to dist/version.js, so package.json sits
    // beside dist rather than inside it.
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // A missing or unreadable package.json is not a reason to refuse to start.
    return '0.0.0';
  }
}
