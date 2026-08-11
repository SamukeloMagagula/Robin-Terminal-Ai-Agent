import * as os from 'node:os';
import { mutedColor } from '../theme.js';
import { visibleLength } from '../panel.js';
import { buildWordmark, buildPlainWordmark, WORDMARK_WIDTH } from '../wordmark.js';
import { buildReticle, buildCompactReticle, RETICLE_WIDTH } from './reticle.js';
import { frameTop, frameBottom, sectionRule, statRow } from './frame.js';
import { meter } from './meter.js';
import type { HudStats } from './telemetry.js';

/** Below this the reticle does not fit beside the panels. */
const FULL_WIDTH = 90;
/** Below this there is no room for meters at all. */
const MINIMAL_WIDTH = 60;

const MAX_WIDTH = 100;
const NAME_WIDTH = 11;

export interface HudInfo {
  providerName: string;
  model: string;
  cwd: string;
  sessionId: string;
  version: string;
  stats: HudStats;
  /** Pre-rendered spend line, omitted when there is no OpenRouter key. */
  usageLine?: string;
  commands: string[];
}

export function renderHud(info: HudInfo, terminalWidth: number): string[] {
  const width = Math.min(MAX_WIDTH, Math.max(40, terminalWidth));
  if (width < MINIMAL_WIDTH) return renderMinimal(info, width);
  return width >= FULL_WIDTH ? renderFull(info, width) : renderCompact(info, width);
}

function linkRows(info: HudInfo): string[] {
  return [
    statRow('PROVIDER', info.providerName, NAME_WIDTH),
    statRow('MODEL', info.model, NAME_WIDTH),
    statRow('SESSION', info.sessionId, NAME_WIDTH),
    statRow('HOST', info.stats.host, NAME_WIDTH),
    statRow('NODE', info.stats.node, NAME_WIDTH),
    statRow('CWD', shortenHome(info.cwd), NAME_WIDTH),
  ];
}

function systemRows(stats: HudStats): string[] {
  // Each maximum is the point past which more stops being informative, not a
  // hard limit — meter() clamps, so exceeding one pegs the bar.
  return [
    statRow(
      'PROVIDERS',
      `${meter(stats.providersLinked, stats.providersTotal)}  ${stats.providersLinked}/${stats.providersTotal}`,
      NAME_WIDTH
    ),
    statRow('TOOLS', `${meter(stats.toolCount, 12)}  ${stats.toolCount}`, NAME_WIDTH),
    statRow('MEMORY', `${meter(stats.memoryCount, 25)}  ${stats.memoryCount}`, NAME_WIDTH),
    statRow('SKILLS', `${meter(stats.skillCount, 10)}  ${stats.skillCount}`, NAME_WIDTH),
    statRow('MCP', `${meter(stats.mcpServerCount, 5)}  ${stats.mcpServerCount}`, NAME_WIDTH),
  ];
}

function renderFull(info: HudInfo, width: number): string[] {
  const leftWidth = width - RETICLE_WIDTH - 4;
  // Rules stop short of the gutter, so they never butt into the reticle.
  const ruleWidth = leftWidth - 3;

  const left: string[] = [
    ...buildWordmark(),
    '',
    sectionRule('LINK', ruleWidth),
    ...linkRows(info),
    '',
    sectionRule('SYSTEMS', ruleWidth),
    ...systemRows(info.stats),
  ];

  const right: string[] = [
    ...buildReticle(info.stats.providersLinked > 0 ? 'ONLINE' : 'STANDBY'),
    '',
    sectionRule('COMMANDS', RETICLE_WIDTH),
    ...commandRows(info.commands, RETICLE_WIDTH),
  ];

  return [
    frameTop(`ROBIN v${info.version}`, width),
    '',
    ...zip(left, right, leftWidth),
    '',
    frameBottom(info.usageLine ?? 'no spend data', `${info.providerName} · ${info.model}`, width),
  ];
}

function renderCompact(info: HudInfo, width: number): string[] {
  return [
    frameTop(`ROBIN v${info.version}`, width),
    '',
    ...wordmarkFor(width),
    '',
    ...buildCompactReticle(info.stats.providersLinked > 0 ? 'ONLINE' : 'STANDBY'),
    '',
    sectionRule('LINK', width - 2),
    ...linkRows(info),
    '',
    sectionRule('SYSTEMS', width - 2),
    ...systemRows(info.stats),
    '',
    frameBottom(info.usageLine ?? '', `${info.providerName} · ${info.model}`, width),
  ];
}

/**
 * Too narrow for meters or a reticle. The wordmark and the connection facts
 * are what a user actually needs; the rest is what they would have lost to
 * wrapping anyway.
 */
function renderMinimal(info: HudInfo, width: number): string[] {
  return [...wordmarkFor(width), '', ...linkRows(info), '', mutedColor('─'.repeat(width))];
}

/**
 * The block wordmark is a fixed 49 columns. Below that it would overflow the
 * terminal, so a single-line form takes over rather than wrapping into noise.
 */
function wordmarkFor(width: number): string[] {
  return width < WORDMARK_WIDTH ? buildPlainWordmark() : buildWordmark();
}

/** Lays two columns side by side, padding the left to a fixed width. */
function zip(left: string[], right: string[], leftWidth: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    // Padded on visible width: a coloured cell would otherwise be counted as
    // far wider than it draws and the right column would stagger.
    const pad = Math.max(0, leftWidth - visibleLength(l));
    rows.push(`${l}${' '.repeat(pad)}${r}`.trimEnd());
  }
  return rows;
}

function commandRows(commands: string[], width: number): string[] {
  const perRow = 2;
  const cell = Math.floor((width - 2) / perRow);
  const shown = commands.slice(0, 8);
  const rows: string[] = [];
  for (let i = 0; i < shown.length; i += perRow) {
    rows.push(
      ' ' + shown.slice(i, i + perRow).map((c) => mutedColor(c.padEnd(cell))).join('')
    );
  }
  if (commands.length > shown.length) {
    rows.push(mutedColor(` … ${commands.length} total`));
  }
  return rows;
}

function shortenHome(dir: string): string {
  const home = os.homedir();
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}
