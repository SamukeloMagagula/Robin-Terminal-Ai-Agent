import { select, search } from '@inquirer/prompts';

/**
 * Above this many models an arrow-key list stops being usable — OpenRouter
 * lists 300+ and Copilot 49 — so the picker switches to type-to-filter.
 * Below it, a plain list is faster than typing.
 */
export const SEARCH_THRESHOLD = 20;

export interface PickerChoice {
  name: string;
  value: string;
}

/**
 * Case-insensitive substring match on every whitespace-separated term, so
 * "claude son" finds "claude-sonnet-5" regardless of the order typed.
 */
export function filterChoices(choices: PickerChoice[], term: string): PickerChoice[] {
  const parts = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return choices;
  return choices.filter((choice) => {
    const haystack = `${choice.name} ${choice.value}`.toLowerCase();
    return parts.every((part) => haystack.includes(part));
  });
}

/**
 * Picks one value from `choices`, using a searchable prompt once the list is
 * long enough to be worth filtering.
 *
 * `pinned` entries (e.g. "← Back") always sort first and are matched by the
 * same filter, so they remain reachable without scrolling past 300 models.
 */
export async function pickFromChoices(
  message: string,
  choices: PickerChoice[],
  pinned: PickerChoice[] = []
): Promise<string> {
  const all = [...pinned, ...choices];

  if (all.length <= SEARCH_THRESHOLD) {
    return select({ message, choices: all });
  }

  return search({
    message: `${message} (type to filter)`,
    source: async (term) => filterChoices(all, term ?? ''),
  });
}

/**
 * A readable label for a model id.
 *
 * Servers that load a file report that file as the id: llama.cpp hands back the
 * full path to the weights, which for a model pulled through Ollama is a
 * directory plus a sha256 — ninety characters of nothing anyone can read. Only
 * ids that actually look like paths are shortened, so `anthropic/claude-5` and
 * `openai/gpt-4o` are left exactly as they are.
 *
 * The value is never touched: it is what gets sent back as `model`, and it also
 * keeps the full id searchable.
 */
function labelFor(value: string): string {
  const looksLikePath = /[\\/]/.test(value) && /[\\/]([^\\/]*\.(gguf|bin|safetensors)|sha256[-:])/i.test(value);
  if (!looksLikePath) return value;

  const base = value.split(/[\\/]/).pop() ?? value;
  const withoutExtension = base.replace(/\.(gguf|bin|safetensors)$/i, '');
  // A bare content hash says nothing either; keep enough to tell two apart.
  const shortened = withoutExtension.replace(/^(sha256[-:])([0-9a-f]{8})[0-9a-f]+$/i, '$2…');
  return shortened || base;
}

/** Convenience for the common case: a list of model ids with no extra entries. */
export function toChoices(values: string[]): PickerChoice[] {
  return values.map((value) => ({ name: labelFor(value), value }));
}
