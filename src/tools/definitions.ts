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
    name: 'edit_file',
    description:
      'Replace an exact string in an existing file. Prefer this over write_file for ' +
      'any change to a file that already exists: write_file replaces the whole thing, ' +
      'so it costs the entire file in tokens and silently loses anything you did not ' +
      'reproduce. old_string must match the file exactly, including indentation, and ' +
      'must appear exactly once — include surrounding lines to make it unique, or pass ' +
      'replace_all. The user is asked before it is saved.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit.' },
        old_string: {
          type: 'string',
          description: 'The exact text to replace, including indentation.',
        },
        new_string: { type: 'string', description: 'What to put in its place.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring exactly one.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
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
