import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildBanner, type BannerInfo } from '../../src/ui/banner';
import { visibleLength } from '../../src/ui/panel';
import { SLASH_COMMANDS } from '../../src/repl/slash-prompt';
import { TOOL_DEFINITIONS } from '../../src/tools/definitions';

const info: BannerInfo = {
  providerName: 'OpenAI',
  model: 'gpt-4o',
  cwd: '/somewhere/else',
  sessionId: '20260807_1432_a3f1c9',
  toolsEnabled: true,
};

const originalColumns = process.stdout.columns;

function render(overrides: Partial<BannerInfo> = {}, columns = 100): string {
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  return buildBanner({ ...info, ...overrides })
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '');
}

beforeEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
});

describe('buildBanner', () => {
  it('lists every slash command', () => {
    const output = render();
    for (const command of SLASH_COMMANDS) {
      expect(output).toContain(command.name);
    }
  });

  it('lists every tool', () => {
    const output = render();
    for (const tool of TOOL_DEFINITIONS) {
      expect(output).toContain(tool.name);
    }
  });

  it('reports counts taken from the source arrays', () => {
    expect(render()).toContain(
      `${TOOL_DEFINITIONS.length} tools · ${SLASH_COMMANDS.length} commands`,
    );
  });

  it('shows the tool-calling state', () => {
    expect(render()).toContain('(enabled)');
    expect(render({ toolsEnabled: false })).toContain('(disabled)');
  });

  it('shows provider, model and session id', () => {
    const output = render();
    expect(output).toContain('OpenAI · gpt-4o');
    expect(output).toContain('Session: 20260807_1432_a3f1c9');
  });

  it('shortens a cwd under the home directory', () => {
    const cwd = path.join(os.homedir(), 'Personal', 'ai-term-chat');
    const output = render({ cwd });
    expect(output).toContain(`~${path.sep}Personal${path.sep}ai-term-chat`);
    expect(output).not.toContain(os.homedir());
  });

  it('leaves a cwd outside the home directory alone', () => {
    expect(render({ cwd: '/somewhere/else' })).toContain('/somewhere/else');
  });

  it('keeps every line within the terminal width', () => {
    for (const columns of [60, 80, 100, 140]) {
      const lines = render({}, columns).split('\n');
      for (const line of lines) {
        expect(visibleLength(line)).toBeLessThanOrEqual(Math.max(columns, 62));
      }
    }
  });

  it('falls back to the plain wordmark on a narrow terminal', () => {
    const output = render({}, 40);
    expect(output).toContain('ROBIN');
    expect(output).not.toContain('█████████');
  });

  it('keeps the block wordmark on a wide terminal', () => {
    expect(render({}, 100)).toContain('█████████');
  });

  it('renders without throwing when columns is undefined', () => {
    Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
    expect(() => buildBanner(info)).not.toThrow();
  });

  it('includes the tagline and author', () => {
    const output = render();
    expect(output).toContain('Robin is a terminal agent');
    expect(output).toContain('Samukelo "Batman" Magagula');
  });
});
