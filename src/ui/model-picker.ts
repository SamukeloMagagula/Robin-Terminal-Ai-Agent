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

/** Convenience for the common case: a list of model ids with no extra entries. */
export function toChoices(values: string[]): PickerChoice[] {
  return values.map((value) => ({ name: value, value }));
}
