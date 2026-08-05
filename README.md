# ai-term-chat

Chat with AI models from your terminal. Supports GitHub Copilot (via device-code login) and local Ollama models.

## Setup

```bash
npm install
npm run build
npm link   # makes the `ai-term-chat` command available globally
```

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

- `read_file` — reads a file's contents (no confirmation needed)
- `write_file` — writes/overwrites a file (asks for y/n confirmation first)
- `run_command` — runs a shell command (asks for y/n confirmation first)

When the model wants to write a file or run a command, you'll see a prompt like:

```
Write to hello.txt?
---
hi from the agent
---
 (y/n)
```

Answer `y`/`yes` to proceed or anything else to decline. Declined actions are reported back to the model so it can adjust its next step instead of silently failing.

## Requirements

- Node.js >= 18
- For Copilot: a GitHub account with Copilot access
- For Ollama: [Ollama](https://ollama.com) installed and running locally (`ollama serve`), with at least one model pulled (e.g. `ollama pull llama3`)
