export interface CatalogueSource {
  /** owner/repo on GitHub. */
  repo: string;
  branch: string;
  /** Where skills live in that repository. */
  prefix: string;
  /** Shown in listings, so a user knows whose instructions they are taking. */
  description: string;
}

/**
 * The catalogues Robin installs skills from.
 *
 * All three publish the same thing — a directory per skill with a SKILL.md
 * carrying `name` and `description` frontmatter — which is the format Robin's
 * own store already reads. The only differences are which repository they live
 * in and how deep.
 */
export const CATALOGUE_SOURCES: Record<string, CatalogueSource> = {
  anthropic: {
    repo: 'anthropics/skills',
    branch: 'main',
    prefix: 'skills/',
    description: "Anthropic's published Agent Skills",
  },
  openclaw: {
    repo: 'openclaw/openclaw',
    branch: 'main',
    prefix: '.agents/skills/',
    description: 'Skills bundled with OpenClaw',
  },
  hermes: {
    repo: 'Undermybelt/hermes-skills',
    branch: 'main',
    prefix: 'skills/',
    description: 'The Hermes Agent community catalogue',
  },
};

export interface CatalogueEntry {
  /** As named in the catalogue, e.g. "aegis/brainstorming". */
  name: string;
  /** Path within the repository. */
  path: string;
}

function sourceFor(source: string): CatalogueSource {
  const known = CATALOGUE_SOURCES[source];
  if (!known) {
    throw new Error(
      `Unknown skill source "${source}". Available: ${Object.keys(CATALOGUE_SOURCES).join(', ')}.`
    );
  }
  return known;
}

/**
 * Every skill a catalogue offers.
 *
 * One request: GitHub returns the whole tree, and filtering here beats walking
 * directories over the network.
 */
export async function listCatalogue(
  source: string,
  fetchImpl: typeof fetch = fetch
): Promise<CatalogueEntry[]> {
  const known = sourceFor(source);
  const url = `https://api.github.com/repos/${known.repo}/git/trees/${known.branch}?recursive=1`;

  const res = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'robin' },
  });
  if (!res.ok) {
    throw new Error(
      `Could not list ${known.repo}: ${res.status}. ` +
        'GitHub rate-limits unauthenticated requests to 60 an hour.'
    );
  }

  const body = (await res.json()) as { tree?: { path?: string }[]; truncated?: boolean };
  // A truncated tree would make "not in the catalogue" and "not in the part of
  // the catalogue we saw" the same answer, which is the worse kind of wrong.
  if (body.truncated) {
    throw new Error(`GitHub truncated the listing for ${known.repo}; it is too large to enumerate.`);
  }

  const entries: CatalogueEntry[] = [];
  for (const node of body.tree ?? []) {
    const path = node.path;
    if (!path || !path.startsWith(known.prefix) || !path.endsWith('/SKILL.md')) continue;
    entries.push({
      name: path.slice(known.prefix.length, -'/SKILL.md'.length),
      path,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a catalogue skill is called once installed.
 *
 * The store keys on a directory name, so a nested catalogue name has to
 * flatten. It keeps its source as a prefix because the catalogues overlap —
 * more than one of them publishes a "brainstorming" — and silently overwriting
 * one with another is not a thing a user would expect.
 */
export function localNameFor(source: string, name: string): string {
  return `${source}-${name}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/** The raw SKILL.md, as published. */
export async function fetchSkillBody(
  source: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const known = sourceFor(source);
  // The path comes from a listing, but it reaches a URL — a crafted one must
  // not be able to walk out of the repository.
  if (path.includes('..') || path.startsWith('/')) {
    throw new Error(`Refusing a suspicious catalogue path: ${path}`);
  }

  const url = `https://raw.githubusercontent.com/${known.repo}/${known.branch}/${path}`;
  const res = await fetchImpl(url, { headers: { 'user-agent': 'robin' } });
  if (!res.ok) throw new Error(`Could not fetch ${path} from ${known.repo}: ${res.status}`);
  return res.text();
}
