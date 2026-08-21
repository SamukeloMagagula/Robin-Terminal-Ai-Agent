# iMessage channel

Date: 2026-08-21

## Goal

Add iMessage as a remote-control channel, alongside Telegram, Discord, Slack,
Signal and WhatsApp: message the bot on iMessage, robin answers.

## Why this shape

iMessage has no official bot API at all. Messages.app is the only client, and
it only runs on macOS with an Apple ID signed in. The established self-hosted
answer — the same role signal-cli-rest-api plays for Signal — is
**BlueBubbles Server**: a macOS-only agent that drives Messages.app and
exposes a REST API and webhooks over HTTP. Robin does not manage that server
any more than it manages signal-cli-rest-api or a Telegram bot's own
infrastructure; it is a client of it, wherever Robin itself runs, most often
the same Mac.

BlueBubbles supports both a query-style REST API and webhooks for new
messages (server 1.0.0+), so either the Signal shape or the WhatsApp shape
would work here. This channel polls, matching Signal rather than WhatsApp:
WhatsApp's webhook exists because Meta's Cloud API genuinely cannot be
polled — there is no alternative. Nothing about BlueBubbles forces that
constraint; polling keeps this channel as simple as Signal's, with no
listener to bind and no signature-verification story to build, whether
BlueBubbles runs on the same machine as robin or elsewhere on the LAN.

iMessage has one genuine difference from every other channel here: every
message BlueBubbles reports — including the ones robin itself just sent as a
reply — comes back through the same query, because they were all sent from
the single Apple ID robin is polling as. Every message carries `isFromMe`;
anything with `isFromMe: true` is dropped before it ever reaches `handler`,
or robin would answer its own replies in a loop starting with the first one.

**Send method.** BlueBubbles can send through Messages.app's own AppleScript
interface, which works immediately after installing BlueBubbles Server with
no further macOS configuration, or through its own "Private API," which is
faster and more reliable but requires the operator to disable System
Integrity Protection to install BlueBubbles' private daemon. That is a real
security tradeoff, and not one this channel should ask for by default when
AppleScript sending works out of the box. This channel's send request
carries no private-API-specific parameter — an operator who has already
configured their BlueBubbles server to prefer Private API for other reasons
gets that behavior from the server's own settings; robin does not request
one method over the other.

Endpoint paths and payload shapes below reflect BlueBubbles Server's public
REST API. Confirm them against the operator's installed server version at
implementation time — this is an externally maintained API outside this
repo's control, the same relationship this codebase already has with
signal-cli-rest-api's endpoints.

## Config

No new fields on `ChannelConfig` (`src/channels/config.ts`) — this channel
reuses two that already exist:

- `apiUrl` — already Signal-only; its comment widens to "Signal and
  iMessage." Base URL of the BlueBubbles Server, e.g. `http://localhost:1234`.
- `token` — used generically as everywhere else; here it is the BlueBubbles
  server password, set once in the BlueBubbles Server preferences pane.

`loadChannelConfig` gains an iMessage branch requiring `apiUrl` (env
`IMESSAGE_API_URL`, or `apiUrl` in `channels.json`) — the generic `token`
check already covers the password, following the Signal precedent of a
per-channel branch only for the fields that channel alone needs. Missing
`apiUrl` throws its own `UserFacingError` naming the env var and file key,
matching every existing error in `config.ts`.

`EXAMPLE_CONFIG` gains an `imessage` block:

```json
"imessage": {
  "token": "your-bluebubbles-server-password",
  "apiUrl": "http://localhost:1234",
  "allow": ["+15551234567", "someone@icloud.com"]
}
```

## Transport

New file `src/channels/imessage.ts`.

```ts
export interface IMessageOptions {
  apiUrl: string;
  password: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so polling does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable for tests; defaults to 2000, matching Signal's interval. */
  pollIntervalMs?: number;
}

export class IMessageTransport implements ChannelTransport {
  readonly id = 'imessage';
  readonly name = 'iMessage';
  // ...
}
```

**`connect()`** — `GET {apiUrl}/api/v1/ping?password={password}`. A non-2xx
response, or a body that isn't BlueBubbles' expected `{ status: 200, message:
"pong" }` health check, throws with the response detail. Returns `{ identity:
apiUrl }` — there is no single "this account's own number" the way Signal has
one, so the server address is what the operator confirms at startup.

**`receive()`** — before entering the poll loop, queries the single most
recent message (`limit: 1`, descending sort) to seed a cursor at "now,"
mirroring Telegram's `drainBacklog`: a message that existed before `receive`
was called must never reach `handler` unprompted, the same reasoning
Telegram's own comment gives. A failure during this seed step is not fatal —
falls back to `Date.now()` as the cursor, same tolerance Telegram's
`drainBacklog` has for its own failure.

Then, while `!signal.aborted`:

1. `POST {apiUrl}/api/v1/message/query?password={password}` with body
   `{ after: cursor, sort: "ASC", limit: 100, with: ["chats", "handle"] }`.
2. For each returned message, in order: advance `cursor` to
   `max(cursor, message.dateCreated)` **before** any filtering — a
   `isFromMe` or textless message still moves the cursor past itself, or it
   would be re-fetched on every subsequent poll forever.
3. Drop the message (never call `handler`) when `isFromMe` is true, or when
   there is no text body — the same "text-only" policy Signal and WhatsApp
   already apply to attachments, reactions and other non-text payloads.
4. Otherwise map to `IncomingMessage`: `chatId` from the message's
   `chats[0].guid` (BlueBubbles addresses replies by chat, not by handle, so
   this is what `send()` needs back), `senderId` from `handle.address` (a
   phone number or email — checked against the allowlist, same shape as
   every other channel), `senderName` left `undefined` — the queried handle
   object reliably carries only the raw address, and inventing a display-name
   field this spec can't confirm exists would misrepresent what the API
   guarantees.
5. Handler errors are caught and logged, never allowed to kill the loop —
   the same rule every existing transport's `receive()` follows.

A network failure during the query step is logged and retried after a fixed
delay (matching Signal's `RETRY_DELAY_MS`), not treated as fatal — BlueBubbles
being briefly unreachable must not take the bridge down. Otherwise, sleep
`pollIntervalMs` before the next iteration.

**`send()`** — `POST {apiUrl}/api/v1/message/text?password={password}` with
body `{ chatGuid: chatId, message: text }`. Returns the created message's
`guid` from the response body when present, else `undefined` — same contract
every other transport's `send()` follows.

**`edit()`** — not implemented. No reliable, version-independent edit
endpoint to build against, same conclusion Signal and WhatsApp already
reached for their own platforms.

## Registry and CLI wiring

`src/channels/registry.ts` gets an `imessage` entry:

```ts
imessage: {
  build: ({ apiUrl, token }) => {
    if (!apiUrl) {
      throw new UserFacingError(
        'iMessage needs an apiUrl. Set IMESSAGE_API_URL, or add an "apiUrl" ' +
          'to the imessage entry in ~/.robin/channels.json.'
      );
    }
    return new IMessageTransport({ apiUrl, password: token });
  },
},
```

`CHANNELS`'s `build` config type already carries both `token` and `apiUrl` —
this is the first channel added that needs no new field on that type, so
`serve-command.ts` and `schedule/deliver.ts`'s two `build()` call sites need
no changes either; both already pass `apiUrl` through since Signal.

## Testing

New `tests/channels/imessage.test.ts`, following `tests/channels/signal.test.ts`'s
style — an injected `fetchImpl` returning scripted responses, no real
BlueBubbles server:

- `connect()` returns `{ identity: apiUrl }` on a successful ping; throws
  with response detail on a non-2xx status or an unexpected body.
- `receive()` seeds its cursor from the most recent existing message before
  polling, so a message that existed prior to `receive()` being called never
  reaches `handler`.
- Maps a queried message to `IncomingMessage`: `chatId` from
  `chats[0].guid`, `senderId` from `handle.address`, `text` from the message
  body, `senderName` left `undefined`.
- Drops a message with `isFromMe: true` — `handler` is never called for it.
- Drops a message with no text body (e.g. an attachment-only message).
- Advances the cursor even for a dropped message, so a from-me or textless
  message is never re-fetched on the next poll.
- Handler errors are caught and logged; the poll loop continues.
- A network failure during the poll is logged, retried after the fixed
  delay, and does not stop the loop.
- `send()` posts `{ chatGuid, message }` and returns the created message's
  `guid`.
- No `edit` method is exposed on the transport.

`tests/channels/config.test.ts` gains cases for iMessage's `apiUrl`
resolution and its "missing" error, mirroring the existing Signal cases.

## Out of scope

- **Attachments, reactions, tapbacks, edited/unsent message events.**
  Text-only, the same policy every existing channel already follows.
- **The Private API send method**, and anything requiring the operator to
  disable System Integrity Protection on their Mac.
- **Contact-name resolution for `senderName`.** BlueBubbles exposes a
  separate contacts endpoint that could enrich this later; not needed for
  the reply loop, and not worth guessing at a response shape this spec
  can't currently confirm.
- **Running, installing, or upgrading BlueBubbles Server.** The operator's
  responsibility, the same relationship robin already has to
  signal-cli-rest-api.
- **Non-macOS operation.** This channel only works when a BlueBubbles Server
  (which itself requires macOS) is reachable somewhere; robin keeps running
  everywhere it already does regardless.
