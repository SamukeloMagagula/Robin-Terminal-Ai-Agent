import os from 'node:os';
import { createRequire } from 'node:module';
import chalk from 'chalk';
import { GRADIENT, mutedColor, ruleWidth } from './theme.js';
import { buildCowl, COWL_WIDTH } from './cowl.js';
import { buildWordmark, buildPlainWordmark, WORDMARK_WIDTH } from './wordmark.js';
import { renderPanel } from './panel.js';
import { SLASH_COMMANDS } from '../repl/slash-prompt.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';

const MAX_WIDTH = 100;
const MIN_WIDTH = 60;
const DEFAULT_WIDTH = 80;
const STACK_BELOW = 90;
// The `Session: <id>` line is 29 wide and is the widest thing in the left
// column, so the gutter is sized from that, not from the cowl.
const LEFT_WIDTH = COWL_WIDTH + 7;
const COMMAND_NAME_WIDTH = 10;
const TOOL_NAME_WIDTH = 13;

const borderColor = chalk.hex(GRADIENT[0]);
const headingColor = chalk.hex(GRADIENT[2]).bold;

export interface BannerInfo {
  providerName: string;
  model: string;
  cwd: string;
  sessionId: string;
  toolsEnabled: boolean;
  /** Pre-rendered usage line, omitted when there is no OpenRouter key or the fetch failed. */
  usageLine?: string;
}

function readVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function shortenHome(dir: string): string {
  const home = os.homedir();
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

function buildLeftColumn(info: BannerInfo): string[] {
  return [
    ...buildCowl(),
    '',
    mutedColor(`${info.providerName} · ${info.model}`),
    mutedColor(shortenHome(info.cwd)),
    mutedColor(`Session: ${info.sessionId}`),
  ];
}

function buildUsageLines(info: BannerInfo): string[] {
  return info.usageLine ? ['', info.usageLine] : [];
}

// The tagline runs 52 characters, far wider than the left column, so it sits
// below the panel as full-width text rather than being truncated inside it.
function buildFooter(): string[] {
  return [
    mutedColor('Robin is a terminal agent that lets you run your AI.'),
    mutedColor('built by Samukelo "Batman" Magagula'),
  ];
}

function buildRightColumn(info: BannerInfo): string[] {
  const commands = SLASH_COMMANDS.map(
    (command) =>
      `${chalk.whiteBright(command.name.padEnd(COMMAND_NAME_WIDTH))}${mutedColor(command.description)}`,
  );
  const tools = TOOL_DEFINITIONS.map(
    (tool) => `${chalk.whiteBright(tool.name.padEnd(TOOL_NAME_WIDTH))}${mutedColor(tool.description)}`,
  );
  const toolState = info.toolsEnabled ? 'enabled' : 'disabled';
  const stats = `${TOOL_DEFINITIONS.length} tools · ${SLASH_COMMANDS.length} commands · /help for commands`;

  return [
    headingColor('Commands'),
    ...commands,
    '',
    `${headingColor('Tools')} ${mutedColor(`(${toolState})`)}`,
    ...tools,
    '',
    mutedColor(stats),
  ];
}

const INDENT = '  ';

function panelWidth(): number {
  const columns = process.stdout.columns ?? DEFAULT_WIDTH;
  return Math.max(Math.min(columns - INDENT.length, MAX_WIDTH), MIN_WIDTH);
}

export function buildBanner(info: BannerInfo): string[] {
  const columns = process.stdout.columns ?? DEFAULT_WIDTH;
  const width = panelWidth();
  const version = readVersion();
  const title = version ? `Robin v${version}` : 'Robin';

  const left = buildLeftColumn(info);
  const right = buildRightColumn(info);
  const stacked = columns < STACK_BELOW;

  const panel = renderPanel({
    title,
    left: stacked ? [...left, '', ...right] : left,
    right: stacked ? [] : right,
    width,
    leftWidth: stacked ? width - 4 : LEFT_WIDTH,
    borderColor,
  });

  const wordmark = columns < WORDMARK_WIDTH + 2 ? buildPlainWordmark() : buildWordmark();

  return [
    '',
    ...wordmark.map((row) => `${INDENT}${row}`),
    '',
    ...panel.map((row) => `${INDENT}${row}`),
    '',
    ...buildFooter().map((row) => `${INDENT}${row}`),
    ...buildUsageLines(info).map((row) => (row ? `${INDENT}${row}` : row)),
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
