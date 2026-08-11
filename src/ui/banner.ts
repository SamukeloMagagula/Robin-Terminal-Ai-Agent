import { createRequire } from 'node:module';
import { mutedColor, ruleWidth } from './theme.js';
import { SLASH_COMMANDS } from '../repl/slash-prompt.js';
import { renderHud } from './hud/layout.js';
import type { HudStats } from './hud/telemetry.js';

const DEFAULT_WIDTH = 80;
const INDENT = '  ';

export interface BannerInfo {
  providerName: string;
  model: string;
  cwd: string;
  sessionId: string;
  /** When false the TOOLS meter reads zero — nothing is armed for this turn. */
  toolsEnabled: boolean;
  /** Pre-rendered usage line, omitted when there is no OpenRouter key or the fetch failed. */
  usageLine?: string;
  /**
   * Real figures behind the HUD's meters. Optional so a caller that has not
   * gathered them still gets a banner — the meters simply read zero.
   */
  stats?: HudStats;
}

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Zeroed telemetry, for a caller that did not gather any. */
function emptyStats(): HudStats {
  return {
    providersLinked: 0,
    providersTotal: 0,
    toolCount: 0,
    memoryCount: 0,
    skillCount: 0,
    mcpServerCount: 0,
    host: 'unknown',
    node: process.version,
  };
}

export function buildBanner(info: BannerInfo): string[] {
  const columns = process.stdout.columns ?? DEFAULT_WIDTH;

  const rows = renderHud(
    {
      providerName: info.providerName,
      model: info.model,
      cwd: info.cwd,
      sessionId: info.sessionId,
      version: readVersion(),
      // A disabled tool set must not read as armed; the HUD would otherwise
      // claim capability the model does not have.
      stats: info.toolsEnabled
        ? (info.stats ?? emptyStats())
        : { ...(info.stats ?? emptyStats()), toolCount: 0 },
      usageLine: info.usageLine,
      commands: SLASH_COMMANDS.map((command) => command.name),
    },
    columns - INDENT.length
  );

  return [
    '',
    ...rows.map((row) => (row ? `${INDENT}${row}` : row)),
    '',
    `${INDENT}${mutedColor('built by Samukelo "Batman" Magagula')}`,
    '',
  ];
}

export function printBanner(info: BannerInfo): void {
  console.log(buildBanner(info).join('\n'));
}

export function printConnectionLine(providerName: string, model: string): void {
  const label = `${providerName} · ${model}`;
  // Tracks the terminal like the banner and the divider do. A model id can be
  // long (`anthropic/claude-3.5-sonnet`), so the fill floors at zero rather
  // than going negative.
  const fillLength = Math.max(ruleWidth() - label.length - 6, 0);
  console.log(`   ${mutedColor('──')} ${label} ${mutedColor('─'.repeat(fillLength))}`);
}
