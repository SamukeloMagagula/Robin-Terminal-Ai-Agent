/**
 * Decides whether a shell command only *observes* the machine, in which case
 * Robin runs it without stopping to ask.
 *
 * The bar here is deliberately high. This is an allowlist, not a blocklist:
 * anything not positively recognised as read-only falls through to a
 * confirmation prompt. A false negative costs one keypress; a false positive
 * runs something destructive without consent, so every rule below errs toward
 * asking.
 */

// Anything that chains, pipes, redirects or substitutes lets a second command
// ride along behind an innocent-looking first one ("ls -la; rm -rf ~"), so a
// command containing any of these is never auto-approved regardless of its verb.
export const SHELL_CONTROL_PATTERN = /[;&|><`\n\r]|\$\(|\$\{/;

/** Commands that cannot modify anything, given the argument rules below. */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'dir',
  'pwd',
  'cd',
  'cat',
  'type',
  'head',
  'tail',
  'wc',
  'nl',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'whoami',
  'hostname',
  'uname',
  'date',
  'basename',
  'dirname',
  'realpath',
  'which',
  'where',
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'findstr',
  'rg',
  'diff',
  'cmp',
  'sort',
  'uniq',
  // Deliberately absent: `env`, which runs an arbitrary command when given one
  // ("env FOO=1 rm -rf /"). `printenv` only prints.
  'printenv',
]);

/** `git <sub>` is read-only only for these subcommands. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'tag',
  'blame',
  'shortlog',
  'describe',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'rev-parse',
  'rev-list',
  'cat-file',
  'config',
  'whatchanged',
  'reflog',
]);

/**
 * Flags that flip one of the readers above into a writer or an executor:
 * `find -exec`/`-delete`, `rg --pre`, `sort -o`, `git diff --output`.
 */
export const EXECUTING_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprintf',
  '-fls',
  '--pre',
  '--hostname-bin',
  '-o',
  '--output',
]);

export function splitTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * The name half of a flag token, lowercased: `--output=/etc/x` -> `--output`.
 *
 * Long flags take their value either as the next token or after an `=`, and a
 * set membership test against the raw token only ever catches the first form.
 * `rg --pre=sh` runs sh as a preprocessor, and `git diff --output=…` writes a
 * file — both were reaching the read-only allowlist intact.
 */
export function flagName(token: string): string {
  return token.split('=')[0].toLowerCase();
}

function isGitReadOnly(tokens: string[]): boolean {
  // Skip global flags like `git -C /some/dir status`.
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    // `-C <path>` and `-c <name>=<value>` take a value; skip it too.
    if (tokens[i] === '-C' || tokens[i] === '-c') i += 2;
    else i += 1;
  }
  const sub = tokens[i];
  if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
  // `git config key value` writes; `git config --get key` and bare reads do not.
  if (sub === 'config') {
    const rest = tokens.slice(i + 1).filter((t) => !t.startsWith('-'));
    if (rest.length > 1) return false;
    if (tokens.includes('--unset') || tokens.includes('--add') || tokens.includes('--replace-all')) {
      return false;
    }
  }
  return true;
}

export function isReadOnlyCommand(command: string): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_CONTROL_PATTERN.test(trimmed)) return false;

  const tokens = splitTokens(trimmed);
  if (tokens.some((token) => EXECUTING_FLAGS.has(flagName(token)))) return false;

  const head = tokens[0].toLowerCase();

  if (head === 'git') return isGitReadOnly(tokens);

  // `find` is read-only only once -exec/-delete are ruled out, which the
  // EXECUTING_FLAGS check above already did.
  if (head === 'find') return true;

  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    const sub = tokens[1]?.toLowerCase();
    return sub === 'ls' || sub === 'list' || sub === 'view' || sub === 'outdated';
  }

  // A bare `--version` / `-v` probe is harmless whatever the binary is.
  if (tokens.length === 2 && /^(--version|-v|--help|-h)$/i.test(tokens[1])) return true;

  return READ_ONLY_COMMANDS.has(head);
}
