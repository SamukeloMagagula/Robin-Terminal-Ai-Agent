# robin

Robin is a terminal agent that lets you run your AI. It talks to Anthropic (Claude), GitHub Copilot, Google Gemini, OpenRouter, Ollama, and any OpenAI-compatible server you run yourself (llama.cpp, LM Studio, vLLM, …), with tool-calling — read files, edit and write files, run shell commands — built in.

Your conversations live in a small local daemon called [the gateway](#the-gateway), not in the terminal window. That is the thing to know first, because everything else follows from it:

- **Close the terminal and reopen it — the conversation is still there.** It survives a reboot too.
- **The same conversation from anywhere.** A [browser UI](#the-control-ui), and [Telegram, Discord, Slack, Signal, WhatsApp or iMessage](#remote-control-telegram-discord-slack-signal-whatsapp-imessage) when you are away from the desk. Ask something from your phone; the answer is waiting at your keyboard.
- **A tool call always finds a human.** A command triggered from a chat message asks you at your terminal, saying where the request came from — and is refused when nobody is there. Where you want it to act unattended, a [capability manifest](#capability-manifests) says exactly what it may do, lapses on its own, and logs every decision.
- **Other tools can drive it.** An [OpenAI-compatible API](#driving-robin-from-other-tools) on the same port, so editors and scripts get Robin with its tools, memory and skills rather than a bare model.

`robin doctor` tells you what is wrong with an install before you hit it.

Built by Samukelo "Batman" Magagula.

## Contents

| | |
|---|---|
| [Install](#install) · [Requirements](#requirements) | getting it running |
| [First run](#first-run) · [Settings](#settings) | `robin setup`, and `robin config` |
| [Setting up a provider](#setting-up-a-provider) | the six it talks to |
| [Profiles](#profiles) | isolated, named copies of everything Robin owns |
| [The gateway](#the-gateway) | where conversations live |
| [The control UI](#the-control-ui) | driving it from a browser |
| [Driving Robin from other tools](#driving-robin-from-other-tools) | the OpenAI-compatible API |
| [Usage](#usage) · [Sessions](#sessions) | day to day |
| [Tool-Calling](#tool-calling) · [Security](#security) | what it can do to your machine, and what it asks first |
| [Capability manifests](#capability-manifests) | letting it act unattended, within limits |
| [Scheduled jobs](#scheduled-jobs) | prompts on a timer, answers where you want them |
| [Images, speech, transcription and screen capture](#images-speech-transcription-and-screen-capture) | the media tools |
| [Remote control](#remote-control-telegram-discord-slack-signal-whatsapp-imessage) | Telegram, Discord, Slack, Signal, WhatsApp, iMessage |
| [Editor integration (ACP)](#editor-integration-acp) | Zed, JetBrains, and other Agent Client Protocol editors |
| [Skills](#skills) · [Memory](#memory) · [MCP servers](#mcp-servers) | what it knows and what it can reach |
| [How replies are printed](#how-replies-are-printed) | markdown in a terminal |
| [Troubleshooting](#troubleshooting) | when it misbehaves |

## Requirements

- Node.js >= 18
- For Anthropic: a Claude API key from [platform.claude.com](https://platform.claude.com/settings/keys)
- For Copilot: a GitHub account with Copilot access
- For Gemini: a Google AI Studio API key
- For OpenRouter: an OpenRouter API key (gives access to a large, constantly growing catalog of models from many providers — OpenAI, Anthropic, Google, Meta, Mistral, and more — under one key)
- For Ollama: [Ollama](https://ollama.com) installed and running locally
- For a local server: anything speaking OpenAI's `/v1` — llama.cpp, LM Studio, Jan, vLLM. No account, no key
- Nothing else. No database, no service to run, no account with anyone — the gateway starts itself when you first need it

## Install

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/SamukeloMagagula/Robin-Terminal-Ai-Agent/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/SamukeloMagagula/Robin-Terminal-Ai-Agent/main/install.ps1 | iex
```

Both clone, install, build and link, printing each step as they go — piping a
script from the internet into a shell is a lot of trust to ask for silently, so
nothing either of them does is hidden.

**By hand:**

```bash
git clone https://github.com/SamukeloMagagula/Robin-Terminal-Ai-Agent.git
cd Robin-Terminal-Ai-Agent
npm ci --ignore-scripts && npm run build && npm link
```

**In Docker:**

```bash
docker build -t robin .
docker run -it --rm -v robin-data:/home/robin/.robin robin doctor
```

The volume matters — `~/.robin` holds credentials, memory, skills and
conversations, so without it every run starts logged out and forgetful.

Then start it:

```bash
robin chat ollama      # local, no API key needed
robin chat             # your default, or a menu if you have not run `robin setup`
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

**And `--ignore-scripts`**, which is doing more work than it looks like. npm
compiles any dependency carrying a `binding.gyp`, and `better-sqlite3` carries
one — so without the flag, installing needs a full C++ toolchain (Visual Studio
on Windows) and fails outright on a machine that hasn't got one. That package
also *ships* prebuilt binaries for every platform Robin runs on, so there is
nothing to compile and nothing is lost by skipping it. Not running arbitrary
install scripts is the smaller benefit, and a real one.

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

## First run

```bash
robin setup
```

Picks a provider, logs you in, picks a model, and checks the pair actually
answers before saving it as your default. After that `robin chat` starts
talking immediately instead of asking you two questions every time.

Providers needing no account come first in the list, so the fastest route
through is Ollama or a local server. Nothing is saved unless every step
succeeds — a default pointing at a provider you never finished logging into
would fail on every later `robin chat` with no hint that setup was the cause.

Re-running is safe. It shows your current choices and lets you keep them.

## Settings

`robin config` is the one place that answers what Robin is set to do.

```bash
robin config list                          # every setting, its value, where it came from
robin config get gateway.port
robin config set default.model claude-sonnet-5
robin config unset gateway.port            # back to the default
```

Settings live in `~/.robin/settings.json`. Seven keys, and `config list`
describes each one, so that is the reference rather than this table:

| Key | What it does |
|---|---|
| `default.provider` · `default.model` | what `robin chat` starts with |
| `gateway.port` | port the gateway listens on |
| `browser` | browser command used to open login pages |
| `debug` | print full stack traces on error |
| `history.enabled` | keep REPL input history between sessions |
| `local.baseUrl` | OpenAI-compatible endpoint for the local provider |

Values are checked when you set them, so `robin config set gateway.port 99999`
is refused there and then rather than at gateway startup days later.

**Environment variables still win.** Most of these keys correspond to a
`ROBIN_*` variable that worked before this file existed, and those keep
working — an exported variable outranks the file. That is the one genuinely
confusing case, so Robin says it outright rather than letting you wonder why
a setting had no effect:

```
$ robin config get gateway.port
  gateway.port     8080     from ROBIN_GATEWAY_PORT, overriding 7777 in settings.json
```

Credentials are deliberately not settings. Tokens and API keys live in
`~/.robin/auth.json` and in the channel config, so there is exactly one
answer to where a secret is kept.

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

## Profiles

Everything Robin owns — credentials, memory, skills, sessions, settings, the gateway's own daemon — lives under `~/.robin` by default. Setting `ROBIN_PROFILE` switches all of it to an entirely separate, isolated tree at once:

```bash
ROBIN_PROFILE=work robin chat
```

That reads and writes `~/.robin-profiles/work/` instead of `~/.robin` — different credentials, different memory, a different gateway daemon. Nothing is shared between profiles, and nothing about the unnamed default profile changes: leave `ROBIN_PROFILE` unset and everything works exactly as it always has, at `~/.robin`.

The gateway daemon becomes profile-aware for free: it's spawned as a child process that inherits the environment it was started with, so a daemon spawned under `ROBIN_PROFILE=work` reads and writes its own `gateway.json` under that profile's directory — a genuinely separate daemon process from your default one, or from any other profile's.

**One thing profiles don't do on their own: give each daemon a different port.** Every daemon defaults to the same port (`18790`, or whatever `ROBIN_GATEWAY_PORT` names) regardless of profile, since port choice was never tied to *which* daemon, only to *where it listens*. Switching profiles one at a time — finish with `work`, `robin gateway stop`, switch to `personal` — works with no extra setup. Running two profiles' daemons **at the same time** needs a distinct `ROBIN_GATEWAY_PORT` for each, set alongside `ROBIN_PROFILE`, or the second daemon fails to bind and never starts.

`robin profile list` shows every profile that has actually been used (has a directory) plus the one named by your current `ROBIN_PROFILE`, marking which is active. A profile is created the first time something is read or written under it — there's no `robin profile create`, the same way `~/.robin` itself has never needed an init command.

## The gateway

Your conversations don't live in the terminal any more. They live in a small
local daemon — the gateway — and `robin chat` is a client of it. So are the
[chat bridges](#remote-control-telegram-discord-slack-signal-whatsapp) and the
[control UI](#the-control-ui). The practical upshot:

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

**But `robin chat` starts a new conversation.** It resumed the directory's
last one at first, and that was wrong twice over: `robin chat` reads as *start
a chat*, so every new chat opened onto old subject matter with the model still
answering in terms of it — and the conversation in a directory used daily never
ended, so it grew until it hit the context limit. Pick the old one up
deliberately instead:

```bash
robin chat --continue    # or -c
```

Starting fresh throws nothing away — the previous conversation is still there,
and Robin says so on the way in. `/session` lists it too.

A conversation nobody said anything in is never written to disk, so opening
Robin and closing it again leaves no trace. A session untouched for two weeks
is dropped on the next start, so directories you visited once don't pile up in
`/session`. Closing a session forgets it immediately.

**Tools run where your terminal is.** A session records a working directory,
and `robin chat` re-binds it on attach — so continuing a restored conversation
from a different directory runs commands where you actually are, not where the
conversation started. `/session cwd` moves an open one by hand; the
conversation itself is untouched, because a `cd` is not a change of subject.

**A daemon that outlived its build says so.** The gateway keeps running across
a `npm run build`, and one running yesterday's code doesn't misbehave — it just
behaves like yesterday's code, which is far more confusing. So it fingerprints
the compiled output at startup and re-checks it on every connect. If they
differ, `robin chat` and the control UI both say so. The fix is `robin gateway
stop` followed by starting it again — stopping it does not restart it, and it
ends any session attached to it, so the warning says that rather than implying
a reload is enough. It warns rather than refuses, because most rebuilds change
nothing a running daemon would get wrong.

### The control UI

```bash
robin ui
```

Opens a browser onto the same gateway: your open sessions down the left, the
conversation in the middle, and a box to type in. It is a client like the
terminal is — attach to a session started at the keyboard and you are in the
same conversation, streaming as it happens.

Replies are rendered there too — the same rules the terminal uses, so bold is
bold and a fenced block is a block, in either surface.

You can drive it from the browser, not just watch: start a conversation by
picking a provider and model, close one, and stop a turn that is running. The
provider list comes from the daemon, because a page cannot read
`~/.robin/auth.json` to find out what you are logged into.

Approvals appear here too, as a dialog, with the same origin line the terminal
shows, and the same four answers. Answer in either place; the first answer wins
and the other closes.

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
robin chat local         # a local OpenAI-compatible server you are running
robin chat random        # let Robin roll a provider and model for you
robin login copilot      # log in to Copilot ahead of time
robin logout copilot     # clear stored Copilot credentials
robin status              # show login/reachability status for every provider
robin doctor              # check the install and report anything that would stop it starting
robin models              # list models recorded as unsupported
robin models forget gemini  # clear those records so they're offered again
robin serve telegram      # run as a bridge you can drive from Telegram
robin serve discord       # …or Discord
robin serve slack         # …or Slack
robin serve telegram --whoami   # print the sender id of whoever messages, for the allowlist

robin ui                  # open the control UI in a browser
robin gateway status      # is the daemon running, and from which build
robin gateway stop        # stop it — the next command starts a fresh one

robin skill list          # the skill catalogues
robin skill add anthropic pdf   # install one
robin skill update        # re-fetch what you installed
robin mcp                 # review and approve MCP servers
```

In a chat session, typing `/` shows a live-filtered popup of matching commands as you keep typing — arrow keys to move the highlight, **Tab** to fill in the highlighted command without submitting (so you can still type an argument), **Enter** to submit the highlighted command (or your typed line, if the popup isn't open), **Esc** to dismiss the popup and keep typing free text.

**↑ / ↓ recall what you've already sent.** With the popup closed, ↑ walks back through the lines you've submitted this session and ↓ walks forward again. Come all the way back down and you get your half-typed line returned to you, exactly as you left it. Consecutive duplicates collapse, and history persists across restarts in `~/.robin/input-history` — the same private tree that already holds your full transcripts, so it adds no new exposure, but it does add longevity. Set `ROBIN_NO_HISTORY_FILE=1` to keep it session-only, or clear what's already there with `/history clear`.

- `/help` (or just `/`) — list commands
- `/model` — pick a different model from the ones available on the current provider
- `/provider` — switch provider (e.g. Copilot ↔ Gemini ↔ OpenRouter ↔ Ollama ↔ a local server), or pick `🎲 Random`
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

`robin chat` opens a new conversation each time; `robin chat --continue` picks up the last one in the current directory. See [The gateway](#the-gateway) for why that's the default.

## Skills

A skill is a reusable instruction set. Each lives in its own directory as `~/.robin/skills/<name>/SKILL.md`, with `name` and `description` frontmatter — the [agentskills.io](https://agentskills.io) layout, so a skill written here can be shared with other tools and one written elsewhere can be dropped in.

Save the current system prompt as a skill with `/skill save <name>`, apply one with `/skill use <name>`, and `/skill` lists them with their descriptions.

### Where skills come from

Skills are installed from published catalogues, not written by the model. Three are built in, all using the same `SKILL.md` layout:

```bash
robin skill list                      # the catalogues
robin skill list hermes review        # what's in one, filtered
robin skill add anthropic pdf docx    # install by name
robin skill update                    # re-fetch what you installed
```

| Source | Repository | Skills |
|---|---|---|
| `anthropic` | [anthropics/skills](https://github.com/anthropics/skills) | 17 |
| `openclaw` | [openclaw/openclaw](https://github.com/openclaw/openclaw) | 45 |
| `hermes` | [Undermybelt/hermes-skills](https://github.com/Undermybelt/hermes-skills) | 1400+ |

An installed skill is a copy taken the day you installed it, so it records where it came from and `robin skill update` re-fetches the lot. Skills you wrote yourself with `/skill save` have no source and are never touched — there is nowhere to refresh them from, and overwriting them would destroy your own work.

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

**`robin memory nudge`** schedules a weekly review of everything remembered — a curated preset over [Scheduled jobs](#scheduled-jobs), not a new mechanism. It asks Robin to look over its own memory and report what's stale, contradicted by something else, or safe to forget, delivered wherever you point it:

```bash
robin memory nudge --deliver telegram:123456789
robin memory nudge --deliver telegram:123456789 --every "0 8 * * 1"   # custom cadence
```

It's `robin schedule add` under the hood with a fixed job name (`memory-nudge`, one at a time) and a curated prompt, so `robin schedule list`, `robin schedule show memory-nudge` and `robin schedule remove memory-nudge` all work on it exactly like any other job.

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

## Remote control (Telegram, Discord, Slack, Signal, WhatsApp, iMessage)

`robin serve` runs Robin as a bridge so you can drive it from a messaging app while you're away from the terminal.

Six channels can drive Robin: Telegram, Discord, Slack, Signal, WhatsApp and
iMessage. Email is send-only — see [Scheduled jobs](#scheduled-jobs) —
because an allowlist built on a forgeable `From` header would be a much
weaker gate than the platform-authenticated ids these six provide.

```bash
robin serve telegram
robin serve discord
robin serve slack
robin serve signal
robin serve whatsapp
robin serve imessage
```

Telegram, Discord, Slack, Signal and iMessage all connect *outward* — long-polling or an open socket — so none of them needs a public address or an open port; that's the whole reason these came first, since they run from a laptop behind NAT exactly as they are.

**However you can't know your own sender id until something tells you.** Every channel here supports `--whoami` for exactly that: `robin serve <channel> --whoami` connects, prints the id of anyone who messages it, and reaches the model with nothing — message the bot once, copy the id it prints, add it to `allow` in `channels.json`.

**Slack needs two tokens**, issued separately: the bot token (`xoxb-`) to act, and an app-level token (`xapp-`, created under *Basic Information → App-Level Tokens* with the `connections:write` scope) to open the socket. Enable Socket Mode, subscribe to `message.im` and `message.channels`, and put both in `channels.json` as `token` and `appToken`, or in `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

**Signal has no official bot API.** It talks to a self-hosted [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) container instead of a token: run that container with a phone number registered to signal-cli, then set `apiUrl` (the container's base URL) and `phoneNumber` (the registered number, E.164 format) in `channels.json`'s `signal` entry, or `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER`. There is no message-editing endpoint, so a streamed reply appears once, finished, rather than being edited in place the way the other three do.

**WhatsApp is the one channel here that needs a public address.** Meta's Business Cloud API has no polling mode — it pushes messages to a webhook URL over HTTPS, full stop. `robin serve whatsapp` starts a small dedicated HTTP listener (separate from the gateway's own loopback-only server) that you point a reverse proxy or tunnel (ngrok, Caddy, a cloud load balancer) at. You need, from [developers.facebook.com](https://developers.facebook.com): an access token, a phone number id, an app secret (verifies every inbound request really came from Meta), and a verify token you make up yourself (used once, during webhook registration, to prove the endpoint is yours). Set `token`, `phoneNumberId`, `verifyToken`, `appSecret` and `webhookPort` in `channels.json`'s `whatsapp` entry, or `WHATSAPP_BOT_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` and `WHATSAPP_WEBHOOK_PORT`. Like Signal, there's no message-editing endpoint. And Cloud API only allows a free-form reply within 24 hours of the user's last message — outside that window it needs a pre-approved message template, which this channel does not set up for you.

**iMessage has no official bot API either.** Messages.app only runs on macOS with an Apple ID signed in, so this channel talks to a self-hosted [BlueBubbles Server](https://bluebubbles.app/) instead — install it on a Mac (the same one Robin runs on, most commonly), find its server password in BlueBubbles' preferences, and set `apiUrl` (the server's base URL) and `token` (the server password) in `channels.json`'s `imessage` entry, or `IMESSAGE_API_URL` and `IMESSAGE_BOT_TOKEN`. Every message BlueBubbles reports includes the ones Robin itself just sent, since they were sent from the same Apple ID it's polling as — Robin drops anything marked `isFromMe` before it ever reaches the model, or it would answer its own replies. Sends go through Messages.app's AppleScript interface rather than BlueBubbles' faster Private API, which needs System Integrity Protection disabled to install — not a tradeoff this channel asks for by default. Like Signal, there's no message-editing endpoint.

Teams is a recognised channel name that explains what it still needs — an Azure app registration and a Bot Framework endpoint reachable from Microsoft's cloud. Everything above the transport — access control, sessions, approvals, the agent loop — is already shared, which is why Discord was one file and Signal, WhatsApp and iMessage were not much more.

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

Each chat maps to a gateway session, which is why a conversation you start on your phone is waiting in your terminal when you sit down.

**Replies stream.** A chat client has no partial-message concept, so Robin posts a placeholder immediately and edits it as the answer arrives — the alternative being a silence long enough to look like the bot has died, followed by a wall of text. Edits are throttled to one every two seconds: both platforms rate-limit per channel, and an edit per token would hit that within a sentence and throttle the whole bridge.

## Editor integration (ACP)

`robin acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) — the same wire format Zed, JetBrains and other ACP-aware editors use to talk to an AI agent. Point your editor's agent command at `robin acp` (or however it configures a custom agent) and it spawns Robin as a subprocess, talking JSON-RPC 2.0 over stdin/stdout.

Like the chat bridges above, this is a bridge into the same gateway — connects as a `terminal`-kind client, so a conversation started in your editor is the same session your terminal would see, and permission prompts appear as your editor's own approval UI rather than a terminal `y/n/a/x` box.

`robin setup` needs to have been run first — there's no interactive picker to fall back to over stdio, so `robin acp` uses whatever default provider and model that command stored.

**What v1 doesn't do:** it doesn't route file reads/writes or command execution through the editor's own fs/terminal integration — Robin's tools touch disk directly, the same as everywhere else, which is already correct when the editor and Robin run on the same machine. It doesn't resume a past session (`session/new` always starts fresh). And tool activity — an auto-approved command and its output — shows up as plain text in the reply rather than the structured diff/tool-call blocks some editors can render, since the gateway doesn't yet emit the per-tool-call data that would need.

## How replies are printed

Models write markdown whether or not anyone asked them to. Printed raw, that
means reading `**important**` with the asterisks in the way — the markup
competing with the words it is meant to emphasise. Robin renders it instead:

| Written | Shown |
|---|---|
| `**bold**`, `__bold__` | **bold**, no asterisks |
| `*italic*`, `_italic_` | *italic* |
| `` `code` `` | coloured, no backticks |
| `# Heading` | bold and coloured, no hashes |
| `- item` | a coloured bullet |
| `> quote` | a left bar, dimmed |
| `[text](url)` | the text, underlined, with the target dimmed after it |
| ```` ```lang ```` | the language as a label, the block coloured and left alone |

**Nothing inside a code span or a fence is styled.** That text is source, and a
`**` in there is two asterisks someone meant to write. For the same reason the
emphasis rules require a non-space next to the marker, so `2 * 3 * 4` stays
arithmetic and `read_file` keeps its underscore — mangling those is worse than
not rendering emphasis at all.

**Replies arrive a line at a time rather than a token at a time.** Styling
cannot be decided from half a line — a `**` might open a bold span or might be
two asterisks — and text already written to a terminal cannot be taken back.
For prose the difference is barely visible; for code blocks it is an
improvement.

Colour follows the terminal. Piping to a file, or setting `NO_COLOR`, drops the
escapes and keeps the text — the markers are still removed either way.

## Chat History

Every conversation is automatically written to a readable markdown transcript in `~/.robin/chats/robin-chat-<timestamp>.md`, updated after every reply — nothing to remember to do. A new file starts whenever the conversation resets (`/clear`, `/model`, `/provider`, `/load`), so each distinct conversation gets its own file you can browse, search, or share later.

This is separate from `/save`/`/load`, which store an exact, reloadable snapshot as JSON under `~/.robin/conversations/` — use `/save` when you want to resume a specific conversation later inside `robin`; the markdown transcript is for your own reading/reference outside the app.

Use `/recall <query>` to search across all past markdown transcripts from inside a chat session. It's keyword search, not semantic — but enough to find "did I already ask about X" without leaving the terminal.

Searches run against a full-text index at `~/.robin/index.db` (SQLite FTS5), built on first use and updated incrementally as transcripts change — only files whose modification time moved are re-read. Results come back ranked by relevance rather than by file order, capped at 10.

`better-sqlite3` is a native module. On a platform with no prebuilt binary it may fail to install, and Robin handles that rather than breaking: `/recall` falls back to the original linear scan and says so once per search. The results are the same, the search is just slower.

More than a few matches and `/recall` summarizes them instead of printing every line — a wall of disconnected excerpts is harder to read than a short account of what was discussed, once there's more than a handful. The summary is generated by whatever provider and model the current session is already using, so there's nothing new to configure. The excerpts themselves are still the ones sent into the conversation afterwards, unchanged — the summary is a readability aid on the terminal, not a replacement for what the model is grounded on. If summarization fails for any reason (a network hiccup, an auth problem), `/recall` quietly falls back to the raw listing.

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

### Delegating to subagents

The model can call `delegate_task` with up to 4 subtasks, each of which runs as a **fresh agent with no memory of the conversation** — genuinely useful for work that splits into independent pieces (reviewing several files, researching several unrelated questions), not for a single sequential task, which runs faster without the isolation. Subtasks run concurrently and their results come back as one combined reply.

Each subagent gets the same four base tools (`read_file`/`write_file`/`edit_file`/`run_command`) and nothing else — no memory, skills, media, MCP, or `delegate_task` itself, so nothing it does can recursively spawn more subagents. Its tool calls are gated by the exact same approval prompts as anything else in the conversation, since it's still your call being asked for — just possibly more than one at a time, if two subagents both hit something that needs a yes/no in the same moment. Those prompts queue and show one at a time rather than overlapping.

### Running commands in Docker instead of directly

`robin chat --backend docker:<image>` runs `run_command` inside a Docker container instead of directly on your machine — `robin chat --backend docker:node:20`, for instance. No default image: a guessed one would make a command like `npm test` fail for a reason that isn't obvious, so `--backend docker` alone is a clear error naming the fix.

The container starts on the first command of the session and stays up for the rest of it — not a fresh container per command, which would pay startup cost every time and lose whatever the previous command left behind (installed packages, temp files). Your working directory is bind-mounted in at `/workspace`, so `read_file`/`write_file`/`edit_file` keep working exactly as they do today, reading and writing the real files on your machine — only `run_command`'s execution moves into the container, and the mount is what keeps the two views of the same files in sync. The container stops when the session closes.

Approval gating, the read-only allowlist, and the dangerous-command warning are all unchanged — the backend only decides *where* an already-approved command runs, not whether it needs approval.

This is the first of what's meant to be several backends. SSH, and eventually sandboxed cloud runners, are on the list; each is genuinely its own project, not a flag away.

## Security

**Robin has no sandbox by default.** Every approved command runs as a direct child of the Robin process with your full user permissions — no container, no separate user, no syscall filter, no network policy. `--backend docker` (see above) moves `run_command`'s execution into a container, but everything else — `read_file`/`write_file`/`edit_file`, the approval decision itself — still happens on the host exactly as described below. The mechanisms below reduce risk and prevent accidents; none of them is containment, and each operates on a string the model produced. The real boundary is you reading the prompt before you answer it.

Full trust model, including what each control does *not* do: **[SECURITY.md](SECURITY.md)**.

- **Credentials** (Copilot token, Gemini API key) are stored in plaintext at `~/.robin/auth.json` — the same approach tools like the GitHub CLI and `npm login` use. Written `0600` with the directory `0700` on POSIX, re-applied on every write so an existing file with looser permissions gets tightened; on Windows this relies on your user profile's normal NTFS permissions, since POSIX mode bits aren't meaningful there.
- **`read_file`/`write_file` refuse to touch credential locations**: `~/.robin/`, `~/.ssh/`, `~/.gnupg/`, `~/.aws/`, `~/.kube/`, `~/.docker/`, `~/.config/gh/` and gcloud config, plus credential filenames wherever they live (`.env`, `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa`, …). Paths are resolved to their real target first, so a symlink pointing into a protected directory is caught rather than waved through. **`run_command` cannot refuse outright** — a shell command has no single structured path argument the way `read_file`/`write_file` do, and legitimate commands (`ssh-keygen -f ~/.ssh/id_rsa`) target these locations on purpose — but a command whose arguments reference one of those locations is never auto-approved by the read-only allowlist below, even for a normally-safe verb like `cat` or `head`, and the confirmation prompt names the credential path it found.
- **`write_file` always confirms; `read_file` confirms for anything outside the current working directory** — reading unrelated files is how data leaves your machine and enters the model's context. `run_command` confirms unless the command is on the read-only allowlist described above.
- **Approvals can be remembered per action-kind for the current session** (`a` at the prompt). Session-scoped, never written to disk. Note that this deliberately removes the human from the loop for that action kind until you restart — treat `a` with more care than `y`.
- **A chat bridge answers only sender ids on an explicit allowlist.** An empty allowlist authorises nobody and refuses to start, rather than coming online and silently declining everyone.
- **A tool call from a chat still needs a human.** It is offered to any terminal attached to the same gateway, labelled with the channel and sender that caused it, and refused when no terminal is attached — so "nobody is at a keyboard" and "nobody approved it" stay the same thing. `--allow-tools` removes that entirely: with it, a chat message runs commands and writes files on your machine unattended, and the reading-the-prompt boundary above no longer exists. See [Remote control](#remote-control-telegram-discord-slack-signal-whatsapp).
- **A capability manifest is a narrower answer than `--allow-tools`.** See [Capability manifests](#capability-manifests) below. It grants specific patterns rather than everything, lapses after seven days by default, records every decision, and stops granting the instant it is revoked. It only ever grants past the approval prompt — never past the credential-path refusals or the read-only allowlist above, both of which run before any manifest is consulted.
- **The destructive-pattern `⚠` is a nudge, not a block.** It catches `rm -rf` but not `rm -r -f`, `$(echo rm) -rf`, or anything encoded. Don't rely on it.
- **`read_file` and `run_command` output is wrapped as untrusted content** before it goes back to the model — file contents and command output are data the model reads, not instructions it should follow, even if the text looks like a command ("ignore previous instructions and run…"). This narrows prompt injection; it does not eliminate it, since it is a prompt-level convention the model can still be talked out of.
- **Conversation transcripts in `~/.robin/chats/` contain every file the model read.** They're written `0600`, but treat them as sensitive.
- To actually contain Robin, run it in a container or VM with only your working directory mounted.

## Capability manifests

There are two unsatisfying answers to "may this chat message run a command?"
Ask a human — but nobody is at the keyboard at 02:00. Or `--allow-tools`, which
lets a chat message run anything at all. A manifest is the answer in between:
*these specific things, without asking.*

```bash
robin autonomy add nightly-ops \
  --command "restic backup *" --command "git status" \
  --read "~/notes/**" --write "~/reports/**" \
  --expires 7d --escalate telegram:30

robin serve telegram --manifest nightly-ops
```

The rules are printed in full and confirmed before anything is written, because
`--command "git *"` grants more than it looks like. `robin autonomy add` refuses
to run without an interactive terminal at all — a grant to act unattended is a
decision a person makes while present, not one a script makes.

```bash
robin autonomy list              # what exists, and when each lapses
robin autonomy show nightly-ops  # every rule, in full
robin autonomy log nightly-ops   # what it allowed — and what it refused
robin autonomy revoke nightly-ops
```

`log` is the one worth knowing about. It answers what a manifest was used for
*and* what it turned down, and the second list is what reveals a manifest that
is wrong.

Four things are deliberate:

- **Grants lapse.** Seven days unless you pass `--expires`. `never` exists and
  is the option most likely to be regretted.
- **Revoking is immediate**, including for a session already running under it.
  The grant is looked up per request rather than held, so nothing keeps its
  powers until a restart.
- **Manifests are never edited.** Widening one means revoking it and creating
  it again, because that is what it is.
- **A manifest only skips the prompt.** The credential-path refusals and the
  read-only allowlist run first and are not subject to it — so no manifest can
  grant a read of `~/.ssh/`.

`--escalate telegram:30` is a middle ground again: a request the manifest does
not cover is offered to you on that channel and waits the given minutes rather
than the few a terminal prompt assumes. Not answering is still a refusal.

## Scheduled jobs

A job is a prompt the gateway sends itself on a timer, and an answer sent
wherever you want it.

```bash
robin schedule add standup \
  --at "0 9 * * 1-5" \
  --prompt "Summarise yesterday's commits in this repo." \
  --manifest read-only-repo \
  --deliver telegram:123456789
```

```bash
robin schedule list                 # when each next runs, and how the last run went
robin schedule show standup
robin schedule disable standup      # stop it running without forgetting it
robin schedule remove standup
```

**Answers can go to a chat or to your inbox.** `--deliver telegram:123456789`
sends to a chat; `--deliver email:you@example.com` sends mail. Leave it off and
the answer is only recorded, which `robin schedule show` will tell you.

Email needs an `email` section in `~/.robin/channels.json`:

```json
{
  "email": {
    "host": "smtp.gmail.com",
    "port": 587,
    "user": "you@gmail.com",
    "from": "Robin <you@gmail.com>"
  }
}
```

The password comes from `SMTP_PASSWORD`, which is the better habit —
`channels.json` travels with your dotfiles. It can go in the file as
`"password"` if you would rather, and the environment wins when both are set.
Port 465 is treated as implicit TLS and 587 as STARTTLS unless you say
otherwise with `"secure"`.

**Email is one-way: Robin can mail you, you cannot mail Robin.** That is a
deliberate limit rather than unfinished work. Every other channel's allowlist
checks an identity the platform authenticated — a Telegram user id, a Slack
member id — but a `From` header is whatever the sender typed. Accepting
instructions on that basis, on a surface that can trigger tool calls, would be
a real downgrade dressed up as a feature. So there is no inbox polling and no
`robin serve email`.

**The schedule is cron, minus the parts that surprise people.** Five fields —
minute, hour, day-of-month, month, day-of-week — with numbers, `*`, ranges
(`1-5`), lists (`8,12,18`) and steps (`*/30`). No `@daily`, no month or day
names, no seconds. Anything it does not understand is refused when you add the
job, rather than at 02:00 when nothing happens. Times are local.

The one genuine cron trap is kept, because changing it would make familiar
expressions mean something new: when *both* day fields are restricted they are
OR-ed, so `0 0 1 * 1` means the 1st of the month **or** any Monday.

**Jobs fire only while the gateway is running**, so `robin schedule add` starts
it for you and tells you it has. It is the same daemon `robin chat` uses, and
`robin gateway stop` stops it.

**A missed run is skipped, not made up.** If your laptop was asleep at 02:00,
the backup report does not arrive at 09:14 when it wakes — the value of that
run was in its timing. `robin schedule list` shows when each job last ran,
which is where a missed run becomes visible.

**A job has no human to ask.** Without `--manifest` its tool calls are refused,
so it can still think and summarise but cannot read a file or run a command —
`robin schedule add` says so when you leave the flag off. With one, it may do
exactly what that [manifest](#capability-manifests) allows, and every decision
lands in `robin autonomy log`.

Delivery failures count as failed runs: a report nobody received did not
happen. The reason is kept and shown in `robin schedule list`, and the job
stays enabled — a provider that was down at 02:00 is usually up tomorrow, and
quietly switching a job off would be worse than a run that fails visibly.

## Images, speech, transcription and screen capture

Four extra tools appear once you are logged in to Gemini:

| Tool | What it does |
|---|---|
| `generate_image` | writes an image from a prompt |
| `speak` | writes spoken audio from text |
| `transcribe` | reads an audio file and returns what is said |
| `describe_screen` | captures the screen and describes what is on it |

```bash
robin login gemini     # the only credential these need
```

They use the Gemini key you already have, so there is no second account to
open. When Gemini is not logged in the tools are not offered at all — a tool
the model can see but never use is one it keeps reaching for.

**They are gated exactly like any other file access, because that is literally
what they are.** Generating an image is a write, so it asks with the same
prompt `write_file` uses and is refused in the same protected directories.
Transcribing is a read, so it asks as a read. Nothing here has its own path
handling, which is why no media tool can write into `~/.ssh/` and why a
[manifest](#capability-manifests) rule like `--write "~/reports/**"` governs
generated files without knowing anything about media.

You are asked *before* the API call, not after, so a picture you decline costs
nothing.

**`describe_screen` is different: no [manifest](#capability-manifests) can ever
grant it.** It captures your whole visible desktop, which exposes more than
any single file a `--read`/`--write` rule could name, so it always needs a
live human at a terminal to approve it in the moment — there is no
`--capture-screen` flag, on purpose, and no capability manifest can be written
by hand to work around that either. Capture itself shells out to your OS's own
screenshot tool (nothing to install on macOS or Windows; on Linux, whichever
of `grim`, `scrot`, `gnome-screenshot` or ImageMagick's `import` is already on
your machine), so it works no matter which provider is answering the
conversation.

**The model ids are settings**, because Google renames these models often:

```bash
robin config set media.imageModel gemini-2.5-flash-image
robin config set media.speechModel gemini-2.5-flash-preview-tts
robin config set media.transcribeModel gemini-2.5-flash
robin config set media.visionModel gemini-2.5-flash
```

If a call fails saying the model does not exist, that is a rename and the fix
is one `robin config set` rather than a new release.

Speech comes back as raw PCM, which no player will open, so Robin wraps it in
a WAV container before writing — the file you get actually plays. Transcription
holds the audio in memory to send it, so files over 20 MB are refused with a
message rather than failing obscurely.

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
