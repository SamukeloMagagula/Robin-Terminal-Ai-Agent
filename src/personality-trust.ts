import * as path from 'node:path';
import { TrustStore, defaultTrustPath, hashContent } from './trust-store.js';

export { defaultTrustPath, hashContent };

/**
 * Which PERSONALITY.md files the user has agreed to load.
 *
 * A thin wrapper over the shared TrustStore, which MCP server entries also
 * use. The two are the same problem — approving something that becomes
 * capability — and one store means one file, one permission model, and one
 * fails-closed path rather than two copies that drift.
 *
 * Paths are resolved here so the same file approved via a relative and an
 * absolute path is one grant, not two.
 */
export class PersonalityTrustStore {
  private readonly store: TrustStore;

  constructor(filePath: string = defaultTrustPath()) {
    this.store = new TrustStore(filePath);
  }

  async isTrusted(filePath: string, content: string): Promise<boolean> {
    return this.store.isTrusted('personality', path.resolve(filePath), content);
  }

  /** Approve this exact text. Editing the file will ask again. */
  async trustContent(filePath: string, content: string): Promise<void> {
    await this.store.trustContent('personality', path.resolve(filePath), content);
  }

  /** Approve this location for good, whatever it comes to contain. */
  async trustPath(filePath: string): Promise<void> {
    await this.store.trustKey('personality', path.resolve(filePath));
  }
}
