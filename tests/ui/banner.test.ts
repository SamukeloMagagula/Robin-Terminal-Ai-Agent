import { describe, it, expect, afterEach } from 'vitest';
import { buildBanner } from '../../src/ui/banner';
import { visibleLength } from '../../src/ui/panel';
import type { HudStats } from '../../src/ui/hud/telemetry';

const original = process.stdout.columns;

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { value: original, configurable: true });
});

function atWidth(columns: number): void {
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
}

function stats(overrides: Partial<HudStats> = {}): HudStats {
  return {
    providersLinked: 4,
    providersTotal: 5,
    toolCount: 7,
    memoryCount: 12,
    skillCount: 3,
    mcpServerCount: 2,
    host: 'Linux 6.1.0 · x64',
    node: 'v20.19.4',
    ...overrides,
  };
}

function banner(overrides: Record<string, unknown> = {}): string {
  return buildBanner({
    providerName: 'GitHub Copilot',
    model: 'gpt-4o',
    cwd: '/home/me/code',
    sessionId: 'abc123',
    toolsEnabled: true,
    stats: stats(),
    ...overrides,
  }).join('\n');
}

describe('buildBanner', () => {
  it('shows provider, model and session id', () => {
    atWidth(100);
    const out = banner();
    expect(out).toContain('GitHub Copilot');
    expect(out).toContain('gpt-4o');
    expect(out).toContain('abc123');
  });

  it('shows the host operating system', () => {
    atWidth(100);
    expect(banner()).toContain('Linux 6.1.0');
  });

  it('shows the meters with their real figures', () => {
    atWidth(100);
    const out = banner();
    expect(out).toContain('4/5');
    expect(out).toMatch(/MEMORY.*12/);
    expect(out).toMatch(/MCP.*2/);
  });

  it('includes the author line', () => {
    atWidth(100);
    expect(banner()).toContain('Samukelo "Batman" Magagula');
  });

  it('keeps the cowl at the centre of the reticle', () => {
    // This used to assert only that a `●` appeared somewhere, which stayed
    // green while the cowl sat a column right of the rings around it. The
    // padding either side of the art is what the name was claiming.
    atWidth(100);
    const eyeRow = banner()
      .split('\n')
      .map((line) => line.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), ''))
      .find((line) => line.includes('●'));
    expect(eyeRow).toBeDefined();

    const inner = (eyeRow as string).slice(
      (eyeRow as string).indexOf('│') + 1,
      (eyeRow as string).lastIndexOf('│')
    );
    const left = inner.length - inner.trimStart().length;
    const right = inner.length - inner.trimEnd().length;
    expect(left).toBe(right);
  });

  it('lists commands, and says how many were not shown', () => {
    atWidth(100);
    const out = banner();
    expect(out).toContain('/help');
    expect(out).toMatch(/…\s+\d+ total/);
  });

  it('renders without stats rather than failing', () => {
    // A caller that gathered no telemetry still gets a banner; the meters
    // simply read zero.
    atWidth(100);
    expect(() => buildBanner({
      providerName: 'Ollama',
      model: 'llama3.1',
      cwd: '/tmp',
      sessionId: 'x',
      toolsEnabled: false,
    })).not.toThrow();
  });

  it('never emits a row wider than the terminal', () => {
    for (const width of [50, 70, 100, 140]) {
      atWidth(width);
      for (const row of buildBanner({
        providerName: 'GitHub Copilot',
        model: 'gpt-4o',
        cwd: '/home/me/code',
        sessionId: 'abc123',
        toolsEnabled: true,
        stats: stats(),
      })) {
        expect(visibleLength(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('drops the meters on a narrow terminal but keeps the connection facts', () => {
    atWidth(50);
    const out = banner();
    expect(out).toContain('GitHub Copilot');
    expect(out).not.toContain('PROVIDERS');
  });

  it('reads zero tools when tool-calling is disabled', () => {
    // The HUD ignored toolsEnabled entirely, so it claimed capability the
    // model did not have for that turn.
    atWidth(100);
    const out = banner({ toolsEnabled: false });
    expect(out).toMatch(/TOOLS\s+▱▱▱▱▱\s+0/);
  });
});
