# Robin Security Policy

This document states Robin's trust model plainly, including what its
in-process controls do **not** do. Read §2 before filing a security report.

## 1. Reporting

Open a GitHub issue, or contact the maintainer directly for anything you
believe should not be public first. Robin is a personal project and does not
operate a bug bounty.

A useful report names the file and line range, the version or commit, your OS
and Node version, a reproduction, and which boundary in §2 you believe is
crossed.

## 2. Trust model

Robin is a single-user personal CLI. It runs as you, on your machine, with
your permissions.

### 2.1 There is no isolation boundary

**Robin has no sandbox.** Every command approved through `run_command`
executes as a direct child of the Robin process, with your user account's full
access to the filesystem, network, and any credential the environment already
holds. Every file `write_file` touches is written with your permissions.

There is no container, no separate user, no syscall filter, no network policy.
If you approve a destructive command, it is destructive. If a model is
successfully manipulated into proposing one and you approve it without reading
it, the result is the same as if you had typed it yourself.

This is the honest statement of the boundary: **the boundary is you reading the
prompt.**

### 2.2 What the in-process controls actually are

Robin has several mechanisms that reduce risk. None of them is containment.
Each operates on a string the model produced, and a sufficiently motivated
adversarial model — or content that has manipulated one — is operating on the
same string.

| Mechanism | What it actually does | What it is not |
|---|---|---|
| Approval prompt | Puts a human in the loop before a write or a non-read-only command | Not a filter. It shows you the command; it does not evaluate it |
| Destructive-pattern regex (`rm -rf`, `sudo`, `curl \| bash`, …) | Adds a `⚠` so you look twice | Not a block, and trivially evaded — `rm -r -f`, `$(echo rm) -rf`, or any encoding defeats it |
| Read-only command allowlist | Suppresses prompts for recognised readers, and refuses to auto-approve anything containing shell control characters | Not a sandbox. It decides whether to *ask*, not whether the command may run |
| Protected credential paths | Blocks the file tools from `~/.ssh`, `~/.aws`, `.env`, `id_rsa`, and similar, resolving symlinks first | Not a barrier to `run_command`, which can read those files if you approve it |
| Untrusted-content wrapping | Marks file contents and command output as data, not instructions, narrowing prompt injection | Not a guarantee. It is a prompt-level convention the model may still be talked out of |
| Session approval memory (`a`) | Remembers your decision per action-kind for the session | Explicitly widens the gate. It is a convenience you opt into, and it lasts until restart |

If you find a way to defeat one of these heuristics, that is a useful bug
report and worth fixing — but it is not a boundary crossing, because none of
them is a boundary.

### 2.3 Credentials

Provider tokens and API keys are stored in plaintext at `~/.robin/auth.json`,
the same approach the GitHub CLI and `npm login` use. The file is written
`0600` and the directory `0700` on POSIX, re-applied on every write so an
existing file with looser permissions is tightened rather than left alone. On
Windows this relies on normal NTFS profile permissions, since POSIX mode bits
are not meaningful there.

Anything with access to your user account can read that file. Robin does not
attempt to defend against local attackers who already have your account.

### 2.4 Conversation transcripts

Every conversation is written to `~/.robin/chats/` (`0600`/`0700`). These
contain the full conversation **and the contents of any file the model read**,
so treat them as sensitive. `/recall` searches them and re-injects excerpts
into a live conversation, wrapped as untrusted content.

## 3. Reducing your exposure

Since there is no in-process boundary, meaningful risk reduction is
operational:

- **Run Robin inside a container or VM** when working with anything you did
  not write, and mount only the directory you are working in.
- **Launch it from the project directory you intend it to work in.** Reads
  outside the working directory prompt for a reason; reads inside it do not.
- **Be more careful with `a` (approve for the session)** than with `y`. It is
  the one control that removes the human from the loop.
- **Prefer a dedicated OS user** for agent work if you handle credentials the
  agent has no business seeing.
- **Read the command, not the shape of the prompt.** Approval fatigue is the
  realistic attack path, which is why read-only commands no longer prompt at
  all.

## 4. Out of scope

- Attacks requiring existing access to your OS user account.
- Demonstrations that an in-process heuristic in §2.2 can be evaded. Welcome as
  ordinary issues or pull requests; they are not boundary crossings.
- The absence of a sandbox. It is documented above, not an oversight.
- Anything a user explicitly approved at the prompt.
