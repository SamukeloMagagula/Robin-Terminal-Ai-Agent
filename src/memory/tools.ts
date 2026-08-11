import type { ToolDefinition } from '../providers/types.js';

/**
 * The nudge that makes agent-curated memory actually accumulate.
 *
 * Without it the model has a tool it rarely thinks to use — it answers the
 * question in front of it and never steps back. Sent on every Nth turn of the
 * session rather than every turn, so it costs almost nothing.
 */
export const MEMORY_NUDGE =
  'Consider whether anything established in this conversation is worth persisting ' +
  'with the `remember` tool — a stable preference, a project constraint, or a ' +
  'correction the user made. Skip it if nothing qualifies; do not narrate the check.';

/** Turns between nudges, counted within one session. */
export const NUDGE_EVERY = 10;

export const MEMORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'remember',
    description:
      'Persist something worth knowing in future sessions: a stable user preference, ' +
      'a project constraint, or a correction. Reuse an existing name to update it rather ' +
      'than creating a near-duplicate. Never store credentials, tokens, or key material. ' +
      'Do not store what the repository or the conversation already records.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short kebab-case slug, e.g. "prefers-tabs". Reuse to update.',
        },
        description: {
          type: 'string',
          description: 'One line, shown in the index. This is what future sessions see first.',
        },
        type: {
          type: 'string',
          enum: ['user', 'project', 'reference'],
          description:
            'user: who they are and how they work. project: ongoing work or constraints. ' +
            'reference: pointers to external resources.',
        },
        body: { type: 'string', description: 'The memory itself, in markdown.' },
      },
      required: ['name', 'description', 'type', 'body'],
    },
  },
  {
    name: 'recall_memory',
    description:
      'Read the full text of a memory listed in the index. The index carries only ' +
      'one-line descriptions; use this when a line looks relevant to the task.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The memory name, as shown in the index.' },
      },
      required: ['name'],
    },
  },
];

/**
 * The memory block for the system prompt: the profile in full, plus one line
 * per memory. Bodies are deliberately absent — they arrive via `recall_memory`
 * when a line looks relevant, so the per-turn cost stays flat as memory grows.
 */
export function composeMemoryContext(profile: string | undefined, index: string): string | undefined {
  const sections: string[] = [];
  if (profile?.trim()) sections.push(`What you know about this user:\n${profile.trim()}`);
  if (index.trim()) {
    sections.push(
      `Stored memories (read one with \`recall_memory\` when relevant):\n${index.trim()}`
    );
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}
