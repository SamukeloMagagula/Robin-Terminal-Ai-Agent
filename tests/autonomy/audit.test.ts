import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { AuditLog, type AuditEntry } from '../../src/autonomy/audit';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'robin-audit-'));
}

const entry = (decision: AuditEntry['decision'], detail: string): AuditEntry => ({
  ts: '2026-08-17T03:00:04Z',
  manifest: 'nightly-backup',
  kind: 'run_command',
  detail,
  decision,
  rule: decision === 'allowed' ? 'git *' : null,
});

describe('AuditLog', () => {
  it('records both allowed and refused decisions', async () => {
    const log = new AuditLog(await tempDir());

    await log.append(entry('allowed', 'git push origin main'));
    await log.append(entry('refused', 'restic snapshot'));

    const read = await log.read('nightly-backup');
    expect(read.map((e) => e.decision)).toEqual(['allowed', 'refused']);
    expect(read[0].rule).toBe('git *');
    expect(read[1].detail).toBe('restic snapshot');
    expect(read[1].rule).toBeNull();
  });

  it('appends rather than rewriting', async () => {
    const dir = await tempDir();
    const log = new AuditLog(dir);
    await log.append(entry('allowed', 'a'));
    await log.append(entry('allowed', 'b'));

    const raw = await fs.readFile(path.join(dir, 'nightly-backup.jsonl'), 'utf-8');
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
  });

  it('returns the error rather than throwing when the directory is a file', async () => {
    const dir = await tempDir();
    const blocked = path.join(dir, 'blocked');
    // A regular file where the log directory should be: mkdir must fail.
    await fs.writeFile(blocked, '');

    const result = await new AuditLog(blocked).append(entry('allowed', 'a'));

    expect(result).toBeInstanceOf(Error);
  });

  it('skips unparseable lines rather than failing the whole read', async () => {
    const dir = await tempDir();
    const log = new AuditLog(dir);
    await log.append(entry('allowed', 'a'));
    await fs.appendFile(path.join(dir, 'nightly-backup.jsonl'), 'not json\n');
    await log.append(entry('refused', 'b'));

    expect(await log.read('nightly-backup')).toHaveLength(2);
  });

  it('returns nothing for a manifest with no log', async () => {
    expect(await new AuditLog(await tempDir()).read('never-run')).toEqual([]);
  });

  it('keeps separate manifests in separate files', async () => {
    const dir = await tempDir();
    const log = new AuditLog(dir);
    await log.append(entry('allowed', 'a'));
    await log.append({ ...entry('allowed', 'b'), manifest: 'other' });

    expect(await log.read('nightly-backup')).toHaveLength(1);
    expect(await log.read('other')).toHaveLength(1);
  });

  it('refuses to let a manifest id escape the directory', async () => {
    const dir = await tempDir();
    const log = new AuditLog(dir);

    await log.append({ ...entry('allowed', 'a'), manifest: '../escape' });

    await expect(fs.access(path.join(path.dirname(dir), 'escape.jsonl'))).rejects.toThrow();
    // It landed inside the audit directory under a flattened name instead.
    expect(await fs.readdir(dir)).toEqual(['_.._escape.jsonl']);
  });

  it('cannot be made to write a dotfile', async () => {
    const dir = await tempDir();
    await new AuditLog(dir).append({ ...entry('allowed', 'a'), manifest: '.hidden' });

    expect(await fs.readdir(dir)).toEqual(['_.hidden.jsonl']);
  });

  it('reads back what a sanitised id wrote', async () => {
    const dir = await tempDir();
    const log = new AuditLog(dir);
    await log.append({ ...entry('allowed', 'a'), manifest: 'weird/name' });

    expect(await log.read('weird/name')).toHaveLength(1);
  });
});
