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
];

/** The skills block for the system prompt: descriptions only, never bodies. */
export function composeSkillContext(index: string): string | undefined {
  if (!index.trim()) return undefined;
  return `Available skills (load one with \`use_skill\` when it fits the task):\n${index.trim()}`;
}
