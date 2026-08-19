# Signal channel

Date: 2026-08-19

## Goal

Add Signal as a remote-control channel, alongside Telegram, Discord and Slack:
message the bot on Signal, robin answers.

## Why this shape

Signal has no official bot API. The self-hosted answer everyone uses is
[`signal-cli`](https://github.com/AsamK/signal-cli), which speaks Signal's own
protocol on behalf of a registered phone number. Two ways to talk to it exist:

1. **`signal-cli-rest-api`** — a community Docker image
   (`bbernhard/signal-cli-rest-api`) that wraps signal-cli in a plain HTTP REST
   API: `GET /v1/receive/{number}` to poll, `POST /v2/send` to send.
2. **`signal-cli daemon --json-rpc`** directly — a persistent TCP or unix
   socket speaking line-delimited JSON-RPC 2.0.

This spec targets (1). It reuses the exact shape `TelegramTransport` already
has — HTTP calls via an injectable `fetch`, a poll loop with backoff — so
there is no new protocol code, no new dependency, and no new pattern for the
next person reading the channel modules to learn. Option (2) would mean
building socket framing and JSON-RPC request/response correlation from
scratch, for a self-hosted-only channel where the operational cost (running
signal-cli) is identical either way — only the client-side complexity differs,
and (2) is strictly more of it for no user-facing benefit.

Robin does not manage the signal-cli / REST API process. Same relationship it
has to a Telegram bot token: the user brings a running, reachable credential;
robin is a client of it.

## Config

`ChannelConfig` (`src/channels/config.ts`) gains two new optional fields:

```ts
export interface ChannelConfig {
  token: string;
  appToken?: string;
  /** Base URL of the signal-cli-rest-api container. Signal only. */
  apiUrl?: string;
  /** The registered Signal number, E.164 format. Signal only — this is the
   *  channel's identity, in the role a bot token plays for every other
   *  channel. */
  phoneNumber?: string;
  allow: string[];
  provider?: string;
  model?: string;
}
```

`token` stays present but unused for `signal` — `loadChannelConfig` still
requires *some* token today (it throws `No token for "signal"` otherwise), so
the Signal entry's `token` field is repurposed to carry `phoneNumber` for that
check, and `apiUrl` is read as its own field. Concretely:

- `apiUrl`: from `SIGNAL_API_URL` env var, or `apiUrl` in `channels.json`.
  Required — no default, since there's no "well-known" self-hosted URL.
- `phoneNumber`: from `SIGNAL_PHONE_NUMBER` env var, or `phoneNumber` in
  `channels.json`. Reuses the existing `token` plumbing so
  `loadChannelConfig`'s existing required-token check covers it for free —
  `tokenEnvVar('signal')` resolves to `SIGNAL_BOT_TOKEN` today, which is wrong
  for this channel, so `config.ts` gets a small per-channel override: Signal
  reads `SIGNAL_PHONE_NUMBER` instead of `SIGNAL_BOT_TOKEN` wherever the token
  env var is resolved.

`EXAMPLE_CONFIG` gains a `signal` block:

```json
"signal": {
  "phoneNumber": "+15551234567",
  "apiUrl": "http://localhost:8080",
  "allow": ["+15559876543"]
}
```

## Transport

New file `src/channels/signal.ts`, mirroring `telegram.ts`'s structure.

```ts
export interface SignalOptions {
  apiUrl: string;
  phoneNumber: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval. Overridable for tests; defaults to 2000. */
  pollIntervalMs?: number;
}

export class SignalTransport implements ChannelTransport {
  readonly id = 'signal';
  readonly name = 'Signal';
  // ...
}
```

**`connect()`** — `GET {apiUrl}/v1/about`. A non-2xx or connection failure
throws with the detail signal-cli-rest-api gives (unreachable container, wrong
URL). Returns `{ identity: phoneNumber }` — there's no separate "bot identity"
to discover the way Telegram's `getMe` gives one; the phone number the operator
configured *is* the identity.

**`receive()`** — polls `GET {apiUrl}/v1/receive/{phoneNumber}` every
`pollIntervalMs` (default 2000). No long-poll parameter exists on this
endpoint (unlike Telegram's `getUpdates` timeout), so backing off to a fixed
interval is the whole strategy — the same shape as Telegram's `RETRY_DELAY_MS`
backoff-after-failure, just applied unconditionally rather than only after an
error.

Each response is an array of envelopes. An envelope maps to `IncomingMessage`
when it has a `dataMessage.message`:

```
{
  "envelope": {
    "source": "+15559876543",
    "sourceName": "Sam",
    "dataMessage": {
      "message": "hello",
      "groupInfo": { "groupId": "abc123==" }   // present only in groups
    }
  }
}
```

- Group message: `chatId = groupInfo.groupId`, `senderId = source`.
- Direct message: `chatId = source`, `senderId = source`.
- `senderName = sourceName` (undefined when absent — matches the `?` on
  `IncomingMessage.senderName`).
- An envelope with no `dataMessage.message` (receipts, typing indicators,
  sync messages) is dropped, same as Telegram drops updates with no `text`.

Handler errors inside the loop are caught and logged, never allowed to kill
polling — identical to Telegram's `receive()`.

**`send()`** — `POST {apiUrl}/v2/send` with
`{ message: text, number: phoneNumber, recipients: [chatId] }`. `chatId` here
is whatever `receive()` produced: a phone number for a DM reply, a group id for
a group reply — the REST API accepts both in `recipients`. No message-length
chunking: signal-cli-rest-api doesn't document a hard limit the way Telegram's
4096-char cap is documented, so none is enforced until a real failure shows
one is needed.

**`edit()`** — not implemented. The REST API has no message-edit endpoint.
Per the `ChannelTransport` contract, an absent `edit` just means the bridge
posts the finished reply once instead of streaming edits — the same fallback
every transport had before streaming existed.

## Registry and CLI wiring

`src/channels/registry.ts`: replace the implicit gap (Signal isn't mentioned
at all today) with a real entry:

```ts
signal: {
  build: ({ apiUrl, phoneNumber }) => new SignalTransport({ apiUrl, phoneNumber }),
},
```

`CHANNELS`'s `build` signature currently takes `{ token, appToken? }`; it
widens to also carry `apiUrl?` and `phoneNumber?` so this entry can destructure
them. `serve-command.ts` passes the full loaded `ChannelConfig` through
already, so no change needed there beyond the wider type.

## Testing

New `tests/channels/signal.test.ts`, mirroring `tests/channels/telegram.test.ts`:
a `fakeFetch` helper that replays queued JSON responses and aborts the poll
loop once the queue is exhausted.

- `connect()` returns the configured phone number as identity on a healthy
  `/v1/about`.
- `connect()` throws with the response detail when the container is
  unreachable or returns an error status.
- `receive()` maps a DM envelope to `IncomingMessage` with `chatId === senderId
  === source`.
- `receive()` maps a group envelope to `IncomingMessage` with `chatId ===
  groupId`, `senderId === source`.
- `receive()` drops an envelope with no `dataMessage.message` (e.g. a receipt).
- `receive()` keeps polling past a fetch rejection (network blip) rather than
  exiting.
- `receive()` polls again after an empty response — this is what proves the
  interval-based loop actually loops, since there's no long-poll timeout to
  exercise the way Telegram's is.
- `send()` posts the expected body and includes the reply in `recipients`.
- `send()` for a group reply uses the group id, not the phone number, as the
  recipient.
- No `edit` method is exposed on the transport (`expect(transport.edit).toBeUndefined()`).

`tests/channels/config.test.ts` (or wherever `loadChannelConfig` is currently
tested) gains cases for the Signal-specific field resolution: `apiUrl` and
`phoneNumber` from env vars, `phoneNumber` from `channels.json`'s `token`-role
field, and the "no apiUrl" / "no phoneNumber" error messages.

`docs/superpowers/specs` and `README.md`'s channel table get a Signal row once
implementation lands — not part of this spec's code changes, but worth noting
so it isn't forgotten at review time.

## Out of scope

- Attachments, voice notes, reactions. `IncomingMessage` is text-only across
  every existing channel; Signal follows that until a later pass adds
  attachment support everywhere at once, rather than making Signal the first
  and only channel with it.
- Managing the signal-cli-rest-api process (starting it, health-checking it
  beyond `connect()`, Docker Compose scaffolding). Out of robin's job the same
  way a Telegram bot token's issuance is.
- The `signal-cli daemon --json-rpc` path. Noted above as the rejected
  alternative; revisit only if the REST wrapper proves to have a real
  limitation (e.g. attachment support) that matters later.
- WhatsApp. Separate spec — needs a public webhook design decision the
  gateway's loopback-only HTTP server doesn't have today.
