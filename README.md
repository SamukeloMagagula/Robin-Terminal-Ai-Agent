# ai-term-chat

Chat with AI models from your terminal. Supports GitHub Copilot (via device-code login) and local Ollama models, with tool-calling (read files, write files, run shell commands) built in.

## Requirements

- Node.js >= 18
- For Copilot: a GitHub account with Copilot access
- For Ollama: [Ollama](https://ollama.com) installed and running locally

## Setup

```bash
npm install
npm run build
npm link          # makes the `ai-term-chat` command available globally
```

`npm link` only needs to be run once (or again after pulling changes that touch `package.json`). After that, `ai-term-chat` works from any directory.

### Setting up a provider

**GitHub Copilot:**

```bash
ai-term-chat login copilot
```

This prints a device code and opens your default browser to GitHub's device authorization page. Confirm the code shown matches, then click **Authorize**. Credentials are stored in `~/.ai-term-chat/auth.json`.

**Ollama:**

```bash
ollama pull llama3.1     # or any other tool-capable model (e.g. qwen2.5)
ollama serve              # if it isn't already running as a background service
```

No login needed — `ai-term-chat` just checks `http://localhost:11434` is reachable. Older/smaller Ollama models that don't support tool-calling will still chat normally; they just won't be able to use tools.

## Usage

```bash
ai-term-chat                  # interactive provider + model picker
ai-term-chat chat copilot     # jump straight into Copilot
ai-term-chat chat ollama      # jump straight into Ollama
ai-term-chat login copilot    # log in to Copilot ahead of time
ai-term-chat logout copilot   # clear stored Copilot credentials
```

In a chat session:

- `/help` — list commands
- `/model` — switch model within the current provider
- `/provider` — switch provider
- `/clear` — reset the conversation
- `/exit` — quit

## Tool-Calling

Every chat session gives the model access to three tools:

- `read_file` — reads a file's contents (no confirmation needed; refuses to read `~/.ai-term-chat/auth.json`, where credentials are stored)
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

`run_command` executes with the same permissions as the terminal you're running `ai-term-chat` in — there's no sandboxing, so only approve commands you'd be comfortable running yourself.

## Troubleshooting

- **"Not logged in to Copilot"** — run `ai-term-chat login copilot`.
- **Ollama chat hangs or errors immediately** — confirm `ollama serve` is running and `ollama list` shows at least one pulled model.
- **Copilot device code expires before you approve it** — device codes last about 15 minutes; just rerun `ai-term-chat login copilot` for a fresh one.
- **Browser doesn't open automatically during login** — copy the printed URL and code and enter them manually at https://github.com/login/device.

## Development

```bash
npm test           # run the test suite
npm run build       # type-check and compile to dist/
```
