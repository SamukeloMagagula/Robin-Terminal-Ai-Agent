# robin

Robin is a terminal agent that lets you run your AI. Supports Anthropic (Claude), GitHub Copilot, Google Gemini, OpenRouter (via API key), and local Ollama models, with tool-calling (read files, write files, run shell commands) built in.

Built by Samukelo "Batman" Magagula.

## Requirements

- Node.js >= 18
- For Anthropic: a Claude API key from [platform.claude.com](https://platform.claude.com/settings/keys)
- For Copilot: a GitHub account with Copilot access
- For Gemini: a Google AI Studio API key
- For OpenRouter: an OpenRouter API key (gives access to a large, constantly growing catalog of models from many providers — OpenAI, Anthropic, Google, Meta, Mistral, and more — under one key)
- For Ollama: [Ollama](https://ollama.com) installed and running locally

## Install

**macOS / Linux:**

```bash
git clone https://github.com/SamukeloMagagula/Robin-Terminal-Ai-Agent.git
cd Robin-Terminal-Ai-Agent
npm ci && npm run build && npm link
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/SamukeloMagagula/Robin-Terminal-Ai-Agent.git
cd Robin-Terminal-Ai-Agent
npm ci; npm run build; npm link
```

Then start it:

```bash
robin chat ollama      # local, no API key needed
robin chat             # pick a provider from a menu
robin chat random      # roll a random provider and model
```

`robin chat ollama` is the fastest way to see it working, because Ollama needs
no account — [install Ollama](https://ollama.com), run `ollama pull llama3.1`,
and you are chatting in under a minute. Every other provider needs a login
first; see [Setting up a provider](#setting-up-a-provider) below.

**Check it worked:**

```bash
robin status           # shows which providers are logged in and reachable
```

### Notes on the install

Use `npm ci`, not `npm install`. Dependencies are exact-pinned with no version
ranges, so a compromised patch release can't reach you without an intentional
bump here — `npm ci` enforces that; `npm install` can drift.

`npm link` only needs to be run once (or again after pulling changes that touch
`package.json`). After that, `robin` works from any directory. If you would
rather not link globally, `node dist/cli.js chat` from the repo works the same.

**Updating:**

```bash
git pull && npm ci && npm run build
```

**Uninstalling:** `npm unlink -g robin`, then delete the clone. Robin's data
lives in `~/.robin/` — conversations, transcripts, credentials, input history —
so remove that directory too if you want it gone.

### Setting up a provider

**Anthropic (Claude):**

```bash
robin login anthropic
```

Opens the Claude Console's API keys page; create or copy a key and paste it back. Stored in `~/.robin/auth.json` like every other provider.

Robin talks to Anthropic through the official `@anthropic-ai/sdk` rather than raw HTTP, because the Messages API differs from the OpenAI shape the other providers share — the system prompt is a top-level field, tool results are blocks inside a user message, and tool arguments arrive parsed rather than as a JSON string.

Two behaviours are specific to this provider:

- **Reasoning is shown.** Current Claude models think by default; Robin asks for summarised reasoning and prints it dimmed as it streams, so a thinking pause looks like progress rather than a hang. It is never added to the conversation history.
- **No temperature knob.** Current models reject `temperature`, `top_p` and `top_k` outright, so Robin doesn't send them. Steer with `/system` or a `PERSONALITY.md` instead.

`/model` lists what your key can reach, defaulting to `claude-opus-5`.

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

This opens Chrome to OpenRouter's API keys page. Create/copy a key there, then paste it back into the terminal when prompted. `/model` on OpenRouter lists every model currently available on the platform — around 400 at the time of writing.

**Ollama:**

```bash
ollama pull llama3.1     # or any other tool-capable model (e.g. qwen2.5)
ollama serve              # if it isn't already running as a background service
```

No login needed — `robin` just checks `http://localhost:11434` is reachable. Older/smaller Ollama models that don't support tool-calling will still chat normally; they just won't be able to use tools.

### Picking a model

Catalogues are large — Copilot reports ~49 chat models, Gemini ~42, OpenRouter ~400 — so once a provider lists more than 20, `/model` switches from an arrow-key list to a type-to-filter search. Terms match in any order, so `claude son` finds `claude-sonnet-5`. Providers with a handful of models (a local Ollama, say) keep the plain list, which is faster than typing.

Copilot's list comes from its own API rather than being hardcoded, filtered to models the API marks as chat-capable. If that call fails, `/model` falls back to `gpt-4o` and `gpt-4o-mini` so the picker is never empty.

### Chrome, or a link if there's no browser to open

Anywhere `robin` needs you to visit a page (Copilot/Gemini/OpenRouter login), it tries to open Chrome directly. If it can't — most commonly because you're connected over SSH/PuTTY to a headless Linux box with no display server — it skips the attempt and just prints the link to open on any other device instead. Windows and macOS always attempt to open Chrome, since a desktop is assumed there.

### Automatic model fallback

If a request to the current model fails (rate-limited, unreachable, etc.), `robin` automatically retries the message on the next model — first other models on the same provider, then models on any other provider you're logged into. Once a fallback succeeds, the session sticks with it (same as switching with `/model`/`/provider` yourself) rather than retrying the original model every turn.

Several limits keep this from turning into a long wait:

- **Non-chat models are excluded by name.** Speech, embedding, image and video models sit in the same catalogues and would just return a 400.
- **The chain stops after 5 attempts**, and at most 3 of those may be on the provider that just failed. The reservation matters: without it a 300-model provider fills every slot, so an account-wide refusal leaves nothing to fall back to even though another provider is logged in and working.
- **A quota refusal skips the rest of that provider.** Rate limits and exhausted credit are account-wide, so every sibling model would refuse identically.
- **Models a provider rejects as unsupported are remembered** in `~/.robin/unsupported-models.json` and never offered again — in the picker or the fallback chain. Only explicit "model not supported" / "not found" style refusals are recorded; a rate limit is transient and never is. Delete that file to start over.

Errors show the provider's own explanation, not just a status code — "400 (request failed)" becomes "400 (request failed) — The requested model is not supported.", which is the difference between a mystery and something you can act on.

## OpenRouter spend

If you're logged into OpenRouter, `robin` shows what you've spent — on the startup banner, on the divider between turns, and in full via `/usage`:

```
💳 $0.0420 UTC day  ·  $1.37 this key  ·  $8.63 account balance
```

Every label is the figure OpenRouter actually reports, not a friendlier paraphrase:

- **UTC day / UTC week / UTC month** — the windows are UTC-based, and the week starts Monday. They are not your local day, so they aren't labelled "today".
- **this key** — all-time spend for the API key you're using, not the account. An account with several keys will show a smaller number here than its account total.
- **account balance** — credits purchased minus credits used, across every key, from `/credits`. It goes negative once free usage exceeds anything purchased.
- **key cap** — a spending limit set on the individual key, shown with a bar only when one exists. Separate from account balance; either can stop a request.

`/usage` adds the key's expiry date and BYOK spend when it's non-zero, and states OpenRouter's `is_free_tier` flag as what it is — a record of whether credits have ever been purchased, not a plan name.

The figure is cached for 60 seconds and refreshed in the background after each reply, so the prompt never waits on the network. No OpenRouter key, or the request fails? The line is simply omitted. If the account call alone fails, the per-key figures still show and the balance segment disappears.

## Usage

```bash
robin                    # interactive provider + model picker
robin chat copilot       # jump straight into Copilot
robin chat gemini        # jump straight into Gemini
robin chat anthropic     # jump straight into Claude
robin chat openrouter    # jump straight into OpenRouter
robin chat ollama        # jump straight into Ollama
robin chat random        # let Robin roll a provider and model for you
robin login copilot      # log in to Copilot ahead of time
robin logout copilot     # clear stored Copilot credentials
robin status              # show login/reachability status for every provider
robin models              # list models recorded as unsupported
robin models forget gemini  # clear those records so they're offered again
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
- `/skill save <name>` — save the current system prompt as a reusable skill under `~/.robin/skills/<name>/SKILL.md`
- `/skill use <name>` — apply a saved skill as the current system prompt
- `/skill [list]` — list saved skills with their descriptions
- `/skill forget <name>` — delete a skill
- `/skill migrate` — convert pre-markdown `.json` presets to the new layout
- `/personality [reload|off]` — show the active `PERSONALITY.md`, re-read it after an edit, or drop it for the session
- `/random` — re-roll onto a randomly chosen provider and model
- `/usage` — OpenRouter spend for this key (UTC day/week/month, all time) and the account balance
- `/recall <query>` — search past conversations under `~/.robin/chats/`
- `/history` — show where input history is stored; `/history clear` wipes it
- `/clear` — reset the conversation
- `/exit` — quit

## Personality

Robin reads a `PERSONALITY.md` on startup and prepends it to the system prompt, so a project can carry its own house style without you retyping `/system` every session. Two locations, both optional, both sent when present:

- `~/.robin/PERSONALITY.md` — your global default, applied everywhere
- `./PERSONALITY.md` — the working directory only (Robin does **not** search parent directories)

The order sent to the model is: the environment preamble, then personality, then whatever `/system` is set to — so a task-specific `/system` can override the standing tone.

**Project files are gated.** `PERSONALITY.md` becomes the system prompt for a tool that can run commands and read files, and repositories get cloned. The first time Robin sees a project file it hasn't approved, it prints the file and asks:

- **`y`** — use this exact text. Editing the file asks again.
- **`n`** — skip it.
- **`a`** — trust this location from now on, whatever it comes to contain. Use this for a repo you own and edit constantly; withhold it from one you cloned.

Approvals are recorded in `~/.robin/personality-trust.json`. Your own global file is never prompted for. A corrupt trust file is treated as empty, so everything re-prompts rather than silently loading. Files over 32 KB are skipped.

`/personality` shows what's active and where it came from, `/personality reload` re-reads after an edit, and `/personality off` drops it for the session.

## Editing and Interrupting

| Key | Does |
|---|---|
| `Enter` | Send the message |
| `Alt+Enter` | Start a new line without sending. A trailing `\` does the same, for terminals that swallow Alt+Enter |
| `↑` / `↓` | Move between lines of a multi-line message; from the first or last line, walk back and forward through what you've typed before |
| `Esc` | While a reply is streaming, stop it. The partial reply is kept, so your next message reads as a redirect. While typing, closes the command popup |
| `Ctrl+C` | Quit |

Long-running commands stream their output as it arrives, dimmed, rather than appearing all at once when they finish.

## Sessions

Robin holds up to nine conversations at once. `/session new` opens one (picking its own provider and model), `/session 2` switches, `/session` lists what's open, `/session name <label>` labels the current one, and `/session close [n]` closes one.

Each session is genuinely independent: its own history, system prompt, tool setting and markdown transcript. Two sessions on the same model are two conversations, not two views of one. Switching is instant — no network, no re-auth.

Nine is the cap so that `/session 3` stays a single unambiguous keystroke; ids are reused as sessions close.

**If you never use it, nothing changes.** The prompt only grows a session number once a second session exists — `2>` instead of `>`.

## Skills

A skill is a reusable instruction set. Each lives in its own directory as `~/.robin/skills/<name>/SKILL.md`, with `name` and `description` frontmatter — the [agentskills.io](https://agentskills.io) layout, so a skill written here can be shared with other tools and one written elsewhere can be dropped in.

Save the current system prompt as a skill with `/skill save <name>`, apply one with `/skill use <name>`, and `/skill` lists them with their descriptions.

**Robin can also write its own.** After working something out, it may call `create_skill` to keep the procedure — but unlike memories, this **asks first**. A memory is a private note; a skill is a standing instruction set that will shape every later session, and one written from a misunderstanding would quietly steer future work. Cheap to approve now, expensive to find months later.

Only the descriptions go into the system prompt. The bodies are whole instruction sets, so the model pulls one with `use_skill` when a line matches the task — the same index/body split memory uses.

**Migrating from the old format.** Robin used to store skills as flat `<name>.json` files holding a bare system prompt. Those still load, so nothing you saved has stopped working. `/skill migrate` converts them to the new layout and **leaves the originals in place** — a conversion you didn't ask for shouldn't be able to lose the only copy of something you wrote. Delete the `.json` files yourself once you're happy.

## Memory

Robin keeps notes for itself across sessions in `~/.robin/memory/` — one markdown file per memory, plus `profile.md`, the accumulating picture of how you work. Plain files: readable, greppable, and deletable with `rm`.

**Robin decides what to keep.** It calls a `remember` tool when something looks worth persisting — a stable preference, a project constraint, a correction you made — and every tenth turn of a session it's reminded to consider whether anything qualifies. Without that nudge the tool exists but rarely gets used.

**Only the index is sent each turn.** `profile.md` and one line per memory go into the system prompt; the bodies stay on disk until the model pulls one with `recall_memory`. That keeps the per-turn cost flat as memory grows, rather than making a long-time user pay for their whole history on every request.

The index is capped at 8 KB and the profile at 4 KB. Past that, the oldest entries stop being *sent* but stay on disk — `/memory` marks which ones those are.

| Command | Does |
|---|---|
| `/memory` | List what Robin has remembered, marking anything no longer sent |
| `/memory show <name>` | Print one in full |
| `/memory forget <name>` | Delete it |

**Worth being clear about the trade.** Robin writes these without asking first — that is what makes the feature work, and it means things about you land on disk as a side effect of conversation. The mitigations are all after the fact: it's plain text in a directory you own, `/memory` lists everything, `/memory forget` removes it, and you can edit or delete the files directly. If you'd rather approve each one, that's a small change to a single function — open an issue.

Never stored: credentials, tokens or key material. The tool description forbids it.

## MCP servers

Robin can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio, adding their tools alongside its own three. Declare them in `~/.robin/mcp.json` — the same shape other MCP hosts use, so you can paste server blocks straight from their docs:

```jsonc
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/code"]
    },
    "github": { "command": "gh-mcp", "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

**Tools are namespaced `server__tool`** — `filesystem__read_file` is distinct from Robin's own `read_file`. That prefix is a security boundary, not decoration: without it a server could declare a tool named `read_file` and quietly intercept every call meant for the built-in.

**Two gates, and neither can be turned off:**

- **Starting a server is approved once.** An `mcp.json` entry says "run this command", and config files get pasted from the internet. On first sight Robin prints the exact command and asks — `y` approves that exact command, `a` trusts the server whatever its command becomes, `n` skips it. Changing an approved command asks again. Approvals live in `~/.robin/personality-trust.json` alongside the `PERSONALITY.md` ones.
- **Every MCP tool call is approved individually.** Robin auto-approves its own read-only shell commands because it can inspect the command; there is no equivalent for an opaque third-party tool, and trusting a name the server chose would be trusting the thing being gated. A tool called `list_files` may do anything. Use the gate's "stop asking about MCP tools this session" option if that gets tiring.

Results are wrapped as untrusted content before the model sees them, exactly like file reads and command output.

A server that fails to start, or dies, is disabled with one muted line — the turn continues on the remaining tools. One bad entry never costs you the rest.

**Not supported yet:** the Streamable-HTTP transport (stdio only), and MCP resources and prompts (tools only).

## Chat History

Every conversation is automatically written to a readable markdown transcript in `~/.robin/chats/robin-chat-<timestamp>.md`, updated after every reply — nothing to remember to do. A new file starts whenever the conversation resets (`/clear`, `/model`, `/provider`, `/load`), so each distinct conversation gets its own file you can browse, search, or share later.

This is separate from `/save`/`/load`, which store an exact, reloadable snapshot as JSON under `~/.robin/conversations/` — use `/save` when you want to resume a specific conversation later inside `robin`; the markdown transcript is for your own reading/reference outside the app.

Use `/recall <query>` to search across all past markdown transcripts from inside a chat session. It's keyword search, not semantic — but enough to find "did I already ask about X" without leaving the terminal.

Searches run against a full-text index at `~/.robin/index.db` (SQLite FTS5), built on first use and updated incrementally as transcripts change — only files whose modification time moved are re-read. Results come back ranked by relevance rather than by file order, capped at 10.

`better-sqlite3` is a native module. On a platform with no prebuilt binary it may fail to install, and Robin handles that rather than breaking: `/recall` falls back to the original linear scan and says so once per search. The results are the same, the search is just slower.

The lines you type at the prompt are kept too, so the up arrow still reaches yesterday's commands. They live in `~/.robin/input-history` — the newest 200, one per line, in the same private tree as the transcripts and with the same owner-only permissions. `/history` shows the path, `/history clear` wipes it, and `ROBIN_NO_HISTORY_FILE=1` keeps history in memory for the session only.

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
