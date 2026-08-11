# HUD startup screen

Date: 2026-08-11

## Goal

Replace Robin's startup banner with a futuristic HUD modelled on a reference
sci-fi interface: cyan-on-black, corner-bracket chrome, a concentric reticle,
labelled section rules, and bar meters.

Supersedes `2026-08-07-hermes-style-banner-design.md`, which introduced the
current wordmark-plus-panel screen. The wordmark and the gradient survive; the
single bordered panel does not.

## Three decisions that shape everything

**1. Startup screen only.** The reference is a fixed full-screen HUD where
every panel is visible at once. Robin is a scrolling REPL where output flows
down forever. A persistent frame would mean the alternate screen buffer, full
repaint on resize, broken scrollback copy-paste, and a fight with inquirer's
prompts. The HUD is therefore a one-shot screen that scrolls away, and no
part of the REPL's rendering model changes.

**2. The cowl stays, ringed by the reticle.** The bat is the project's
identity. Replacing it with a bare reticle would match the reference more
closely and cost more than it gains, so the reticle wraps it instead — the
cowl reads as the thing the HUD is tracking.

**3. Every figure is real.** The reference's globe, radar and wireframe solid
correspond to no data. Robin has genuine state worth surfacing, so nothing on
screen is decorative. A meter that always reads the same is a lie, and this is
a codebase that wraps untrusted output and reports honest test counts.

## Components

Five pure modules under `src/ui/hud/`, plus a slimmed caller:

| Module | Responsibility |
|---|---|
| `frame.ts` | Corner-bracket chrome and labelled section rules |
| `reticle.ts` | Concentric arcs with the cowl inset |
| `meter.ts` | `▰▰▰▱▱` bars and the `▁▂▃▅` column chart |
| `telemetry.ts` | Gathers real state into one `HudStats` value |
| `layout.ts` | Composes the regions at the terminal's width |
| `banner.ts` (modify) | Becomes a caller; keeps `printBanner`'s signature |

`panel.ts` is reused unchanged. Its `visibleLength` and `fitCell` already do
ANSI-aware measurement and truncation, which is exactly what the frame needs —
re-implementing them is where the bug would be.

`environment-prompt.ts` exports its existing `platformName()` rather than the
HUD writing a second copy of the same platform switch.

## What each figure means

| Row | Source | Note |
|---|---|---|
| `PROVIDERS n/5` | Providers with stored credentials in `auth.json` | Labelled **LINKED**, not "online" |
| `TOOLS n` | Built-ins + memory + skills + connected MCP tools | Armed for this session |
| `MEMORY n` | `MemoryStore.list().length` | Local read |
| `SKILLS n` | `SkillStore.list().length` | Local read |
| `MCP n` | Servers that actually connected | Reflects the trust gate's outcome |
| `HOST` | `platformName()`, `os.release()`, `process.arch` | |
| `NODE` | `process.version` | |
| spend | `UsageCache.peek()` | Cache only |

**No HUD figure may block on the network.** That is why `PROVIDERS` counts
credentials rather than pinging: `isAuthenticated()` is a local file read for
the API-key providers but a live HTTP call for Ollama, and the banner must
never wait on one. Counting credentials is instant and the label says exactly
what was counted.

**Zeroes are shown, not hidden.** A fresh install reads `MCP ▱▱▱▱▱ 0`. It is
honest, and it advertises a feature the user may not know exists.

## Degradation

| Terminal width | Renders |
|---|---|
| ≥ 90 | Full three-region layout |
| 60–89 | Compact 3-line arc instead of the full reticle; panels stack |
| < 60 | Wordmark and LINK rows only — no reticle, no meters |

If telemetry throws, the HUD renders with whatever rows it gathered. A broken
memory directory must not cost the user their banner, matching how every store
in this codebase already degrades.

## Testing

`frame.ts`, `meter.ts` and `reticle.ts` are pure string functions and get real
assertions rather than snapshots: every emitted row is exactly the declared
width when measured with `visibleLength`, meters clamp at zero and at maximum,
and `layout.ts` selects the right variant at 100, 80 and 50 columns.

`telemetry.ts` is tested against temp directories, covering the all-zero case
and a store whose read throws.

`tests/ui/banner.test.ts` **will need updating** — the banner's content changes
by design. Each changed assertion is a deliberate consequence, and the commit
must say which and why. An assertion that cannot be explained that way is a
regression, not an update.

## Out of scope

- A persistent HUD frame or alternate-screen TUI.
- Animation of any kind. A one-shot screen has nothing to animate, and a
  spinner in the banner would fight the streaming reply that follows it.
- Restyling mid-conversation output: dividers, approval prompts and panels keep
  their current look. Changing those is a separate decision about every frame,
  not about the startup screen.
- Colour themes or a way to turn the HUD off. Neither is asked for yet.
