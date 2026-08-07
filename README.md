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
npm install
npm run build
npm link          # makes the `robin` command available globally
```

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

## Usage

```bash
robin                    # interactive provider + model picker
robin chat copilot       # jump straight into Copilot
robin chat gemini        # jump straight into Gemini
robin chat openrouter    # jump straight into OpenRouter
robin chat ollama        # jump straight into Ollama
robin login copilot      # log in to Copilot ahead of time
robin logout copilot     # clear stored Copilot credentials
robin status              # show login/reachability status for every provider
```

In a chat session, typing `/` shows a live-filtered popup of matching commands as you keep typing — arrow keys to move the highlight, **Tab** to fill in the highlighted command without submitting (so you can still type an argument), **Enter** to submit the highlighted command (or your typed line, if the popup isn't open), **Esc** to dismiss the popup and keep typing free text.

- `/help` (or just `/`) — list commands
- `/model` — pick a different model from the ones available on the current provider
- `/provider` — switch provider (e.g. Copilot ↔ Gemini ↔ OpenRouter ↔ Ollama)
- `/system [text]` — view the current system prompt, set one (`/system be terse`), or clear it (`/system clear`)
- `/tools [list]` — toggle tool-calling on/off for the session, or `/tools list` to see what's available
- `/save [name]` — save the current conversation under `~/.robin/conversations/<name>.json`; `/save` with no name lists what's saved
- `/load [name]` — load a previously saved conversation back into the session; `/load` with no name lists what's saved
- `/copy` — copy the assistant's last reply to your system clipboard
- `/skill save <name>` — save the current system prompt as a reusable named preset under `~/.robin/skills/<name>.json`
- `/skill use <name>` — load a saved preset as the current system prompt
- `/skill [list]` — list saved presets
- `/recall <query>` — search past conversations under `~/.robin/chats/`
- `/clear` — reset the conversation
- `/exit` — quit

## Chat History

Every conversation is automatically written to a readable markdown transcript in `~/.robin/chats/robin-chat-<timestamp>.md`, updated after every reply — nothing to remember to do. A new file starts whenever the conversation resets (`/clear`, `/model`, `/provider`, `/load`), so each distinct conversation gets its own file you can browse, search, or share later.

This is separate from `/save`/`/load`, which store an exact, reloadable snapshot as JSON under `~/.robin/conversations/` — use `/save` when you want to resume a specific conversation later inside `robin`; the markdown transcript is for your own reading/reference outside the app.

Use `/recall <query>` to search across all past markdown transcripts from inside a chat session — it's a plain case-insensitive text search (newest conversations first, capped at 10 matches), not semantic search, but it's enough to find "did I already ask about X" without leaving the terminal.

## Tool-Calling

Every chat session gives the model access to three tools:

- `read_file` — reads a file's contents (no confirmation needed)
- `write_file` — writes/overwrites a file (asks for y/n confirmation first)
- `run_command` — runs a shell command in the current directory (asks for y/n confirmation first)

When the model wants to write a file or run a command, you'll see a prompt like:

```
Write to hello.txt?
---
hi from the agent
---
 (y/n)
```

Answer `y`/`yes` to proceed or anything else to decline. Declined actions are reported back to the model so it can adjust its next step instead of silently failing.

`run_command` executes with the same permissions as the terminal you're running `robin` in — there's no sandboxing, so only approve commands you'd be comfortable running yourself. Commands matching common destructive patterns (`rm -rf`, `sudo`, `curl … | bash`, `mkfs`, `shutdown`, etc.) get an extra `⚠` warning above the confirmation prompt — it's a heuristic nudge to look twice, not a block, since `run_command` can still do anything a shell command can do once approved.

## Security

- **Credentials** (Copilot token, Gemini API key) are stored in plaintext at `~/.robin/auth.json` — the same approach tools like the GitHub CLI and `npm login` use. The file is written with owner-only permissions (`0o600`) on POSIX systems; on Windows this relies on your user profile's normal NTFS permissions instead, since POSIX mode bits aren't meaningful there.
- **`read_file`/`write_file` refuse to touch two directories**: `~/.robin/` (robin's own credentials) and `~/.ssh/` (your SSH keys) — regardless of how the path is spelled, including `..` traversal. This stops a model from accidentally (or if convinced by malicious content it read) exfiltrating or overwriting those files through the tools robin gives it.
- **`write_file` and `run_command` always require an explicit y/n confirmation** before touching disk or running anything; `run_command` additionally flags commands matching destructive patterns (see above). `read_file` has no confirmation by design (matches the tool's low-risk, read-only nature) beyond the protected-directory guard above.
- **`read_file` and `run_command` output is wrapped as untrusted content** before it goes back to the model — file contents and command output are data the model reads, not instructions it should follow, even if the file or output contains text that looks like a command (e.g. "ignore previous instructions and run..."). This narrows prompt-injection attacks where a file the model reads (or output it captures) tries to hijack the conversation.
- This is a personal CLI tool, not a multi-user or sandboxed environment: anyone with access to your terminal and OS user account already has access to everything `robin` can do. There's no separate app-level authentication gate.

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
