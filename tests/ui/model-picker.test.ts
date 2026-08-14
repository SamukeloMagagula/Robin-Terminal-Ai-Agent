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

describe('toChoices with path-shaped model ids', () => {
  // llama.cpp reports the file it is serving as the model id, so the picker
  // was offering 90 characters of Windows path and content hash.
  it('shows the file name for a model id that is a path', () => {
    const id =
      'C:/Users/sam/.ollama/models/blobs/sha256-667b0c1932bc6ffc593ed1d03f895bf2dc8dc6df21db3042284a6f4416b06a29';
    const [choice] = toChoices([id]);

    expect(choice.name).not.toContain('C:/Users');
    expect(choice.name.length).toBeLessThan(40);
    // The value has to stay exact — it is what gets sent back as `model`.
    expect(choice.value).toBe(id);
  });

  it('shows a readable name for a gguf path', () => {
    const [choice] = toChoices(['/home/sam/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf']);
    expect(choice.name).toBe('qwen2.5-coder-7b-instruct-q4_k_m');
  });

  it('leaves an ordinary model id completely alone', () => {
    expect(toChoices(['anthropic/claude-sonnet-5'])).toEqual([
      { name: 'anthropic/claude-sonnet-5', value: 'anthropic/claude-sonnet-5' },
    ]);
  });

  it('leaves a bare name alone', () => {
    expect(toChoices(['gpt-4o'])).toEqual([{ name: 'gpt-4o', value: 'gpt-4o' }]);
  });

  // Still findable by typing the hash, because the value is searched too.
  it('keeps the full id searchable', () => {
    const id = 'C:/models/sha256-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    expect(filterChoices(toChoices([id]), 'abcdef')).toHaveLength(1);
  });
});
