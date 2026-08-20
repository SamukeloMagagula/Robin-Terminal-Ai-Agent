# WhatsApp channel

Date: 2026-08-20

## Goal

Add WhatsApp as a remote-control channel, alongside Telegram, Discord, Slack
and Signal: message the bot on WhatsApp, robin answers.

## Why this shape

WhatsApp's only viable integration today is Meta's **Business Cloud API**
(the on-premise API is deprecated). Unlike every other channel robin talks
to, it has **no polling mode at all** — Meta pushes messages to a webhook URL
the operator registers, over HTTPS, with no fallback. Every other transport
in this codebase connects *outward* (long-poll, gateway websocket, Socket
Mode) specifically so it needs no public address; WhatsApp is the first one
that structurally cannot work that way.

`ChannelTransport.receive()` only requires "deliver messages to `handler`
until `signal` aborts" — it doesn't require polling. A transport that starts
its own small HTTP server on `receive()` and resolves when `signal` aborts
(closing that server) satisfies the interface exactly as well as a poll loop
does. So `WhatsAppTransport` owns a dedicated listener, separate from the
gateway's own HTTP server.

That separation is deliberate, not incidental. The gateway's HTTP server
(`src/gateway/server.ts`) binds `127.0.0.1` only — it speaks the sessions/
approvals control protocol, and README documents that loopback binding as a
security boundary. Extending it to also serve a public webhook would mean
that server gaining a code path that can be told to bind publicly, which is a
bigger blast radius to get wrong than a second, single-purpose listener with
nothing else riding on it. The webhook listener binds `0.0.0.0` by default
(port from config) — the operator is already making a public-reachability
decision by registering a webhook URL with Meta at all, whether that's a
reverse proxy, a cloud load balancer, or a tunnel like ngrok/cloudflared;
robin's job is to listen somewhere reachable, not to decide how it becomes
reachable.

## Config

New fields on `ChannelConfig` (`src/channels/config.ts`):

```ts
export interface ChannelConfig {
  token: string;              // WhatsApp: the Cloud API access token
  appToken?: string;
  apiUrl?: string;
  phoneNumber?: string;
  /** Meta's numeric id for the sending number. WhatsApp only. */
  phoneNumberId?: string;
  /** Arbitrary string the operator picks, echoed back during the one-time
   *  webhook-verification handshake. WhatsApp only. */
  verifyToken?: string;
  /** Verifies X-Hub-Signature-256 on every inbound POST. WhatsApp only,
   *  and not optional in practice — without it the webhook accepts a
   *  message from anyone who finds the URL. */
  appSecret?: string;
  /** Port the webhook listener binds. WhatsApp only. */
  webhookPort?: number;
  allow: string[];
  provider?: string;
  model?: string;
}
```

Unlike Signal, WhatsApp's `token` field is used exactly as every other
channel uses it (the Cloud API access token), so `loadChannelConfig`'s
existing generic token check applies unchanged. Only the four new fields need
their own resolution, following the Signal precedent of a per-channel branch
rather than generic plumbing for fields only one channel has:

- `phoneNumberId` — `WHATSAPP_PHONE_NUMBER_ID` env var, or `phoneNumberId` in
  `channels.json`. Required.
- `verifyToken` — `WHATSAPP_VERIFY_TOKEN`, or `verifyToken` in the file.
  Required.
- `appSecret` — `WHATSAPP_APP_SECRET`, or `appSecret` in the file. Required.
- `webhookPort` — `WHATSAPP_WEBHOOK_PORT`, or `webhookPort` in the file.
  Required (no default port — a hardcoded default invites two operators onto
  the same port with no error until the second one's bind silently picks a
  different port or fails, and Meta's webhook URL has to name the real one
  anyway).

Each missing field throws its own `UserFacingError` naming the field, the env
var, and the file key — matching every existing error in `config.ts`.

`EXAMPLE_CONFIG` gains a `whatsapp` block:

```json
"whatsapp": {
  "token": "your-cloud-api-access-token",
  "phoneNumberId": "109876543210987",
  "verifyToken": "any-string-you-pick",
  "appSecret": "your-meta-app-secret",
  "webhookPort": 8443,
  "allow": ["15551234567"]
}
```

## Transport

New file `src/channels/whatsapp.ts`.

```ts
export interface WhatsAppOptions {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
  webhookPort: number;
  /** Interface to bind. Defaults to '0.0.0.0'. Overridable for tests. */
  bindHost?: string;
  fetchImpl?: typeof fetch;
}

export class WhatsAppTransport implements ChannelTransport {
  readonly id = 'whatsapp';
  readonly name = 'WhatsApp';
  // ...
}
```

**`connect()`** — `GET https://graph.facebook.com/v21.0/{phoneNumberId}` with
bearer `token`. A non-2xx throws with Meta's error detail. Returns
`{ identity: display_phone_number }` from the response body.

**`receive()`** — starts `http.createServer` on `bindHost:webhookPort`,
resolves once `signal` aborts (closing the server first). Handles two request
shapes:

1. **`GET` — verification handshake.** Meta sends this once per webhook URL
   registration, and may resend it any time the subscription is re-verified
   from the developer console. Query params: `hub.mode`, `hub.verify_token`,
   `hub.challenge`. When `hub.mode === 'subscribe'` and `hub.verify_token ===
   verifyToken`: respond `200` with the raw `hub.challenge` string as the
   body. Otherwise `403`.

2. **`POST` — inbound message.** Read the raw body first (needed for
   signature verification — parsing to JSON before checking the signature
   would mean trusting the shape of unverified data). Compute HMAC-SHA256 of
   the raw body using `appSecret`, compare against the `X-Hub-Signature-256`
   header (constant-time compare). Mismatch → `401`, `handler` is never
   called. Match → `200` immediately (Meta expects a fast ack and retries on
   timeout), then parse and walk
   `entry[].changes[].value.messages[]`.

   Each message with `type === 'text'` maps to `IncomingMessage`:
   `chatId = senderId = message.from` (the sender's WhatsApp id — WhatsApp
   Cloud API has no group-chat concept exposed here, unlike Signal, so there
   is only ever one address to reply to), `text = message.text.body`,
   `senderName` read from the matching entry in the same payload's
   `contacts[].profile.name` (matched by `wa_id === message.from`). A message
   with any other `type` (image, location, reaction, …) is dropped, same as
   Telegram drops updates with no text and Signal drops envelopes with no
   `dataMessage.message`.

   Handler errors are caught and logged, not allowed to affect the already-sent
   `200` — Meta doesn't need to know a downstream handler failed; retrying
   would just re-deliver the same message.

**`send()`** — `POST https://graph.facebook.com/v21.0/{phoneNumberId}/messages`,
bearer `token`, body `{ messaging_product: 'whatsapp', to: chatId, text: { body: chunk } }`
per chunk. Reuses `chunkMessage` exported from `telegram.ts` (already generic
over the limit parameter — no reason to fork it) at a ~4096-char limit,
matching Cloud API's documented text message cap. Returns the first chunk's
message id from the response body's `messages[0].id`.

**`edit()`** — not implemented. Cloud API has no message-edit endpoint, same
as Signal.

## Registry and CLI wiring

`src/channels/registry.ts`: the `whatsapp` entry currently only has `pending`.
Add `build`, following the Signal entry's shape — construct from the widened
config, throw `UserFacingError` if any required field is missing (defensive;
`loadChannelConfig` already guarantees them, same redundancy the Signal entry
has today).

`CHANNELS`'s `build` config type widens again to carry `phoneNumberId?`,
`verifyToken?`, `appSecret?`, `webhookPort?`.

`serve-command.ts` and `schedule/deliver.ts`'s two `build()` call sites (both
already widened once for Signal) widen again to pass the four new fields
through.

## Testing

New `tests/channels/whatsapp.test.ts`:

- `connect()` returns `display_phone_number` as identity on success; throws
  with Meta's error detail on failure — same shape as Telegram/Signal tests,
  injected `fetchImpl`.
- **Webhook verification:** a real `http.request` to the running listener
  with correct `hub.verify_token` gets `200` and the exact `hub.challenge`
  echoed back; wrong token gets `403`.
- **Signature verification:** a real HTTP `POST` with a correctly computed
  `X-Hub-Signature-256` and a text message is accepted, reaches `handler`,
  and gets `200`; a POST with a wrong/missing signature gets `401` and
  `handler` is never called.
- Maps a text message to `IncomingMessage` with `chatId === senderId ===
  message.from`, `senderName` from the matched `contacts` entry.
- Drops a non-text message type (e.g. `type: 'image'`).
- `receive()` closes the listener and resolves when `signal` aborts — a
  request after abort fails to connect.
- `send()` posts the expected body per chunk and returns the first chunk's
  message id.
- No `edit` method is exposed on the transport.

These drive the listener with real HTTP requests against `127.0.0.1:{ephemeral
port}` (`bindHost: '127.0.0.1'`, `webhookPort: 0` letting the OS assign a free
port, read back from the server once listening) rather than mocking
`http.createServer` — the signature-verification and routing logic is exactly
the part worth testing for real.

`tests/channels/config.test.ts` gains cases for the four new field
resolutions and their "missing" error messages, mirroring the Signal cases
already there.

## Out of scope

- **Attachments, media messages, reactions, interactive replies (buttons/
  lists).** Same reasoning as Signal: every existing channel's
  `IncomingMessage` is text-only; WhatsApp follows that until a later pass
  adds attachment support everywhere at once.
- **The 24-hour customer-service window.** Cloud API only allows free-form
  text replies within 24 hours of the user's last message; outside that
  window, only a pre-approved message *template* can be sent, which needs
  template creation and Meta review — a different feature entirely. This
  spec's `send()` assumes a free-form reply is valid, which is true for the
  common case (answering a message that just arrived) and will simply fail
  with Meta's own error otherwise. Worth documenting as a known limitation at
  implementation time, not solving here.
- **Multi-number accounts, business profile management, message status
  webhooks (`delivered`/`read` receipts).** Not needed for the reply loop.
- **Automating webhook registration or app-secret rotation.** The operator
  configures the webhook URL and generates the app secret in Meta's developer
  console themselves, the same way a Telegram bot token or a Slack app-level
  token is issued outside robin's control.
