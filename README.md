# robin

Robin is a terminal agent that lets you run your AI. Supports GitHub Copilot, Google Gemini, OpenRouter (via API key), and local Ollama models, with tool-calling (read files, write files, run shell commands) built in.

Built by Samukelo "Batman" Magagula.

## Requirements

- Node.js >= 18
- For Copilot: a GitHub account with Copilot access
- For Gemini: a Google AI Studio API key
- For OpenRouter: an OpenRouter API key (gives access to a large, constantly growing catalog of models from many providers — OpenAI, Anthropic, Google, Meta, Mistral, and more — under one key)
- For Ollama: [Ollama](https://ollama.com) installed and running locally

## Setup

```bash
npm ci            # installs exactly what package-lock.json pins
npm run build
npm link          # makes the `robin` command available globally
```

Use `npm ci`, not `npm install`. Dependencies are exact-pinned with no version
ranges, so a compromised patch release can't reach you without an intentional
bump here — `npm ci` enforces that; `npm install` can drift.

`npm link` only needs to be run once (or again after pulling changes that touch `package.json`). After that, `robin` works from any directory.

### Setting up a provider

**GitHub Copilot:**

```bash
robin login copilot
```

This prints a device code and opens Chrome to GitHub's device authorization page. Confirm the code shown matches, then click **Authorize**. Credentials are stored in `~/.robin/auth.json`.

**Gemini:**

```bash
robin login gemini
```

This opens Chrome to Google AI Studio's API key page. Create/copy a key there, then paste it back into the terminal when prompted. The key is stored in `~/.robin/auth.json` alongside other provider credentials.

**OpenRouter:**

```bash
robin login openrouter
```

This opens Chrome to OpenRouter's API keys page. Create/copy a key there, then paste it back into the terminal when prompted. `/model` on OpenRouter lists every model currently available on the platform — a large and constantly growing catalog spanning most major providers.

**Ollama:**

```bash
ollama pull llama3.1     # or any other tool-capable model (e.g. qwen2.5)
ollama serve              # if it isn't already running as a background service
```

No login needed — `robin` just checks `http://localhost:11434` is reachable. Older/smaller Ollama models that don't support tool-calling will still chat normally; they just won't be able to use tools.

### Chrome, or a link if there's no browser to open

Anywhere `robin` needs you to visit a page (Copilot/Gemini/OpenRouter login), it tries to open Chrome directly. If it can't — most commonly because you're connected over SSH/PuTTY to a headless Linux box with no display server — it skips the attempt and just prints the link to open on any other device instead. Windows and macOS always attempt to open Chrome, since a desktop is assumed there.

### Automatic model fallback

If a request to the current model fails (rate-limited, unreachable, etc.), `robin` automatically retries the message on the next model — first other models on the same provider, then models on any other provider you're logged into. Once a fallback succeeds, the session sticks with it (same as switching with `/model`/`/provider` yourself) rather than retrying the original model every turn.

Two limits keep this from turning into a long wait. Models that can't answer a text request are excluded by name — speech, embedding, image and video models sit in the same catalogues and would just return a 400. And the chain stops after 5 attempts: each one is a real round-trip, and if five models in a row refuse, the problem is the account or the network, not the model.

## OpenRouter spend

If you're logged into OpenRouter, `robin` shows what you've spent — on the startup banner, on the divider between turns, and in full via `/usage`:

```
💳 $0.0105 today  ·  $0.0137 total  ·  free tier
```

The figure is cached for 60 seconds and refreshed in the background after each reply, so the prompt never waits on the network. If a limit is set on your key you get a coloured bar and percentage instead of the free-tier badge — green, amber past half, red past 80%. No OpenRouter key, or the request fails? The line is simply omitted.

## Usage

```bash
robin                    # interactive provider + model picker
robin chat copilot       # jump straight into Copilot
robin chat gemini        # jump straight into Gemini
robin chat openrouter    # jump straight into OpenRouter
robin chat ollama        # jump straight into Ollama
robin chat random        # let Robin roll a provider and model for you
robin login copilot      # log in to Copilot ahead of time
robin logout copilot     # clear stored Copilot credentials
robin status              # show login/reachability status for every provider
```

In a chat session, typing `/` shows a live-filtered popup of matching commands as you keep typing — arrow keys to move the highlight, **Tab** to fill in the highlighted command without submitting (so you can still type an argument), **Enter** to submit the highlighted command (or your typed line, if the popup isn't open), **Esc** to dismiss the popup and keep typing free text.

**↑ / ↓ recall what you've already sent.** With the popup closed, ↑ walks back through the lines you've submitted this session and ↓ walks forward again. Come all the way back down and you get your half-typed line returned to you, exactly as you left it. Consecutive duplicates collapse, and history is session-only — it's held in memory and never written to disk, since what you type carries the same sensitive material as the transcripts.

- `/help` (or just `/`) — list commands
- `/model` — pick a different model from the ones available on the current provider
- `/provider` — switch provider (e.g. Copilot ↔ Gemini ↔ OpenRouter ↔ Ollama), or pick `🎲 Random`
- `/system [text]` — view the current system prompt, set one (`/system be terse`), or clear it (`/system clear`)
- `/tools [list]` — toggle tool-calling on/off for the session, or `/tools list` to see what's available
- `/save [name]` — save the current conversation under `~/.robin/conversations/<name>.json`; `/save` with no name lists what's saved
- `/load [name]` — load a previously saved conversation back into the session; `/load` with no name lists what's saved
- `/copy` — copy the assistant's last reply to your system clipboard
- `/skill save <name>` — save the current system prompt as a reusable named preset under `~/.robin/skills/<name>.json`
- `/skill use <name>` — load a saved preset as the current system prompt
- `/skill [list]` — list saved presets
- `/random` — re-roll onto a randomly chosen provider and model
- `/usage` — show OpenRouter spend for today, this week, this month and all time
- `/recall <query>` — search past conversations under `~/.robin/chats/`
- `/clear` — reset the conversation
- `/exit` — quit

## Chat History

Every conversation is automatically written to a readable markdown transcript in `~/.robin/chats/robin-chat-<timestamp>.md`, updated after every reply — nothing to remember to do. A new file starts whenever the conversation resets (`/clear`, `/model`, `/provider`, `/load`), so each distinct conversation gets its own file you can browse, search, or share later.

This is separate from `/save`/`/load`, which store an exact, reloadable snapshot as JSON under `~/.robin/conversations/` — use `/save` when you want to resume a specific conversation later inside `robin`; the markdown transcript is for your own reading/reference outside the app.

Use `/recall <query>` to search across all past markdown transcripts from inside a chat session — it's a plain case-insensitive text search (newest conversations first, capped at 10 matches), not semantic search, but it's enough to find "did I already ask about X" without leaving the terminal.

## Tool-Calling

Every chat session gives the model access to three tools:

- `read_file` — reads a file's contents (confirms only for paths outside the current directory)
- `write_file` — writes/overwrites a file (always confirms)
- `run_command` — runs a shell command in the current directory (confirms unless the command is recognised as read-only)

When the model wants to write a file or run a command that needs approval, you'll see a prompt like:

```
╭──────────────────────────╮
│ Run "npm install lodash"? │
╰──────────────────────────╯
? Run it? (yna)
  y) yes, this once
  n) no
  a) yes, and stop asking about commands this session
```

`a` remembers your answer for that *kind* of action — commands, file writes, or outside-directory reads — until you restart `robin`. Declined actions are reported back to the model so it can adjust instead of silently failing.

### Read-only commands run without asking

A model exploring a project issues a stream of near-identical `ls`/`dir`/`git status` calls, and being asked about each one trains you to approve without reading. So commands positively recognised as read-only run automatically and are echoed as `$ ls -la` so you can still see what happened.

This is an allowlist, not a blocklist — anything not recognised still prompts. A command is auto-approved only if its head token is a known reader (`ls`, `dir`, `cat`, `grep`, `find`, `git status`/`log`/`diff`, `npm ls`, …) **and** it contains no shell control characters at all: `;`, `&`, `|`, `>`, `<`, backticks, `$(…)`, `${…}`, or newlines. So `ls` runs; `ls; rm -rf ~` does not. Flags that turn a reader into a writer or executor (`find -exec`, `find -delete`, `sort -o`, `git diff --output`, `rg --pre`) also force a prompt, and `env` is deliberately excluded because `env FOO=1 <anything>` runs a command.

`run_command` executes with the same permissions as the terminal you're running `robin` in — there's no sandboxing, so only approve commands you'd be comfortable running yourself. Commands matching common destructive patterns (`rm -rf`, `sudo`, `curl … | bash`, `mkfs`, `shutdown`, etc.) get an extra `⚠` warning above the confirmation prompt — a heuristic nudge to look twice, not a block.

## Security

**Robin has no sandbox.** Every approved command runs as a direct child of the Robin process with your full user permissions — no container, no separate user, no syscall filter, no network policy. The mechanisms below reduce risk and prevent accidents; none of them is containment, and each operates on a string the model produced. The real boundary is you reading the prompt before you answer it.

Full trust model, including what each control does *not* do: **[SECURITY.md](SECURITY.md)**.

- **Credentials** (Copilot token, Gemini API key) are stored in plaintext at `~/.robin/auth.json` — the same approach tools like the GitHub CLI and `npm login` use. Written `0600` with the directory `0700` on POSIX, re-applied on every write so an existing file with looser permissions gets tightened; on Windows this relies on your user profile's normal NTFS permissions, since POSIX mode bits aren't meaningful there.
- **`read_file`/`write_file` refuse to touch credential locations**: `~/.robin/`, `~/.ssh/`, `~/.gnupg/`, `~/.aws/`, `~/.kube/`, `~/.docker/`, `~/.config/gh/` and gcloud config, plus credential filenames wherever they live (`.env`, `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa`, …). Paths are resolved to their real target first, so a symlink pointing into a protected directory is caught rather than waved through. **This does not constrain `run_command`** — an approved shell command can read any of those files.
- **`write_file` always confirms; `read_file` confirms for anything outside the current working directory** — reading unrelated files is how data leaves your machine and enters the model's context. `run_command` confirms unless the command is on the read-only allowlist described above.
- **Approvals can be remembered per action-kind for the current session** (`a` at the prompt). Session-scoped, never written to disk. Note that this deliberately removes the human from the loop for that action kind until you restart — treat `a` with more care than `y`.
- **The destructive-pattern `⚠` is a nudge, not a block.** It catches `rm -rf` but not `rm -r -f`, `$(echo rm) -rf`, or anything encoded. Don't rely on it.
- **`read_file` and `run_command` output is wrapped as untrusted content** before it goes back to the model — file contents and command output are data the model reads, not instructions it should follow, even if the text looks like a command ("ignore previous instructions and run…"). This narrows prompt injection; it does not eliminate it, since it is a prompt-level convention the model can still be talked out of.
- **Conversation transcripts in `~/.robin/chats/` contain every file the model read.** They're written `0600`, but treat them as sensitive.
- To actually contain Robin, run it in a container or VM with only your working directory mounted.

## Troubleshooting

- **"Not logged in to Copilot"** — run `robin login copilot`.
- **"Not logged in to Gemini"** — run `robin login gemini` and paste an API key from https://aistudio.google.com/apikey.
- **"Not logged in to OpenRouter"** — run `robin login openrouter` and paste an API key from https://openrouter.ai/keys.
- **Ollama chat hangs or errors immediately** — confirm `ollama serve` is running and `ollama list` shows at least one pulled model.
- **A model doesn't show up in `/model`** — `/model` only lists what's actually available on the current provider. For Ollama, that means models you've `ollama pull`'d locally; run `ollama pull <model>` first.
- **Copilot device code expires before you approve it** — device codes last about 15 minutes; just rerun `robin login copilot` for a fresh one.
- **Chrome doesn't open automatically during login** — copy the printed URL and enter it manually on any device with a browser; this is expected over SSH/PuTTY to a headless machine.

## Development

```bash
npm test           # run the test suite
npm run build       # type-check and compile to dist/
```
