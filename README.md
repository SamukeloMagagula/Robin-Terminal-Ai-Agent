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

## Requirements

- Node.js >= 18
- For Copilot: a GitHub account with Copilot access
- For Ollama: [Ollama](https://ollama.com) installed and running locally (`ollama serve`), with at least one model pulled (e.g. `ollama pull llama3`)
