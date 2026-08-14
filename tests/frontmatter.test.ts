import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter';

describe('parseFrontmatter and quoted values', () => {
  // Robin writes values bare, but catalogue skills from Hermes and OpenClaw
  // quote theirs — and the quotes were surviving into the skills index the
  // model sees on every turn.
  it('strips double quotes around a value', () => {
    const parsed = parseFrontmatter('---\ndescription: "Use when reviewing"\n---\n\nbody');
    expect(parsed?.fields.description).toBe('Use when reviewing');
  });

  it('strips single quotes around a value', () => {
    const parsed = parseFrontmatter("---\ndescription: 'Use when reviewing'\n---\n\nbody");
    expect(parsed?.fields.description).toBe('Use when reviewing');
  });

  it('leaves an unquoted value alone', () => {
    const parsed = parseFrontmatter('---\ndescription: Use when reviewing\n---\n\nbody');
    expect(parsed?.fields.description).toBe('Use when reviewing');
  });

  it('leaves quotes that are part of the text', () => {
    const parsed = parseFrontmatter('---\ndescription: say "hello" to it\n---\n\nbody');
    expect(parsed?.fields.description).toBe('say "hello" to it');
  });

  it('leaves a lone quote alone', () => {
    const parsed = parseFrontmatter('---\ndescription: "\n---\n\nbody');
    expect(parsed?.fields.description).toBe('"');
  });
});
