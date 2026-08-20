import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { robinHome } from './profile.js';

export type AuthData = Record<string, Record<string, unknown>>;

export function defaultAuthPath(): string {
  return path.join(robinHome(), 'auth.json');
}

export class AuthStore {
  constructor(private readonly filePath: string = defaultAuthPath()) {}

  async read(): Promise<AuthData> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as AuthData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  async get(providerId: string): Promise<Record<string, unknown> | undefined> {
    const data = await this.read();
    return data[providerId];
  }

  async set(providerId: string, value: Record<string, unknown>): Promise<void> {
    const data = await this.read();
    data[providerId] = value;
    await this.write(data);
  }

  async delete(providerId: string): Promise<void> {
    const data = await this.read();
    delete data[providerId];
    await this.write(data);
  }

  private async write(data: AuthData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    // writeFile's `mode` only applies when it creates the file. An auth.json
    // that already exists with looser permissions would silently keep them,
    // so tighten it explicitly on every write.
    if (process.platform !== 'win32') {
      await fs.chmod(this.filePath, 0o600);
    }
  }
}
