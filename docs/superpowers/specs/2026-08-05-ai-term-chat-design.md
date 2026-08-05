# ai-term-chat — Design Spec

Date: 2026-08-05

## Purpose

A terminal application for chatting with different AI models from the command line. Each provider that requires authentication presents a login link/flow before use; providers that don't (local models) skip straight to use.

Initial providers:
- **GitHub Copilot** — via GitHub's OAuth device code flow.
- **Ollama** (local models) — no login required, just checks the local server is reachable.

## Tech Stack

- Node.js + TypeScript
- `commander` for CLI argument/command parsing
- Plain `readline` for the interactive chat REPL (no heavier TUI framework needed)
- `chalk` for colored output
- `vitest` for unit tests

## Architecture

### Layers

1. **CLI entry** (`src/cli.ts`) — commands:
   - `ai-term-chat` (no args) — interactive provider + model picker, then drops into chat REPL.
   - `ai-term-chat login <provider>` — run auth flow standalone.
   - `ai-term-chat logout <provider>` — clear stored token.
   - `ai-term-chat chat <provider>` — skip picker, jump into a specific provider (still prompts for model if not given).

2. **Provider interface** (`src/providers/types.ts`):
   ```ts
   interface Message { role: 'user' | 'assistant' | 'system'; content: string; }

   interface Provider {
     id: string;
     name: string;
     isAuthenticated(): Promise<boolean>;
     login(): Promise<void>;       // no-op / instructional for Ollama
     listModels(): Promise<string[]>;
     chat(model: string, messages: Message[]): AsyncIterable<string>; // streamed tokens
     logout(): Promise<void>;
   }
   ```
   Providers are registered in `src/providers/index.ts` as an array. Adding a new provider later means one new file implementing `Provider` plus one registry entry — no other code changes required.

3. **Auth storage** (`src/auth-store.ts`) — single JSON file at `~/.ai-term-chat/auth.json`, created with `0600` permissions, holding per-provider long-lived tokens (e.g. Copilot's GitHub token). Short-lived derived tokens (e.g. Copilot's Copilot-API token) are kept in memory only and refreshed on demand — never persisted.

4. **Chat REPL** (`src/repl.ts`) — `readline`-based loop:
   - Streams assistant tokens as they arrive, printed in a distinct color.
   - Keeps conversation history in memory for the session only (not persisted across runs).
   - In-REPL commands: `/help`, `/exit`, `/clear` (reset history), `/model` (re-pick model within current provider), `/provider` (switch provider, re-runs auth check).

## Provider: GitHub Copilot

Auth flow (device code):
1. `POST https://github.com/login/device/code` with the GitHub OAuth client ID → returns `device_code`, `user_code`, `verification_uri`, `interval`.
2. Print: `Go to https://github.com/login/device and enter code XXXX-XXXX`.
3. Poll `POST https://github.com/login/oauth/access_token` every `interval` seconds until approved or expired.
4. Store the resulting GitHub access token in `auth.json`.
5. Before each chat request, exchange the GitHub token for a short-lived Copilot API token via `GET https://api.github.com/copilot_internal/v2/token` if the in-memory one is missing/expired (~30 min lifetime). This exchange is transparent to the user.

Chat:
- `POST https://api.githubcopilot.com/chat/completions`, OpenAI-compatible request/response schema, SSE streaming.
- `listModels()` returns a fixed known-good list (e.g. `gpt-4o`, `gpt-4o-mini`) since Copilot's model list endpoint access varies by plan; can be adjusted if the account exposes a models endpoint.

Known caveat: the OAuth client ID used for the device flow is the one commonly reused by open-source Copilot CLI/editor-plugin reimplementations (not an officially published "public" client ID for third-party use). Acceptable for personal use; could break if GitHub changes behavior for unofficial clients.

## Provider: Ollama

- `isAuthenticated()` — `GET http://localhost:11434/api/tags` succeeds → true.
- `login()` — if unreachable, print instructions to start Ollama (`ollama serve`) or install it; no actual OAuth/login since Ollama has none.
- `listModels()` — parsed from the `/api/tags` response (models already pulled locally).
- `chat()` — `POST http://localhost:11434/api/chat`, streamed via newline-delimited JSON.

## Error Handling

- Network failures during streaming: print an inline error, return to the prompt, do not crash the REPL.
- Copilot token expiry mid-session: refresh once transparently and retry the request; if that also fails, surface the error.
- Ollama unreachable: show the "start Ollama" instructional message instead of a raw connection error.

## Testing

- Unit tests (`vitest`) for provider logic: token refresh timing, message formatting, response parsing — with all HTTP calls mocked. No tests hit real GitHub/Ollama endpoints.
- Manual smoke test of full login + chat flow for both providers before considering the feature complete.

## Out of Scope (for this iteration)

- Persisting chat history across sessions.
- OS-level credential store integration (using a plain permissioned JSON file instead).
- Additional providers beyond Copilot and Ollama (architecture supports adding them later).
