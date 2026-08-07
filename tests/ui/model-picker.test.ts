import { describe, it, expect } from 'vitest';
import { filterChoices, toChoices, SEARCH_THRESHOLD } from '../../src/ui/model-picker';

const models = toChoices([
  'gpt-4o',
  'gpt-4o-mini',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4.5',
  'gemini-3.5-flash',
  'anthropic/claude-3.5-sonnet',
]);

describe('filterChoices', () => {
  it('returns everything for an empty term', () => {
    expect(filterChoices(models, '')).toHaveLength(models.length);
    expect(filterChoices(models, '   ')).toHaveLength(models.length);
  });

  it('matches a substring', () => {
    expect(filterChoices(models, 'opus').map((c) => c.value)).toEqual(['claude-opus-5']);
  });

  it('is case-insensitive', () => {
    expect(filterChoices(models, 'GPT-4O').map((c) => c.value)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  // Typing "claude son" should not require remembering the exact id order.
  it('matches every term regardless of the order typed', () => {
    expect(filterChoices(models, 'claude son').map((c) => c.value)).toEqual([
      'claude-sonnet-5',
      'anthropic/claude-3.5-sonnet',
    ]);
    expect(filterChoices(models, 'son claude').map((c) => c.value)).toEqual([
      'claude-sonnet-5',
      'anthropic/claude-3.5-sonnet',
    ]);
  });

  it('returns nothing when a term matches nothing', () => {
    expect(filterChoices(models, 'claude nonexistent')).toEqual([]);
  });

  it('matches against the display name as well as the value', () => {
    const pinned = [{ name: '← Back to provider list', value: '__back__' }];
    expect(filterChoices(pinned, 'back').map((c) => c.value)).toEqual(['__back__']);
  });

  it('preserves input order', () => {
    expect(filterChoices(models, 'claude').map((c) => c.value)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4.5',
      'anthropic/claude-3.5-sonnet',
    ]);
  });

  it('does not mutate the array it is given', () => {
    const original = [...models];
    filterChoices(models, 'gpt');
    expect(models).toEqual(original);
  });
});

describe('toChoices', () => {
  it('uses the id as both label and value', () => {
    expect(toChoices(['a', 'b'])).toEqual([
      { name: 'a', value: 'a' },
      { name: 'b', value: 'b' },
    ]);
  });

  it('handles an empty list', () => {
    expect(toChoices([])).toEqual([]);
  });
});

describe('SEARCH_THRESHOLD', () => {
  // Copilot returns ~49 models and OpenRouter 300+; both must land in the
  // searchable path, while a handful of Ollama models stays a plain list.
  it('sits between a handful and a real catalogue', () => {
    expect(SEARCH_THRESHOLD).toBeGreaterThan(5);
    expect(SEARCH_THRESHOLD).toBeLessThan(49);
  });
});
