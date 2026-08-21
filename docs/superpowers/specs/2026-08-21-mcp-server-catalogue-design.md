# MCP server catalogue

Date: 2026-08-21

## Goal

Let `robin mcp search`/`add`/`remove` install an MCP server from the official
MCP Registry, the way `robin skill search`/`add`/`update` already installs a
skill from a GitHub-hosted catalogue (`src/skills/catalogue.ts`). Today
`~/.robin/mcp.json` is entirely hand-edited; nothing in this codebase writes
to it.

## Why this shape

The skill catalogue's shape — list, show what's about to be installed,
confirm, write, done — is the right shape here too. But two things about MCP
servers make a straight copy of that code wrong:

**The source is a real, queryable registry, not a fixed list of GitHub
repos.** `CATALOGUE_SOURCES` in the skill catalogue is three repositories
Robin's own maintainers curated. MCP servers already have an official,
actively-maintained registry at `registry.modelcontextprotocol.io` — a REST
API, not a directory convention to scan. `GET /v0/servers?search=<term>&limit=<n>`
returns `{ servers: [...], metadata: { nextCursor, count } }`; each server
carries `name`, `description`, `version`, and a `packages` array describing
how to run it (below). This is the actual thing to query, the same reason
`openrouter-usage.ts` calls OpenRouter's real account API instead of
estimating spend — a real answer beats a guessed one whenever a real one is
reachable.

**A server is an executable, not text.** A skill is instructions injected
into a system prompt — reviewed once, then it just sits in context. An MCP
server is a command Robin will run as a subprocess with the operator's full
permissions, exactly the blast radius `run_command` has, and (unlike the
three curated skill sources) the official registry accepts submissions from
*anyone* — there is no curation step between "someone published this" and
"it shows up in `robin mcp search`." The install confirmation says so in
plainer terms than the skill catalogue's does, and installing always ends by
recording trust in the same step (below) rather than leaving a second,
easy-to-forget `robin mcp` pass required before the server can actually run.

## Package → runnable command

A registry server's `packages[]` entries look like (real example, from the
registry):

```json
{
  "registryType": "npm",
  "identifier": "remote-filesystem-mcp-server",
  "version": "0.1.2",
  "runtimeHint": "npx",
  "runtimeArguments": [{ "value": "-y" }],
  "transport": { "type": "stdio" },
  "environmentVariables": [
    { "name": "GCS_BUCKET", "description": "...", "isRequired": true },
    { "name": "GCS_PRIVATE_KEY", "description": "...", "isSecret": true }
  ]
}
```

New file: **`src/mcp/catalogue.ts`**, named to mirror `src/skills/catalogue.ts`
directly — not `src/mcp/registry.ts`, since that name is already taken by
the existing server-connection registry (`McpConnection`/tool wiring).

```ts
export interface RegistryServer {
  name: string;
  description: string;
  version: string;
  packages: RegistryPackage[];
  remotes?: unknown[]; // present only to detect "no packages, HTTP/SSE only"
}

export interface RegistryPackage {
  registryType: 'npm' | 'pypi' | 'docker' | string;
  identifier: string;
  version: string;
  runtimeHint?: string;
  runtimeArguments?: { value: string }[];
  environmentVariables?: {
    name: string;
    description: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
  }[];
}

export async function searchRegistry(
  term: string,
  fetchImpl: typeof fetch = fetch
): Promise<RegistryServer[]>; // GET /v0/servers?search=<term>&limit=20

/**
 * Only the first package Robin can actually run — stdio only, one command.
 * A server offering only `remotes` (HTTP/SSE, no `packages`) has none.
 */
export function installablePackage(server: RegistryServer): RegistryPackage | undefined;

export function commandFor(pkg: RegistryPackage): { command: string; args: string[] };
```

`commandFor` picks the command in this order:

1. `pkg.runtimeHint`, if present (the registry's own recommendation — e.g.
   `"npx"`, `"uvx"`, `"docker"`).
2. Otherwise, by `registryType`: `npm` → `npx`, `pypi` → `uvx`, `docker` →
   `docker`.
3. Anything else → `installablePackage` treats it as not installable (same
   outcome as a `remotes`-only server), rather than guessing at a command for
   a registry type this spec has never seen.

Args: every `runtimeArguments[].value` in order, then the package identifier
— `@version` suffix for npm, `==version` for pypi, `:version` (defaulting to
`:latest` if absent) for docker. Only simple positional `runtimeArguments`
are honoured; a package needing named or templated arguments (a real
possibility the full registry schema allows, not represented in the shape
above) does not map cleanly and is reported as such rather than guessed —
same "not installable" outcome as a `remotes`-only server, surfaced with the
raw package data so the operator can hand-write the `mcp.json` entry
themselves if they want to.

## Env vars: an install-time prompt, not a file edit

The one thing the skill catalogue never needed — skills carry no
credentials. For each `environmentVariables` entry where `isRequired` is
true, `robin mcp add` prompts for a value before showing the final command:
`password` (masked) from `@inquirer/prompts` when `isSecret` is true, `input`
otherwise, pre-filled with `default` when the registry provides one.
Optional variables are not prompted for in v1 — the operator can always add
one to the written `mcp.json` entry afterward exactly as they would today.

## Writing `mcp.json`: `src/mcp/config.ts` gains a write path

Nothing writes to `mcp.json` today — `loadMcpConfig` only reads, failing
closed (empty list) on anything unparseable. A *write* path cannot fail
closed the same way: silently starting from empty would discard whatever the
operator already has there.

```ts
export async function addMcpServer(
  entry: McpServerConfig,
  filePath: string = defaultMcpConfigPath()
): Promise<void>;

export async function removeMcpServer(
  name: string,
  filePath: string = defaultMcpConfigPath()
): Promise<boolean>; // false when no such entry existed
```

`addMcpServer`: reads the existing file if present. A missing file starts
from `{}`. A file that exists but fails to parse as JSON **throws**, naming
the file and telling the operator to fix or remove it first — unlike the
read path, a write must never silently overwrite something that might still
be recoverable by hand. Every other top-level key in the parsed object is
preserved untouched. The new entry is written under `servers` specifically
(`loadMcpConfig`'s documented, collision-winning spelling — see the comment
already in `config.ts`), even when the file currently only has an
`mcpServers` block; a mixed file is valid, since `loadMcpConfig` already
merges both. Directory created with `{ recursive: true, mode: 0o700 }`, file
written with `mode: 0o600`, matching every other credential-adjacent file in
this codebase.

`removeMcpServer` deletes the named key from whichever of `servers`/
`mcpServers` it's found in (an entry added by `robin mcp add` is always
under `servers`, but a hand-written one could be under either), and rewrites
the file. Leaves the trust store alone — a stale trust record for a server
that no longer exists in `mcp.json` is inert and harmless, the same
"nothing to clean up" reasoning already applied elsewhere (a declined skill
install is never recorded either).

## Commands

`src/commands/mcp-command.ts` gains three functions, `src/cli.ts` turns bare
`mcp` into a command group with the existing review behaviour as its default
subcommand (mirroring `config list`'s and `skill list`'s existing
`isDefault: true` pattern):

```bash
robin mcp                    # unchanged: review/approve what's in mcp.json
robin mcp search <term>      # query the registry, show what's installable
robin mcp add <name>         # install by exact name
robin mcp remove <name>      # delete an entry from mcp.json
```

**`runMcpSearch(term)`** — `searchRegistry(term)`, then for each result:
`installablePackage()`. Installable → prints name, description, and the
mapped command (`commandFor`). Not installable → prints name, description,
and why (`remotes`-only, or a `packages` shape this spec doesn't map).
Ends with `Install with \`robin mcp add <name>\`.`, matching
`runSkillList`'s closing line.

**`runMcpAdd(name)`** — finds the exact-name match in `searchRegistry(name)`'s
results (same "search, then require an exact match" shape `runSkillAdd`
already uses against `listCatalogue`'s results); no match or not-installable
→ clear error, nothing written. For each required `environmentVariables`
entry, prompts as described above. Builds the final `McpServerConfig` with
`env` from the collected answers. Shows the exact resulting command in a box
(reusing the `box()` helper `runMcp` already uses) with wording stronger
than the skill catalogue's: the official registry accepts submissions from
anyone, so a name and description are not a review — read the command.
Confirms (`expand`, same `y`/`n` shape as `runSkillAdd`). On yes:
`addMcpServer(entry)`, then `trustStore.trustContent('mcp-server', name,
serverFingerprint(name, entry))` in the same step — the confirmation the
operator just gave *is* the approval, so nothing is left half-installed
requiring a second `robin mcp` pass. Prints the same "take effect" note
`runMcp` already prints (gateway restart needed if one is running).

**`runMcpRemove(name)`** — `removeMcpServer(name)`. Found → confirms removal
succeeded. Not found → says so plainly, not an error (removing something
already gone is a no-op, not a failure).

## Out of scope

- **`robin mcp update`.** A skill's body can improve or regress upstream
  with no version number attached, which is why refreshing it is worth a
  command. A registry package is version-pinned at install time in the
  written `mcp.json` entry — nothing drifts silently, so there is nothing
  for an update command to detect. Reinstalling (`remove` then `add`)
  covers the rare case of wanting a newer version on purpose.
- **Named or templated runtime/package arguments.** The full registry schema
  allows more than the simple positional shape this spec maps; a package
  needing more is reported as not-installable rather than mapped incorrectly.
- **Non-stdio transport.** A `remotes`-only server (streamable-HTTP/SSE) is
  never installable — the same existing limitation the README already states
  for MCP generally ("Not supported yet: the Streamable-HTTP transport
  (stdio only)").
- **Optional environment variables.** Only `isRequired` ones are prompted
  for at install time; anything else is left for the operator to add to the
  written entry afterward, same as any hand-written `mcp.json` entry today.
- **A user-addable registry URL.** This spec is scoped to the one official
  registry; pointing at a self-hosted or third-party registry instance is a
  separate feature if it turns out to be wanted.

## Testing

- `tests/mcp/catalogue.test.ts`: `searchRegistry` sends the expected query
  params and parses `servers`/`metadata`; `installablePackage` picks the
  first package for a `packages`-bearing server, returns `undefined` for a
  `remotes`-only one; `commandFor` prefers `runtimeHint`, falls back to
  `registryType` for npm/pypi/docker, and returns the expected args
  including the version-suffixed identifier for each registry type; a
  package with an unrecognised `registryType` and no `runtimeHint` yields no
  mapping.
- `tests/mcp/config.test.ts` (existing file) gains cases for `addMcpServer`:
  creates a missing file, preserves unrelated top-level keys, writes under
  `servers` even when the file only had `mcpServers`, and throws (without
  writing) when the existing file fails to parse; and for `removeMcpServer`:
  deletes from whichever key the entry is under, returns `false` for a name
  that was never there, leaves the rest of the file untouched.
- `tests/commands/mcp-command.test.ts` (existing file) gains cases for
  `runMcpSearch` (installable vs not, with the reason shown for the latter),
  `runMcpAdd` (prompts only for required variables, secret vs plain input,
  writes and trusts together on confirm, writes nothing on decline, errors
  cleanly on an unknown or non-installable name), and `runMcpRemove` (found
  vs not-found).
