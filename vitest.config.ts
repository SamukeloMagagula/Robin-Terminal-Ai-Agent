import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Git worktrees live under .claude/worktrees/ and contain a full copy of
    // tests/. Vitest's default excludes do not cover it, so a run with a
    // worktree open collected every test twice — 1040 instead of 520 — and
    // would have gone on reporting green against a stale copy once the
    // worktree diverged from the branch under test.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
});
