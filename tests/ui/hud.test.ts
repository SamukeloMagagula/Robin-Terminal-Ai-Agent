import { describe, it, expect } from 'vitest';
import { meter, sparkline } from '../../src/ui/hud/meter';
import { frameTop, frameBottom, sectionRule, arcCap } from '../../src/ui/hud/frame';
import { buildReticle, buildCompactReticle } from '../../src/ui/hud/reticle';
import { renderHud } from '../../src/ui/hud/layout';
import { visibleLength } from '../../src/ui/panel';
import type { HudStats } from '../../src/ui/hud/telemetry';

function stats(overrides: Partial<HudStats> = {}): HudStats {
  return {
    providersLinked: 4,
    providersTotal: 5,
    toolCount: 7,
    memoryCount: 12,
    skillCount: 3,
    mcpServerCount: 0,
    host: 'Linux 6.1.0 · x64',
    node: 'v20.19.4',
    ...overrides,
  };
}

function hud(width: number, overrides: Partial<HudStats> = {}): string[] {
  return renderHud(
    {
      providerName: 'anthropic',
      model: 'claude-opus-5',
      cwd: '/home/me/code',
      sessionId: '7f3a2b',
      version: '0.1.0',
      stats: stats(overrides),
      usageLine: '$0.42 today',
      commands: ['/help', '/model', '/provider', '/system'],
    },
    width
  );
}

describe('meter', () => {
  it('fills proportionally', () => {
    expect(visibleLength(meter(4, 5))).toBe(5);
    expect(meter(4, 5)).toContain('▰');
    expect(meter(4, 5)).toContain('▱');
  });

  it('is empty at zero and full at maximum', () => {
    expect(meter(0, 5)).not.toContain('▰');
    expect(meter(5, 5)).not.toContain('▱');
  });

  it('clamps above the maximum rather than drawing a longer bar', () => {
    // A longer bar would break the column alignment of everything beside it.
    expect(visibleLength(meter(500, 5))).toBe(5);
    expect(meter(500, 5)).not.toContain('▱');
  });

  it('shows at least one segment for any non-zero value', () => {
    // Rounding 1-of-50 down to empty would read as "none", a different fact.
    expect(meter(1, 50)).toContain('▰');
  });

  it('survives a zero or nonsense maximum', () => {
    expect(visibleLength(meter(3, 0))).toBe(5);
    expect(visibleLength(meter(Number.NaN, 5))).toBe(5);
  });
});

describe('sparkline', () => {
  it('renders one column per value', () => {
    expect(visibleLength(sparkline([1, 2, 3, 4]))).toBe(4);
  });

  it('handles an all-zero series without dividing by zero', () => {
    expect(visibleLength(sparkline([0, 0, 0]))).toBe(3);
  });

  it('is empty for no values', () => {
    expect(sparkline([])).toBe('');
  });
});

describe('frame', () => {
  it('draws the top rule at exactly the requested width', () => {
    for (const width of [40, 60, 80, 100]) {
      expect(visibleLength(frameTop('ROBIN v0.1.0', width))).toBe(width);
    }
  });

  it('draws the bottom rule at exactly the requested width', () => {
    for (const width of [40, 60, 80, 100]) {
      expect(visibleLength(frameBottom('$0.42', 'anthropic', width))).toBe(width);
    }
  });

  it('degrades instead of overflowing when the title will not fit', () => {
    const row = frameTop('AN EXTREMELY LONG TITLE THAT CANNOT POSSIBLY FIT', 20);
    expect(visibleLength(row)).toBeLessThanOrEqual(20);
  });

  it('draws a section rule at the requested width', () => {
    expect(visibleLength(sectionRule('LINK', 40))).toBe(40);
  });

  it('centres the arc caption at the requested width', () => {
    expect(visibleLength(arcCap('ONLINE', 34, false))).toBe(34);
    expect(visibleLength(arcCap('', 34, true))).toBe(34);
  });
});

describe('reticle', () => {
  it('keeps the cowl inside the rings', () => {
    const rows = buildReticle('ONLINE').join('\n');
    // The cowl's eyes and jaw are the identity; the rings must not replace it.
    expect(rows).toContain('●');
    expect(rows).toContain('▀▀▀▀▀▀▀▀▀');
  });

  it('sets the status word into the lower arc', () => {
    expect(buildReticle('STANDBY').join('\n')).toContain('STANDBY');
  });

  it('has a compact form for narrow terminals', () => {
    expect(buildCompactReticle('ONLINE')).toHaveLength(3);
  });
});

describe('renderHud', () => {
  it('shows the reticle and meters at a wide terminal', () => {
    const out = hud(100).join('\n');
    expect(out).toContain('●'); // reticle with cowl
    expect(out).toContain('PROVIDERS');
    expect(out).toContain('4/5');
  });

  it('drops the full reticle but keeps meters at a medium terminal', () => {
    const out = hud(80).join('\n');
    expect(out).toContain('PROVIDERS');
    expect(out).toContain('((( ● )))'); // compact arc
  });

  it('falls back to wordmark and link rows at a narrow terminal', () => {
    const out = hud(50).join('\n');
    expect(out).toContain('anthropic');
    expect(out).not.toContain('PROVIDERS');
  });

  it('never emits a row wider than the terminal', () => {
    for (const width of [50, 80, 100]) {
      for (const row of hud(width)) {
        expect(visibleLength(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('shows zero rows rather than hiding them', () => {
    // A fresh install should advertise the features it has, not conceal them.
    const out = hud(100, { memoryCount: 0, skillCount: 0, mcpServerCount: 0 }).join('\n');
    expect(out).toContain('MEMORY');
    expect(out).toContain('MCP');
  });

  it('reads STANDBY when no provider is linked', () => {
    expect(hud(100, { providersLinked: 0 }).join('\n')).toContain('STANDBY');
  });

  it('reports the host operating system', () => {
    expect(hud(100).join('\n')).toContain('Linux 6.1.0');
  });
});
