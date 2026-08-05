import type { ToolDefinition } from '../providers/types.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file at the given path, creating it or overwriting it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write.' },
        content: { type: 'string', description: 'Content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return its output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['command'],
    },
  },
];
