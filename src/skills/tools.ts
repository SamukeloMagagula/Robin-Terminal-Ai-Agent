import type { ToolDefinition } from '../providers/types.js';

export const SKILL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'use_skill',
    description:
      'Load the full instructions for a skill listed in the skills index. The index ' +
      'carries only one-line descriptions; read a skill when its line matches the task.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name, as shown in the index.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_skill',
    description:
      'Save a reusable instruction set learned from completing a task, so future ' +
      'sessions can apply it. Use this for a repeatable procedure worth keeping — not ' +
      'for one-off facts, which belong in `remember`. The user is asked before it is saved.\n' +
      'Call this at most once per reply, and only after finishing work that a later ' +
      'session would genuinely repeat. Do not propose a skill for a question you just ' +
      'answered, for a command you just ran, or because a topic came up: every call ' +
      'interrupts the user with a prompt, and a stream of them teaches them to stop ' +
      'reading the prompts that matter.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case slug, e.g. "release-checklist".' },
        description: {
          type: 'string',
          description: 'One line saying when to reach for this skill. Shown in the index.',
        },
        body: { type: 'string', description: 'The instructions, in markdown.' },
      },
      required: ['name', 'description', 'body'],
    },
  },
];

/** The skills block for the system prompt: descriptions only, never bodies. */
export function composeSkillContext(index: string): string | undefined {
  if (!index.trim()) return undefined;
  return `Available skills (load one with \`use_skill\` when it fits the task):\n${index.trim()}`;
}
