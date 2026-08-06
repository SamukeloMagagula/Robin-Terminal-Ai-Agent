import { describe, it, expect } from 'vitest';
import { filterSlashCommands, SLASH_COMMANDS } from '../../src/repl/slash-prompt';

describe('filterSlashCommands', () => {
  it('returns nothing when the buffer does not start with "/"', () => {
    expect(filterSlashCommands('hello')).toEqual([]);
  });

  it('returns nothing for an empty buffer', () => {
    expect(filterSlashCommands('')).toEqual([]);
  });

  it('returns every command for a bare "/"', () => {
    expect(filterSlashCommands('/')).toEqual(SLASH_COMMANDS);
  });

  it('filters to commands starting with the typed prefix', () => {
    const matches = filterSlashCommands('/s');
    expect(matches.map((m) => m.name)).toEqual(['/system', '/save', '/skill']);
  });

  it('narrows to a single match as more is typed', () => {
    expect(filterSlashCommands('/sk').map((m) => m.name)).toEqual(['/skill']);
  });

  it('matches case-insensitively', () => {
    expect(filterSlashCommands('/MOD').map((m) => m.name)).toEqual(['/model']);
  });

  it('returns nothing for a slash command with no matches', () => {
    expect(filterSlashCommands('/bogus')).toEqual([]);
  });
});
