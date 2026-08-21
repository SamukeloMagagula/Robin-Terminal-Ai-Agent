# Screen capture tool

Date: 2026-08-21

## Goal

Give Robin a `describe_screen` tool: capture the operator's screen and
describe what's on it, alongside the existing media tools (`generate_image`,
`speak`, `transcribe`).

## Why this shape

The existing media tools (`src/media/tools.ts`) are all remote API calls
through the Gemini key Robin already has — nothing in them touches the local
machine beyond reading or writing a file. Screen capture is different: it's
the first tool that reads something with no file path at all, the literal
pixels currently on the operator's display. That difference drives two
decisions below.

**Route through Gemini vision, not multimodal attachment.** Rather than
widening `Message.content` (currently plain `string`) to carry images and
teaching every provider adapter (Anthropic, Gemini, Copilot, OpenAI-
compatible, Ollama) to send them, `describe_screen` sends the capture to
Gemini's vision API and returns a text description — same shape as
`transcribe`. This works no matter which provider is actively answering the
conversation, and touches nothing outside `src/media/`.

**A new confirm kind that is deliberately never grantable unattended.**
`ConfirmRequest['kind']` (`src/tools/execute.ts`) gains `'capture_screen'`.
`RuleKind` in `src/autonomy/manifest.ts` is derived directly from that union,
but `ruleMatches`'s switch only has cases for the four existing kinds and
falls through to `default: return false` for anything else. This spec adds
no case for `capture_screen` there, and no `--capture-screen` flag to
`robin autonomy grant` — so no capability manifest can ever authorise a
screenshot for an unattended run, full stop. It always needs a live human at
a terminal to approve it in the moment, the same outcome a request gets today
when nobody is attached to ask. A screenshot exposes the operator's entire
visible desktop, which is a bigger blast radius than any single file read,
and that asymmetry is worth being structural rather than a policy someone
could accidentally grant.

**No native npm dependency.** Capture shells out to each OS's own tool
rather than pulling in a native screenshot package (and the build-toolchain
risk that comes with one — `better-sqlite3` in this very repo already needs
a C++ toolchain on some machines). Every platform writes to a randomly named
temp file and Robin reads it back, rather than trying to pipe image bytes
through stdout — one code path works the same way on all three platforms
instead of three different streaming conventions.

## Capture: `src/media/screen-capture.ts`

```ts
export async function captureScreen(): Promise<Media>; // Media = { data: Buffer; mimeType: string }
```

Captures the full virtual desktop (every monitor's combined bounding box) —
selecting a single monitor is out of scope for v1. Always runs directly on
the host process, bypassing any configured `ExecutionBackend` entirely: a
screenshot means "what's on *my* screen," not wherever `run_command` would
execute, the same reason the existing media tools call Gemini directly
rather than through `run_command`.

1. Generate a temp path: `path.join(os.tmpdir(), \`robin-screen-${randomUUID()}.png\`)`.
2. Dispatch on `process.platform`:
   - **`win32`** — spawn `powershell -NoProfile -Command` running a script
     that loads `System.Windows.Forms` and `System.Drawing` (both ship with
     .NET, nothing to install), reads
     `[System.Windows.Forms.SystemInformation]::VirtualScreen` for the
     combined bounds, `Graphics.CopyFromScreen` into a `Bitmap`, and saves it
     to the temp path as PNG.
   - **`darwin`** — spawn `screencapture -x -t png <tempPath>` (`-x`
     suppresses the shutter sound; both flags are standard on every macOS
     version this codebase otherwise supports).
   - **`linux`** — probe `command -v` for, in order: `grim` (Wayland),
     `scrot`, `gnome-screenshot`, `import` (ImageMagick's CLI). Use the
     first one found, each invoked to write directly to the temp path
     (`grim <tempPath>`, `scrot <tempPath>`, `gnome-screenshot -f
     <tempPath>`, `import -window root <tempPath>`). None found → throw
     naming all four and pointing at installing one.
3. Spawn with a fixed timeout (10s) — a hung capture (e.g. a Wayland
   compositor's permission dialog nobody answers) must not hang the tool
   call forever. A non-zero exit or timeout throws with the tool's own
   stderr, the same "the API's own message says what is wrong" philosophy
   `client.ts` already follows.
4. Read the temp file into a `Buffer`, `mimeType: 'image/png'`.
5. Delete the temp file — best-effort; a failed delete is logged, not
   thrown, since the capture itself already succeeded.

No resizing or byte-size cap in v1. A typical screenshot is far smaller than
the 20MB `MAX_AUDIO_BYTES` cap `transcribe` needs for raw audio; if a huge
multi-monitor capture ever proves to be a real problem, Gemini's own error on
an oversized request is the same signal `client.ts` already surfaces
verbatim for every other failure — no need to guess at a cap ahead of that.

## Vision: `MediaClient.describeImage`

New method on the interface in `src/media/client.ts`, alongside
`generateImage`/`speak`/`transcribe`:

```ts
describeImage(image: Buffer, mimeType: string, prompt: string): Promise<string>;
```

Implemented in `createGeminiMedia` the same way `transcribe` is: one `call()`
to the configured vision model with
`contents: [{ parts: [{ inlineData: { mimeType, data: image.toString('base64') } }, { text: prompt }] }]`
and `generationConfig: { responseModalities: ['TEXT'] }`, joining the
response's text parts. An empty result throws `'Gemini returned no
description.'`, matching `transcribe`'s `'Gemini returned no transcript.'`.

`MediaModels` (`src/media/client.ts`) gains a fourth model id,
`vision: string`, resolved the same way `image`/`speech`/`transcribe` already
are — a setting, not a constant, for the same reason the comment at the top
of that file already gives: Google renames these models often enough that a
rename should be `robin config set`, not a release.

## Tool: `describe_screen`

New entry in `MEDIA_TOOL_DEFINITIONS` and a new function in
`src/media/tools.ts`, following `transcribeTool`'s shape:

```ts
export async function describeScreenTool(
  args: Record<string, unknown>,
  confirm: ConfirmFn,
  media: MediaClient,
  capture: () => Promise<Media> = captureScreen
): Promise<string>;
```

`capture` is injectable so tests never actually take a screenshot — the same
role `media: MediaClient` already plays for the other three tools being
fakeable in their own tests.

Tool definition:

```ts
{
  name: 'describe_screen',
  description:
    'Capture the current screen and describe what is on it. The user is asked ' +
    'before anything is captured. Optionally focus the description with a prompt, ' +
    'e.g. "what error is shown?".',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What to look for or ask about the screenshot. Defaults to a general description.',
      },
    },
  },
}
```

No required arguments — an empty call is a valid "just describe it."

**Flow**, confirm-before-capture same as every other media tool:

1. `prompt` defaults to `'Describe what is on the screen.'` when absent or
   blank.
2. `confirm({ kind: 'capture_screen', subject: 'screen', message: ... })`.
   Declined → `'Screen capture was declined by the user.'`, nothing is
   captured.
3. `capture()`. A thrown error → `Error: ${message}`, same as every other
   tool's failure shape in this file.
4. `media.describeImage(captured.data, captured.mimeType, prompt)`. A thrown
   error → `Error: ${message}`.
5. Returns the description text.

## Wiring

- `src/tools/execute.ts`: `ConfirmRequest['kind']` widens to include
  `'capture_screen'`. `ExecuteOptions.media`'s doc comment widens to name
  `describe_screen` alongside the other three. `executeTool`'s switch gains
  `case 'describe_screen':`, gated on `options.media` with the existing
  `MEDIA_UNAVAILABLE` constant, exactly like the other three cases.
- `src/repl/run-repl.ts`: `APPROVAL_WORDING` is a
  `Record<ConfirmRequest['kind'], ...>` — the compiler forces an entry here.
  `{ question: 'Capture it?', scope: 'screen captures' }`.
- `src/commands/autonomy-command.ts`: `KIND_LABELS` is a
  `Record<RuleKind, string>` — the compiler forces an entry here too, even
  though nothing ever produces a `capture_screen` rule through the CLI:
  `capture_screen: 'capture'`. This exists only so a manifest file someone
  hand-edited to include a `capture_screen` rule renders sensibly if ever
  listed — `ruleMatches`'s `default: return false` (unchanged, no case
  added) is what actually keeps such a rule permanently inert.
  `FLAG_KINDS` gets **no** new entry — there is deliberately no
  `--capture-screen` flag on `robin autonomy grant`.
- `src/media/tools.ts`: `MEDIA_TOOL_DEFINITIONS` gains the `describe_screen`
  definition.

## Testing

- `tests/media/screen-capture.test.ts`: dispatches to the right command per
  `process.platform` (mocked), reads the temp file back correctly, deletes
  it afterward, and surfaces the spawned process's stderr on a non-zero
  exit or on timeout. Uses an injected spawn function rather than actually
  invoking OS tools or `process.platform`-branching for real — this is
  infrastructure code that touches the real OS, same caution
  `tests/channels/whatsapp.test.ts` already applies to *not* mocking its own
  HTTP layer where the logic is worth exercising for real, inverted here
  because there is no safe "real" version of taking a screenshot in CI.
- `src/media/client.ts`'s existing test file gains cases for
  `describeImage`: sends the expected `inlineData`/prompt body, returns the
  joined text, throws on an empty response — mirroring the existing
  `transcribe` cases exactly.
- `tests/media/tools.test.ts` (or wherever the existing three tools are
  tested) gains cases for `describeScreenTool`: confirms before capturing,
  returns the decline message without capturing when refused, propagates a
  capture error, propagates a `describeImage` error, returns the
  description on success, defaults the prompt when absent.
- `tests/tools/execute.test.ts`: `describe_screen` returns `MEDIA_UNAVAILABLE`
  when `options.media` is absent, dispatches to `describeScreenTool` when
  present.
- `tests/repl/*` and `tests/autonomy/manifest-command.test.ts` (or wherever
  `APPROVAL_WORDING`/`KIND_LABELS` are exercised) gain the new kind's
  entries so the exhaustiveness the compiler already enforces is backed by
  a runtime assertion too.
- `tests/autonomy/manifest.test.ts` gains a case: a hand-constructed rule of
  kind `capture_screen` never matches a `capture_screen` request, regardless
  of pattern — the explicit assertion behind this spec's central security
  decision.

## Out of scope

- **Camera capture.** A separate, later spec if actually wanted — device
  enumeration, OS permission prompts, and capture APIs differ enough per
  platform that bundling it here would roughly triple this feature's
  surface for a much less common use case than screenshots.
- **Per-monitor selection.** Captures the full virtual desktop; picking one
  display is a later enhancement if asked for.
- **Saving a copy to disk.** `describe_screen` returns text only, the same
  as `transcribe`; no `path` parameter like `generate_image`/`speak` have.
  Worth adding later if wanted, not needed for the description use case.
- **Image resizing or a byte-size cap**, as discussed above.
- **Wayland/X11 permission dialogs.** Entirely the compositor's own OS-level
  UI, outside Robin's control; a denial there surfaces as the underlying
  tool's own stderr through the same error path every other capture failure
  takes.
