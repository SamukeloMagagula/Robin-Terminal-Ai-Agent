export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * A deliberately small frontmatter reader: `key: value` lines between `---`
 * fences.
 *
 * Memories and skills are written by Robin and hand-edited by the user, so the
 * shapes stay flat. A full YAML parser would be a dependency bought for
 * nothing — and one more thing that can execute during a read.
 *
 * Returns undefined when the fences are missing, which callers treat as "skip
 * this file" rather than as an error.
 */
/**
 * Removes quotes that are YAML's, not the author's.
 *
 * Robin writes values bare, but skills published by Hermes and OpenClaw quote
 * theirs — and the quotes were surviving into the skills index the model reads
 * on every turn.
 */
function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  return value;
}

export function parseFrontmatter(raw: string): Frontmatter | undefined {
  const normalised = raw.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) return undefined;
  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return undefined;

  const fields: Record<string, string> = {};
  for (const line of normalised.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1).trim());
  }
  const body = normalised.slice(end + '\n---'.length).replace(/^\n+/, '').trimEnd();
  return { fields, body };
}

/** Renders frontmatter back out, in the same shape parseFrontmatter reads. */
export function renderFrontmatter(fields: Record<string, string>, body: string): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push('---', '', body, '');
  return lines.join('\n');
}
