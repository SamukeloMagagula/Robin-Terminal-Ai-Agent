import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type AuthData = Record<string, Record<string, unknown>>;

export function defaultAuthPath(): string {
  return path.join(os.homedir(), '.robin', 'auth.json');
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
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
