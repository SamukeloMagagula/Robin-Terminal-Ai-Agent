import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeTool } from '../../src/tools/execute';
import type { ToolCall } from '../../src/providers/types';

function call(name: string, args: unknown): ToolCall {
  return { id: 'call_1', name, arguments: JSON.stringify(args) };
}

const approve = async () => true;
const decline = async () => false;

let tmp: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robin-exec-')));
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('tool argument validation', () => {
  it('rejects write_file with no content instead of throwing', async () => {
    const result = await executeTool(call('write_file', { path: 'x.txt' }), approve);
    expect(result).toBe('Error: missing or non-string "content" argument');
  });

  it('rejects a non-string path', async () => {
    const result = await executeTool(call('read_file', { path: 42 }), approve);
    expect(result).toBe('Error: missing or non-string "path" argument');
  });

  it('rejects run_command with no command', async () => {
    const result = await executeTool(call('run_command', {}), approve);
    expect(result).toBe('Error: missing or non-string "command" argument');
  });

  it('rejects arguments that are not a JSON object', async () => {
    const result = await executeTool({ id: 'c', name: 'read_file', arguments: '["x"]' }, approve);
    expect(result).toBe('Error: tool arguments must be a JSON object.');
  });
});

describe('read_file confirmation', () => {
  it('reads inside the working directory without asking', async () => {
    process.chdir(tmp);
    await fs.writeFile(path.join(tmp, 'inside.txt'), 'hello');
    let asked = false;
    const result = await executeTool(call('read_file', { path: 'inside.txt' }), async () => {
      asked = true;
      return true;
    });
    expect(asked).toBe(false);
    expect(result).toContain('hello');
  });

  it('asks before reading outside the working directory', async () => {
    process.chdir(originalCwd);
    const outside = path.join(tmp, 'outside.txt');
    await fs.writeFile(outside, 'secret-ish');
    let asked = false;
    const result = await executeTool(call('read_file', { path: outside }), async () => {
      asked = true;
      return true;
    });
    expect(asked).toBe(true);
    expect(result).toContain('secret-ish');
  });

  it('does not read when an outside read is declined', async () => {
    process.chdir(originalCwd);
    const outside = path.join(tmp, 'outside.txt');
    await fs.writeFile(outside, 'secret-ish');
    const result = await executeTool(call('read_file', { path: outside }), decline);
    expect(result).toContain('declined by the user');
    expect(result).not.toContain('secret-ish');
  });

  it('refuses a sensitive basename even inside the working directory', async () => {
    process.chdir(tmp);
    await fs.writeFile(path.join(tmp, '.env'), 'API_KEY=zzz');
    const result = await executeTool(call('read_file', { path: '.env' }), approve);
    expect(result).toContain('refused to read a protected credential file');
    expect(result).not.toContain('zzz');
  });
});

describe('read-only auto-approval', () => {
  it('runs a read-only command without confirming, and reports it', async () => {
    let asked = false;
    const announced: string[] = [];
    const result = await executeTool(
      call('run_command', { command: 'node --version' }),
      async () => {
        asked = true;
        return true;
      },
      { onAutoApproved: (c) => announced.push(c) }
    );
    expect(asked).toBe(false);
    expect(announced).toEqual(['node --version']);
    expect(result).toContain('Exit code: 0');
  }, 15_000);

  it('still confirms a command that is not read-only', async () => {
    let asked = false;
    const result = await executeTool(
      call('run_command', { command: 'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"' }),
      async () => {
        asked = true;
        return false;
      }
    );
    expect(asked).toBe(true);
    expect(result).toContain('declined by the user');
  });

  it('does not auto-approve a read-only head with a chained command', async () => {
    let asked = false;
    await executeTool(call('run_command', { command: 'ls && rm -rf /tmp/nope' }), async () => {
      asked = true;
      return false;
    });
    expect(asked).toBe(true);
  });
});

describe('run_command timeout', () => {
  it('kills a command that never returns and reports the timeout', async () => {
    const result = await executeTool(
      call('run_command', { command: 'node -e "setTimeout(()=>{},60000)"' }),
      approve,
      { commandTimeoutMs: 500 }
    );
    expect(result).toContain('timed out after 0.5s');
  }, 15_000);

  it('leaves a fast command unaffected', async () => {
    const result = await executeTool(
      call('run_command', { command: 'node -e "console.log(42)"' }),
      approve,
      { commandTimeoutMs: 10_000 }
    );
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('42');
  }, 15_000);
});
