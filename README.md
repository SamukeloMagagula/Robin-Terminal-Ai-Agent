# robin

Robin is a terminal agent that lets you run your AI. Supports Anthropic (Claude), GitHub Copilot, Google Gemini, OpenRouter (via API key), Ollama, and any OpenAI-compatible server you run yourself (llama.cpp, LM Studio, vLLM, …), with tool-calling (read files, edit and write files, run shell commands) built in.

It can also be driven from [Telegram](#remote-control-telegram) when you're away from the terminal, and `robin doctor` tells you what's wrong with an install before you hit it.

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
robin doctor           # checks the whole install and prints the fix for anything wrong
robin status           # shows which providers are logged in and reachable
```

`robin doctor` is the one to run first if anything misbehaves — it covers the Node
version, the native SQLite addon, whether `~/.robin` is writable, and your providers
in one pass.

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

**Local (any OpenAI-compatible server):**

Ollama is one way to run a model locally, not the only one, and when it breaks you shouldn't have to wait for it. The `local` provider talks to anything that speaks OpenAI's `/v1/chat/completions` — llama.cpp's `llama-server`, LM Studio, Jan, KoboldCpp, llamafile, vLLM, LocalAI:

```bash
# llama.cpp — the engine Ollama itself shells out to
llama-server -m model.gguf --port 8080 --jinja

robin chat local
```

It looks at `http://127.0.0.1:8080/v1` by default, which is llama.cpp's port. Point it anywhere else with an environment variable — both spellings of the base work:

```bash
ROBIN_LOCAL_BASE_URL=http://127.0.0.1:1234/v1   # LM Studio
ROBIN_LOCAL_BASE_URL=http://127.0.0.1:1337      # Jan; the /v1 is added for you
ROBIN_LOCAL_API_KEY=...                          # only if you started the server with one
```

No login and no stored credentials — "logged in" here means something is answering. The variables are read per request, so switching runtimes takes effect on the next message rather than on the next restart.

**Already have models pulled through Ollama?** They're plain GGUF files under `~/.ollama/models/blobs/` (the big one is the weights). Point `llama-server -m` straight at that path — nothing to re-download.

`--jinja` matters if you want tool-calling: it makes llama.cpp use the model's own chat template, which is what emits OpenAI-style `tool_calls`. Without it the model will chat but never call a tool. Expect local models to be slower than hosted ones — an 8B model on CPU runs around 20 tokens/second, so a turn takes tens of seconds, and a tool-using turn multiplies that by the number of rounds.

### Picking a model

Catalogues are large — Copilot reports ~49 chat models, Gemini ~42, OpenRouter ~400 — so once a provider lists more than 20, `/model` switches from an arrow-key list to a type-to-filter search. Terms match in any order, so `claude son` finds `claude-sonnet-5`. Providers with a handful of models (a local Ollama, say) keep the plain list, which is faster than typing.

Copilot's list comes from its own API rather than being hardcoded, filtered to models the API marks as chat-capable. If that call fails, `/model` falls back to `gpt-4o` and `gpt-4o-mini` so the picker is never empty.

### Chrome, or a link if there's no browser to open

Anywhere `robin` needs you to visit a page (Copilot/Gemini/OpenRouter login), it tries to open Chrome directly. If it can't — most commonly because you're connected over SSH/PuTTY to a headless Linux box with no display server — it skips the attempt and just prints the link to open on any other device instead. Windows and macOS always attempt to open Chrome, since a desktop is assumed there.

On Windows, Chrome is located by looking for `chrome.exe` under `%LOCALAPPDATA%` first (per-user installs, the usual case on a managed machine) and then Program Files. Only if Chrome genuinely isn't installed does Robin fall back to the OS default handler — which on a stock Windows image means Edge, where you're probably signed into nothing.

Set `ROBIN_BROWSER` to an executable path to override the search entirely, on any platform:

```bash
ROBIN_BROWSER="D:\\Browsers\\chrome.exe" robin login copilot
```

### Automatic model fallback

If a request to the current model fails (rate-limited, unreachable, etc.), `robin` automatically retries the message on the next model — first other models on the same provider, then models on any other provider you're logged into. Once a fallback succeeds, the session sticks with it (same as switching with `/model`/`/provider` yourself) rather than retrying the original model every turn.

Several limits keep this from turning into a long wait:

- **Non-chat models are excluded by name.** Speech, embedding, image and video models sit in the same catalogues and would just return a 400.
- **The chain stops after 5 attempts**, and at most 3 of those may be on the provider that just failed. The reservation matters: without it a 300-model provider fills every slot, so an account-wide refusal leaves nothing to fall back to even though another provider is logged in and working.
- **A quota refusal skips the rest of that provider.** Rate limits and exhausted credit are account-wide, so every sibling model would refuse identically.
- **Models a provider rejects as unsupported are remembered** in `~/.robin/unsupported-models.json` and never offered again — in the picker or the fallback chain. Only explicit "model not supported" / "not found" style refusals are recorded; a rate limit is transient and never is. Delete that file to start over.

- **"Too long" is fixed, not fallen back from.** A prompt refused for exceeding the context window says nothing about the model — it will take the same conversation once it is shorter, and the next model down the chain has a different window anyway. Robin reads the limit out of the refusal, records it in `~/.robin/context-limits.json`, and immediately retries the same model with the oldest messages dropped. Every later turn on that model is trimmed to fit before it is sent, with a note saying how much was dropped. The system prompt and the message you just typed are always kept, and a tool result is never separated from the call it answers. Your session history is untouched — this is about what gets sent, not about forgetting the conversation.

Errors show the provider's own explanation, not just a status code — "400 (request failed)" becomes "400 (request failed) — The requested model is not supported.", which is the difference between a mystery and something you can act on.

## The gateway

Your conversations don't live in the terminal any more. They live in a small
local daemon — the gateway — and `robin chat` is a client of it. So is the
[Telegram bridge](#remote-control-telegram). The practical upshot:

- **Close the terminal, reopen it in the same directory, and your conversation is still there.** No `/load`, nothing to remember to save.
- **A message you send from Telegram and a message you type at the keyboard go to the same conversation.** Ask something from your phone, come back to your desk, and it's there — mid-thought, with the reply already streamed in.
- **A tool call raised by a Telegram turn asks you at your keyboard.** The approval box says where the request came from and who sent it; the first terminal to answer wins. With no terminal attached it's refused, exactly as `robin serve` has always behaved.

You don't have to start it. `robin chat` and `robin serve` each start one if
none is running:

```bash
robin gateway status    # is one running, and where
robin gateway start     # run one in the foreground (mostly for watching it work)
robin gateway stop      # stop it — conversations are lost, transcripts are not
```

It listens on **127.0.0.1:18790** and nowhere else. `ROBIN_GATEWAY_PORT`
overrides the port. Details live in `~/.robin/gateway.json` (mode 0600): the
port, the pid, and a random token every client must present. Anything that can
read that file can run commands as you, which is why it's 0600 and why the
socket is loopback-only.

**`/session` now shows more than it used to** — sessions opened by other
surfaces, their working directory, whether a turn is running, and whether the
session auto-approves tools. That last one is what `--allow-tools` became: a
visible property of a conversation rather than an invisible flag on a process.

**Conversations survive the gateway stopping.** They're written to
`~/.robin/sessions/` (mode 0600 — a history holds the contents of every file
the model read) after each turn rather than on shutdown, so a crash, a reboot
or a `gateway stop` all keep them. Restarting picks them up:
`Robin gateway listening on 127.0.0.1:18790 — 3 conversation(s) restored`.

A session untouched for two weeks is dropped on the next start, so directories
you visited once don't pile up in `/session`. Closing a session forgets it
immediately.

**One honest limitation:**

- **A session's working directory is fixed when it's created.** Tools run
  there. Move your terminal elsewhere and continue an old session, and commands
  still run in the original directory. `/session new` starts one bound to where
  you are now.

### The control UI

```bash
robin ui
```

Opens a browser onto the same gateway: your open sessions down the left, the
conversation in the middle, and a box to type in. It is a client like the
terminal is — attach to a session started at the keyboard and you are in the
same conversation, streaming as it happens.

Approvals appear here too, as a dialog, with the same origin line the terminal
shows. Answer in either place; the first answer wins and the other closes.

**The link carries the gateway token**, because a page cannot read
`~/.robin/gateway.json`. Treat it like a password. The page takes it out of the
address bar the moment it loads — a URL is history, a bookmark and a referrer —
and keeps it in `sessionStorage` instead.

Three things keep the browser from being a way in:

- **Loopback only, and the `Host` header is checked.** A site that points its
  own hostname at 127.0.0.1 to make your browser treat this port as same-origin
  gets a 403.
- **WebSocket upgrades are refused from web origins.** WebSockets are not
  subject to CORS, so any page you visit can open a socket to a local port. One
  with an `Origin` that is not this port is turned away; clients that send no
  `Origin` at all — every non-browser one — are unaffected.
- **A strict `Content-Security-Policy`.** Everything the page needs is inline
  and same-origin, so nothing is fetchable from anywhere else.

### Driving Robin from other tools

The gateway serves an OpenAI-compatible API on the same port, so anything that
speaks `chat/completions` — an editor plugin, a script, the `openai` SDK — can
use Robin. Not as a model proxy: the turn runs with Robin's tools, memory and
skills, and a tool call it raises is offered to whatever terminal is attached,
refused when there is none.

```bash
TOKEN=$(node -e "console.log(require(require('os').homedir()+'/.robin/gateway.json').token)")

curl http://127.0.0.1:18790/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"robin","messages":[{"role":"user","content":"say pong"}]}'
```

The API key is the gateway token from `~/.robin/gateway.json`. `model` is either
`robin` (the first provider you're logged into, its default model) or
`<provider>/<model>` — `copilot/gpt-5.4`, `local/llama-3.1`. `GET /v1/models`
lists what's available. `"stream": true` returns SSE chunks in the usual shape.

Two things differ from a hosted API, both deliberate:

- **The `model` in the response is the one that actually answered.** If your
  request fell back to another model, the reply says so rather than echoing
  what you asked for.
- **Token counts are reported as zero.** Robin doesn't count them, and inventing
  numbers would be worse than admitting that.

Each request gets its own session, closed when the answer is sent — the endpoint
is stateless by OpenAI's design, so your client sends the whole conversation
each time and nothing accumulates in `/session`.

If something looks wrong, `robin doctor` checks the gateway too. Two failures
are worth naming, both caused by the same thing — a daemon outliving the build
that started it:

- **A protocol it doesn't speak.** Refused outright, because the two sides
  cannot understand each other.
- **A different build of the same protocol.** The quieter case, and far more
  common: the daemon understands everything and simply behaves like the code it
  started with. Once, that made token counting look broken when it wasn't.
  `robin gateway status`, `robin doctor` and `robin chat` all say so, and none
  of them refuses — most rebuilds change nothing a running daemon would get
  wrong.

Either way the fix is `robin gateway stop`; the next message starts a fresh one.

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
robin doctor              # check the install and report anything that would stop it starting
robin models              # list models recorded as unsupported
robin models forget gemini  # clear those records so they're offered again
robin serve telegram      # run as a bridge you can drive from Telegram
robin serve telegram --whoami   # print your Telegram sender id, for the allowlist
```

In a chat session, typing `/` shows a live-filtered popup of matching commands as you keep typing — arrow keys to move the highlight, **Tab** to fill in the highlighted command without submitting (so you can still type an argument), **Enter** to submit the highlighted command (or your typed line, if the popup isn't open), **Esc** to dismiss the popup and keep typing free text.

**↑ / ↓ recall what you've already sent.** With the popup closed, ↑ walks back through the lines you've submitted this session and ↓ walks forward again. Come all the way back down and you get your half-typed line returned to you, exactly as you left it. Consecutive duplicates collapse, and history persists across restarts in `~/.robin/input-history` — the same private tree that already holds your full transcripts, so it adds no new exposure, but it does add longevity. Set `ROBIN_NO_HISTORY_FILE=1` to keep it session-only, or clear what's already there with `/history clear`.

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

## Workflows

`/workflow` runs a piece of work through four roles, each on a model you choose: **planner** decides what to do, **builder** makes the change, **tester** runs the checks, **validator** judges whether it met the goal.

```bash
/workflow new            # name it, then pick a provider and model per role
/workflow run <goal>     # start
/workflow show <name>    # see which model has which role
```

**It stops after every stage** and asks: approve, retry with a note, skip, or quit. Nothing runs unattended.

Each stage is a **fresh conversation** given only the artifacts it needs — the validator sees the plan, what was built and the test results, but never a transcript of the builder explaining why its own work is correct. That bias is the reason the role is separate.

The validator ends with `VERDICT: PASS` or `VERDICT: FAIL`. A failure goes back to the builder with the reasons attached, capped at **three build attempts** — past that the loop isn't converging and Robin reports rather than burning tokens. If the verdict line is missing or unreadable, Robin says so and asks you; it will not guess a pass.

The planner runs with **tools off** — a stage whose job is deciding what to do shouldn't be editing files while it decides. The other three have tools, and **every tool call still asks for approval**. A workflow automates the prompting, not the consent.

## Sessions

Robin holds up to nine conversations at once. `/session new` opens one (picking its own provider and model), `/session 2` switches, `/session` lists what's open, `/session name <label>` labels the current one, and `/session close [n]` closes one.

Each session is genuinely independent: its own history, system prompt, tool setting and markdown transcript. Two sessions on the same model are two conversations, not two views of one. Switching is instant — no network, no re-auth.

Nine is the cap so that `/session 3` stays a single unambiguous keystroke; ids are reused as sessions close.

**If you never use it, nothing changes.** The prompt only grows a session number once a second session exists — `2>` instead of `>`.

## Skills

A skill is a reusable instruction set. Each lives in its own directory as `~/.robin/skills/<name>/SKILL.md`, with `name` and `description` frontmatter — the [agentskills.io](https://agentskills.io) layout, so a skill written here can be shared with other tools and one written elsewhere can be dropped in.

Save the current system prompt as a skill with `/skill save <name>`, apply one with `/skill use <name>`, and `/skill` lists them with their descriptions.

### Where skills come from

Skills are installed from published catalogues, not written by the model. Three are built in, all using the same `SKILL.md` layout:

```bash
robin skill list                      # the catalogues
robin skill list hermes review        # what's in one, filtered
robin skill add anthropic pdf docx    # install by name
```

| Source | Repository | Skills |
|---|---|---|
| `anthropic` | [anthropics/skills](https://github.com/anthropics/skills) | 17 |
| `openclaw` | [openclaw/openclaw](https://github.com/openclaw/openclaw) | 45 |
| `hermes` | [Undermybelt/hermes-skills](https://github.com/Undermybelt/hermes-skills) | 1400+ |

Installed skills keep their source in the name — `hermes-aegis-brainstorming` — because the catalogues overlap, and more than one publishes a "brainstorming". Installing asks first: a skill is a standing instruction set that shapes every later session, these come from public repositories, and nobody reviewed them on the way in.

**The model cannot write skills.** There used to be a `create_skill` tool, and removing it is deliberate. A question about two Azure certification exams once produced a skill for measuring the hardness of metals, and a single reply put five proposals in front of the user — each one a prompt to answer. A stream of prompts is what teaches people to stop reading the prompts that matter. `/skill save <name>` still keeps a system prompt *you* wrote.

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

Robin can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio, adding their tools alongside its own three. Declare them in `~/.robin/mcp.json`. Either `"servers"` or `"mcpServers"` works — the second is what Claude Desktop, Cursor and most other hosts use, so a block pasted from their docs works unchanged:

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

- **Starting a server is approved once, with `robin mcp`.** An `mcp.json` entry says "run this command", and config files get pasted from the internet. `robin mcp` prints the exact command and asks — `y` approves that exact command, `a` trusts the server whatever its command becomes, `n` skips it. Changing an approved command asks again. Approvals live in `~/.robin/personality-trust.json` alongside the `PERSONALITY.md` ones.

  The [gateway](#the-gateway) runs the servers, and it never asks: it is detached with no terminal, so a server you have not approved is skipped rather than launched quietly. It says which ones on startup, and `robin mcp` is where you answer. Approving something while the gateway is already running needs a `robin gateway stop` — it reads trust once, at startup.
- **Every MCP tool call is approved individually.** Robin auto-approves its own read-only shell commands because it can inspect the command; there is no equivalent for an opaque third-party tool, and trusting a name the server chose would be trusting the thing being gated. A tool called `list_files` may do anything. Use the gate's "stop asking about MCP tools this session" option if that gets tiring.

Results are wrapped as untrusted content before the model sees them, exactly like file reads and command output.

A server that fails to start, or dies, is disabled with one muted line — the turn continues on the remaining tools. One bad entry never costs you the rest.

**Not supported yet:** the Streamable-HTTP transport (stdio only), and MCP resources and prompts (tools only).

## Remote control (Telegram, Discord)

`robin serve` runs Robin as a bridge so you can drive it from a messaging app while you're away from the terminal.

```bash
robin serve telegram
robin serve discord
```

Both work today, and both connect *outward* — Telegram by long-polling, Discord over its gateway WebSocket — so neither needs a public address or an open port. That is the whole reason these two came first: they run from a laptop behind NAT exactly as they are.

WhatsApp and Teams are recognised channel names that explain what they still need. Both require a public webhook endpoint, so each is a transport adapter plus a listener something on the internet can reach. Everything above the transport — access control, sessions, approvals, the agent loop — is already shared, which is why Discord was one file.

**Discord needs one thing switched on.** On your application's page at [discord.com/developers](https://discord.com/developers/applications), under *Bot*, enable the **Message Content Intent**. Without it every message arrives with empty text and the bot looks like it is ignoring you. Invite the bot to a server, or message it directly, then put your own Discord user id in the allowlist — `robin serve discord --whoami` prints the id of anyone who messages it.

### Setting it up

1. Message [@BotFather](https://t.me/botfather) on Telegram, send `/newbot`, and copy the token it gives you.
2. Put it in `~/.robin/channels.json`:

```jsonc
{
  "channels": {
    "telegram": {
      "token": "123456:ABC-your-bot-token",
      "allow": [],
      "provider": "copilot",
      "model": "claude-sonnet-5"
    }
  }
}
```

3. Find your own sender id — you can't know it until something tells you:

```bash
robin serve telegram --whoami
```

Message the bot; it prints your numeric id and nothing else reaches the model. Add that id to `allow`, then start the bridge for real.

`provider` and `model` are optional — without them Robin answers with the first provider you're logged into. The token can come from `TELEGRAM_BOT_TOKEN` instead of the file, which is the better habit: `channels.json` is a plain file that gets copied around with dotfiles.

### Commands in the chat

| Message | Effect |
| --- | --- |
| `/help` | The command list |
| `/new` | Start a fresh conversation |
| `/status` | Which model is answering, turns so far, tool policy |
| anything else | Sent to the model |

Each Telegram chat keeps its own conversation, and messages within one chat are handled strictly one at a time.

### The allowlist is the whole security boundary

A bot's username is public and anyone who finds it can message it. On the other side is a tool loop with access to your machine, so:

- **An empty `allow` list authorises nobody**, and the bridge refuses to start rather than sitting there quietly declining everything.
- **Refused senders get no reply at all** — not even an error. Any response confirms there's a live Robin behind the bot, which is what someone probing it wants to learn.
- **Tool calls go to a human, or they don't happen.** A request raised by a Telegram turn appears at any terminal attached to the same [gateway](#the-gateway), labelled with the channel and the sender who caused it. With no terminal attached there's nobody to ask, and it's declined — the reply says how many were. Read-only commands are unaffected; those never hit the approval gate.

`--allow-tools` lifts that last restriction, and means exactly what it says: a chat message can then run commands and write files on your machine unattended, with nobody asked. Only worth it when you trust every id on the allowlist and the machine it's running on. It now marks the *session* rather than the process, so `/session` and `robin gateway status` show which conversations carry it.

Each Telegram chat maps to a gateway session, which is why a conversation you start on your phone is waiting in your terminal when you sit down.

## Chat History

Every conversation is automatically written to a readable markdown transcript in `~/.robin/chats/robin-chat-<timestamp>.md`, updated after every reply — nothing to remember to do. A new file starts whenever the conversation resets (`/clear`, `/model`, `/provider`, `/load`), so each distinct conversation gets its own file you can browse, search, or share later.

This is separate from `/save`/`/load`, which store an exact, reloadable snapshot as JSON under `~/.robin/conversations/` — use `/save` when you want to resume a specific conversation later inside `robin`; the markdown transcript is for your own reading/reference outside the app.

Use `/recall <query>` to search across all past markdown transcripts from inside a chat session. It's keyword search, not semantic — but enough to find "did I already ask about X" without leaving the terminal.

Searches run against a full-text index at `~/.robin/index.db` (SQLite FTS5), built on first use and updated incrementally as transcripts change — only files whose modification time moved are re-read. Results come back ranked by relevance rather than by file order, capped at 10.

`better-sqlite3` is a native module. On a platform with no prebuilt binary it may fail to install, and Robin handles that rather than breaking: `/recall` falls back to the original linear scan and says so once per search. The results are the same, the search is just slower.

The lines you type at the prompt are kept too, so the up arrow still reaches yesterday's commands. They live in `~/.robin/input-history` — the newest 200, one per line, in the same private tree as the transcripts and with the same owner-only permissions. `/history` shows the path, `/history clear` wipes it, and `ROBIN_NO_HISTORY_FILE=1` keeps history in memory for the session only.

## Tool-Calling

Every chat session gives the model access to four tools:

- `read_file` — reads a file's contents (confirms only for paths outside the current directory)
- `write_file` — writes/overwrites a whole file (always confirms)
- `edit_file` — replaces an exact string in an existing file (always confirms)
- `run_command` — runs a shell command in the current directory (confirms unless the command is recognised as read-only)

**Changes to existing files go through `edit_file`, not `write_file`.** Rewriting
a whole file to change one line costs the entire file in tokens and silently
loses anything the model did not reproduce. `edit_file` replaces an exact
string, and refuses rather than guessing: a search string that matches twice is
an error naming the count, because a model cannot see which of the two it would
have hit. `replace_all` is how you say you meant both.

It also matches across line-ending styles. Models emit `
` and Windows files
are full of `

`; failing on that alone would make the tool useless on the
machine it runs on. The file keeps whatever endings it had.

When the model wants to write a file or run a command that needs approval, you'll see a prompt like:

```
╭──────────────────────────╮
│ Run "npm install lodash"? │
╰──────────────────────────╯
? Run it? (ynax)
  y) yes, this once
  n) no
  a) yes, and stop asking about commands in this conversation
  x) no, and stop asking about commands for this reply
```

`a` and `x` answer for that whole *kind* of action — commands, file writes, or
outside-directory reads — so you say once what you would otherwise say to
twenty near-identical requests in a row. Both are held by the gateway, and both
are scoped to **that conversation**: approving commands in the repository you
are working in does not silence the gate for a Telegram chat sharing the same
daemon. `a` lasts until the gateway stops; `x` until your next message.

The same four answers appear as buttons in the [control UI](#the-control-ui).
Declined actions are reported back to the model so it can adjust instead of
silently failing.

**No is remembered too, for the rest of the reply.** A refusal reads to a model as a failed attempt, and the reflex after a failed attempt is another attempt: one session put the same skill proposal up four times and seven variants of the same search command, each a fresh box to answer. So an *identical* request that comes back is refused silently, `x` refuses that whole kind for the rest of the reply, and the refusal the model receives says outright not to retry it in another form. All of it is scoped to the one reply — the next thing you type may be exactly a request to do the thing you just refused.

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
- **The Telegram bridge has nobody at the keyboard**, so it denies every tool call that would prompt, and answers only sender ids on an explicit allowlist. An empty allowlist authorises nobody and refuses to start. `--allow-tools` removes that restriction entirely — with it, a chat message runs commands and writes files on your machine unattended, and the reading-the-prompt boundary above no longer exists. See [Remote control](#remote-control-telegram).
- **The destructive-pattern `⚠` is a nudge, not a block.** It catches `rm -rf` but not `rm -r -f`, `$(echo rm) -rf`, or anything encoded. Don't rely on it.
- **`read_file` and `run_command` output is wrapped as untrusted content** before it goes back to the model — file contents and command output are data the model reads, not instructions it should follow, even if the text looks like a command ("ignore previous instructions and run…"). This narrows prompt injection; it does not eliminate it, since it is a prompt-level convention the model can still be talked out of.
- **Conversation transcripts in `~/.robin/chats/` contain every file the model read.** They're written `0600`, but treat them as sensitive.
- To actually contain Robin, run it in a container or VM with only your working directory mounted.

## Troubleshooting

**Start here:**

```bash
robin doctor
```

It checks the things that actually stop Robin running — Node version, whether the native SQLite addon matches this Node's ABI, whether `~/.robin` is writable, whether `mcp.json` parses, and which providers are usable — and prints the fix next to anything that's wrong. It exits non-zero on a blocking problem, so it also works as a gate in a setup script.

The first three of those are checked again automatically whenever you start a chat. A blocking failure stops startup with the remedy instead of surfacing as a stack trace several screens later.

- **`robin` isn't a recognised command** — `bin` points at `dist/`, which isn't committed. Run `npm ci && npm run build` after cloning, then `npm link` (or invoke `node dist/cli.js` directly).
- **"was compiled against a different Node.js version"** — you upgraded Node without rebuilding the native addon. `npm rebuild better-sqlite3`, or `npm ci`.
- **"Robin needs an interactive terminal"** — the provider and model pickers need a TTY, so `robin chat` can't be piped or redirected.
- **"Not logged in to Copilot"** — run `robin login copilot`.
- **"Not logged in to Gemini"** — run `robin login gemini` and paste an API key from https://aistudio.google.com/apikey.
- **"Not logged in to OpenRouter"** — run `robin login openrouter` and paste an API key from https://openrouter.ai/keys.
- **Ollama chat hangs or errors immediately** — confirm `ollama serve` is running and `ollama list` shows at least one pulled model. If Ollama itself fails to start a model (`llama-server process has terminated: invalid argument: --load-mode` and similar), that is Ollama's own runner disagreeing with its bundled binary — reinstall it, or skip it entirely and use the `local` provider against `llama-server` directly.
- **`robin chat local` says nothing is answering** — check the port. It defaults to llama.cpp's 8080; LM Studio is 1234 and Jan is 1337, so set `ROBIN_LOCAL_BASE_URL`. `curl http://127.0.0.1:8080/v1/models` tells you whether the problem is Robin or the server.
- **A local model chats but never uses tools** — start `llama-server` with `--jinja` so it applies the model's own chat template, and use a model whose template supports tool calls.
- **A model doesn't show up in `/model`** — `/model` only lists what's actually available on the current provider. For Ollama, that means models you've `ollama pull`'d locally; run `ollama pull <model>` first.
- **Copilot device code expires before you approve it** — device codes last about 15 minutes; just rerun `robin login copilot` for a fresh one.
- **Chrome doesn't open automatically during login** — copy the printed URL and enter it manually on any device with a browser; this is expected over SSH/PuTTY to a headless machine.
- **The login page opens in Edge instead of Chrome** — Robin only defers to the Windows default handler when it can't find `chrome.exe` in either of the usual locations. Point it at yours with `ROBIN_BROWSER`.
- **The Telegram bridge starts but ignores you** — your sender id isn't on the allowlist. The console prints `Refused: sender <id> is not on the allowlist`; add that id to `allow` in `channels.json`.

## Development

```bash
npm test           # run the test suite
npm run build       # type-check and compile to dist/
```
