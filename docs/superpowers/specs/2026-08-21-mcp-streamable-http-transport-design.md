# MCP Streamable-HTTP transport

Date: 2026-08-21

## Goal

Let Robin connect to a remote MCP server over Streamable-HTTP, not just a
local subprocess over stdio. Closes the gap the README already names ("Not
supported yet: the Streamable-HTTP transport") and unlocks a real share of
`robin mcp search` results, which today report "not installable" whenever a
registry server offers only `remotes`, no `packages`.

## Why this shape

**The SDK already has it — nothing new to add as a dependency.**
`@modelcontextprotocol/sdk` (already at 1.30.0 in `package.json`) ships
`StreamableHTTPClientTransport` at
`@modelcontextprotocol/sdk/client/streamableHttp.js`, alongside the
`StdioClientTransport` `McpConnection` already uses. Its constructor is
`new StreamableHTTPClientTransport(url: URL, { requestInit? })` —
`requestInit.headers` is exactly where a static auth header goes.

**One config shape, not a fork.** `McpServerConfig` gains `url?: string` and
`headers?: Record<string, string>`; `command` becomes optional. A valid
entry needs *exactly one* of `command` or `url` — an entry with neither is
already skipped today (no `command`), and an entry with both is ambiguous
and gets the same treatment, rather than picking one silently. Everything
above the transport — the `server__tool` namespacing, wrapping tool results
as untrusted content, the per-tool-call approval gate — is already
transport-agnostic, so none of it changes.

**The confirmation has to say which risk shape it is.** `robin mcp` (and
the new `robin mcp add`) currently say "wants to run: `<command>`" — that
sentence is a lie for a remote entry, which runs nothing locally at all. A
remote server is a network request plus whatever tools it advertises, each
still individually gated the same as any MCP tool call; a local server is
arbitrary code execution with the operator's full permissions. Different
blast radius, different sentence: "wants to connect to: `<url>`" for a
remote entry.

**Real registry data changed two decisions mid-design**, the same way live
testing already corrected the MCP catalogue spec once:

- A server can list both `sse` and `streamable-http` remotes for the same
  endpoint (Notion, Linear, and others do). Only `streamable-http` is
  handled — `sse` is the transport this one is superseding, not a second
  one to also support.
- Some remote URLs carry unresolved placeholders —
  `https://nordicmcp.eu/mcp/stripe/{token}`,
  `https://{baseUrl}/mcp`. Substituting into a URL path is a different, more
  dangerous kind of "fill in a value" than a header: get it wrong and the
  request can go to the wrong host entirely, not just carry a bad
  credential. A templated URL is reported as not-installable, the same
  posture the MCP catalogue spec already takes for a package it can't map
  cleanly, rather than guessed at.

## Config: `src/mcp/config.ts`

```ts
export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Presence means this entry connects over Streamable-HTTP, not stdio. */
  url?: string;
  /** Static auth headers for a remote entry. Never meaningful with command. */
  headers?: Record<string, string>;
}
```

`loadMcpConfig`'s per-entry validation: an entry is kept when it has exactly
one of a non-empty `command` string or a non-empty `url` string; neither or
both is skipped, the same "one bad entry is skipped, not the whole file"
tolerance the rest of that function already has. `url` is parsed with `new
URL(...)` at load time too — an unparseable URL is treated the same as a
missing one, so a malformed entry fails at config-read time with a clear
skip rather than surfacing as an opaque SDK error later at connect time.

`serverFingerprint` (`src/mcp/config.ts`): for a remote entry, fingerprints
`url` and `Object.keys(headers ?? {}).sort()` — headers contribute keys
only, the exact reasoning `env` already gets ("a rotated token must not
re-prompt. A new key still changes the fingerprint, because that changes
what the server can reach"). For a local entry, unchanged.

## Connection: `src/mcp/client.ts`

```ts
async connect(): Promise<void> {
  const transport = this.config.url
    ? new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers: this.config.headers },
      })
    : new StdioClientTransport({ /* unchanged */ });

  const client = new Client({ name: 'robin', version: robinVersion() }, { capabilities: {} });
  await withTimeout(client.connect(transport), this.startupTimeoutMs, /* unchanged message shape */);
  this.client = client;
}
```

`listTools`/`callTool`/`close` are already transport-agnostic (they call
methods on `Client`, which does not know or care which `Transport`
implementation it holds) — no changes there.

## Approval wording: `src/commands/mcp-command.ts`

`runMcp`'s per-server block currently builds `command = [server.command,
...(server.args ?? [])].join(' ')` and always prints "wants to run:".
Branches on `server.url`:

- Local (`command` set): unchanged — "wants to run:" + the command box.
- Remote (`url` set): "wants to connect to:" + a box containing the URL
  (and, if `headers` is non-empty, a line naming which header *keys* will
  be sent — never values, matching the fingerprint's own key-only
  treatment).

`serverFingerprint` already produces a distinct fingerprint per transport
kind (a `command` fingerprint and a `url` fingerprint can never collide,
since they fingerprint disjoint field sets), so trust recording
(`trustStore.trustContent`/`trustKey`) needs no changes.

## Catalogue: `src/mcp/catalogue.ts`

```ts
export interface RegistryRemote {
  type: string; // 'streamable-http' | 'sse' | ...
  url: string;
  headers?: EnvironmentVariable[]; // same shape as a package's environmentVariables
}
```

(`RegistryServer.remotes` narrows from `unknown[]` to `RegistryRemote[]`
now that this spec gives the shape a use.)

```ts
/** The one remote Robin could actually connect to — Streamable-HTTP, with
 *  no unresolved {placeholder} in its URL. undefined when nothing qualifies,
 *  including every legacy sse-only remote. */
export function installableRemote(server: RegistryServer): RegistryRemote | undefined {
  return server.remotes?.find(
    (r) => r.type === 'streamable-http' && !/\{[^}]+\}/.test(r.url)
  );
}
```

`src/commands/mcp-command.ts`'s `runMcpSearch`/`runMcpAdd`: try
`installablePackage(server)` first — a local install is faster, more
capable, and never sends headers over a network — and fall back to
`installableRemote(server)` only when no package qualifies. `runMcpSearch`
prints the mapped command for a package, or `GET <url>` for a remote, or
"not installable" with a reason when neither qualifies (now including "only
offers a templated URL" and "only offers the legacy sse transport" as
specific reasons, alongside the existing "packages shape not mapped").
`runMcpAdd` prompts for each `isRequired` header exactly the way it already
prompts for required env vars (masked via `password` when `isSecret`),
builds `{ name, url, headers }` instead of `{ name, command, args, env }`,
and shows the "wants to connect to:" wording from above before confirming.

## Out of scope

- **OAuth (`StreamableHTTPClientTransportOptions.authProvider`).** A much
  bigger feature on its own — browser redirect, authorization-code
  exchange, token storage and refresh. Static headers cover every registry
  example seen during design (a bearer token, a signed payment header);
  OAuth is a separate spec if a real server that needs it comes up.
- **The legacy SSE transport.** Streamable-HTTP is what it was superseded
  by; a server offering only `sse` is not installable via the catalogue,
  though a hand-written `mcp.json` entry pointing `command` at a local
  SSE-to-stdio bridge already works today, unchanged.
- **Templated/parameterized remote URLs.**
- **Reconnection tuning
  (`StreamableHTTPReconnectionOptions`).** The SDK's defaults (30s max
  backoff, 2 retries) are used as-is; nothing here is exposed as a setting.
- **`resumeStream`/resumption tokens.** Not needed for the request/response
  and tool-call shapes Robin's own MCP usage exercises today.

## Testing

- `tests/mcp/config.test.ts` gains cases: an entry with only `url` is kept;
  an entry with neither `command` nor `url` is skipped (already covered,
  re-asserted for clarity); an entry with both is skipped; an entry with an
  unparseable `url` is skipped; `serverFingerprint` on a `url`+`headers`
  entry changes when the URL changes, is stable for the same entry, ignores
  header values, and still changes when a new header key appears —
  mirroring every existing `env`-fingerprint case exactly.
- `tests/mcp/client.test.ts` gains a case connecting `McpConnection` to a
  real local HTTP server speaking the Streamable-HTTP MCP protocol (the SDK
  ships a server-side `StreamableHTTPServerTransport` usable in a test
  fixture, the same "drive it for real, don't mock the SDK's own protocol
  handling" choice `tests/mcp/client.test.ts` already makes for stdio) —
  connects, lists a tool, calls it. A second case asserts the configured
  `headers` are actually sent (inspecting the request the test server
  received).
- `tests/mcp/catalogue.test.ts` gains cases for `installableRemote`: picks
  a `streamable-http` entry over a co-listed `sse` one; skips a URL with a
  `{placeholder}`; returns `undefined` when only `sse` or only templated
  URLs are offered.
- `tests/commands/mcp-command.test.ts` gains cases: `runMcpSearch` shows
  `GET <url>` for a remote-only installable result, and the specific
  not-installable reason for a templated-URL-only or sse-only result;
  `runMcpAdd` prefers a package over a remote when a server offers both.
