/**
 * The official MCP Registry — a real, queryable index of servers, unlike the
 * skill catalogue's fixed list of curated repositories
 * (src/skills/catalogue.ts). Anyone can publish here, which is why
 * mcp-command.ts's install confirmation says so in plainer terms than the
 * skill catalogue's does: a server is an executable Robin will run with the
 * operator's full permissions, not text reviewed once and left in a prompt.
 */

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const SEARCH_LIMIT = 20;

export interface EnvironmentVariable {
  name: string;
  description: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version: string;
  runtimeHint?: string;
  runtimeArguments?: { value: string }[];
  environmentVariables?: EnvironmentVariable[];
}

export interface RegistryServer {
  name: string;
  description: string;
  version: string;
  packages: RegistryPackage[];
  /** Present only to detect "no packages, HTTP/SSE only" — never installable. */
  remotes?: unknown[];
}

export async function searchRegistry(
  term: string,
  fetchImpl: typeof fetch = fetch
): Promise<RegistryServer[]> {
  const url = `${REGISTRY_URL}?search=${encodeURIComponent(term)}&limit=${SEARCH_LIMIT}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Could not search the MCP registry: HTTP ${res.status}.`);
  }
  const body = (await res.json()) as { servers?: RegistryServer[] };
  return body.servers ?? [];
}

/**
 * The one package Robin could actually run — stdio only, one command. Tries
 * each package in order and returns the first commandFor() does not refuse,
 * so "installable" always means "a command was really derived," never a
 * guess. undefined when nothing maps, including a remotes-only server.
 */
export function installablePackage(server: RegistryServer): RegistryPackage | undefined {
  for (const pkg of server.packages) {
    try {
      commandFor(pkg);
      return pkg;
    } catch {
      // Try the next package, if there is one.
    }
  }
  return undefined;
}

const DEFAULT_RUNTIME: Record<string, string> = {
  npm: 'npx',
  pypi: 'uvx',
  docker: 'docker',
};

function packageArg(pkg: RegistryPackage): string {
  switch (pkg.registryType) {
    case 'npm':
      return pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
    case 'pypi':
      return pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
    case 'docker':
      return `${pkg.identifier}:${pkg.version || 'latest'}`;
    default:
      return pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  }
}

/**
 * Only simple positional runtimeArguments are honoured — a package needing
 * named or templated arguments (a real possibility the full registry schema
 * allows) throws here rather than being mapped incorrectly, which is what
 * makes installablePackage's "first package that doesn't throw" rule safe.
 */
export function commandFor(pkg: RegistryPackage): { command: string; args: string[] } {
  const command = pkg.runtimeHint || DEFAULT_RUNTIME[pkg.registryType];
  if (!command) {
    throw new Error(`No known way to run a "${pkg.registryType}" package.`);
  }

  const baseArgs = pkg.runtimeArguments?.map((a) => a.value) ?? [];
  if (pkg.registryType === 'docker') {
    return { command, args: ['run', '--rm', '-i', ...baseArgs, packageArg(pkg)] };
  }
  return { command, args: [...baseArgs, packageArg(pkg)] };
}
